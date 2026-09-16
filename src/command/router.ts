/**
 * Which parser answers, and what happens when the model does not.
 *
 * THE ABSOLUTE REQUIREMENT (§E): with no interpreter declared, Apsis behaves
 * *identically* to today. Not approximately. `resolveCommand` returns the
 * grammar's answer SYNCHRONOUSLY in that case — it does not create a promise,
 * schedule a microtask, start a timer or touch the network — so the disabled
 * path cannot reorder anything relative to the code that shipped before this
 * milestone. `CommandBar` checks for a promise before awaiting for the same
 * reason: an `await` on a plain value still splits one render into two.
 *
 * THE FALLBACK RULE (§I): the grammar is always a correct answer, so no failure
 * mode may leave the user unable to run commands. Every way the interpreter can
 * let us down — offline, CORS, non-2xx, timeout, malformed JSON, a broken
 * envelope, a refusal, an answer where every filter was rejected — lands on the
 * grammar's result plus one honest line saying which parser ran. There is no
 * error state, no modal and no disabled control anywhere in this file.
 *
 * THE STALENESS RULE (§J): a slow first command must never overwrite a fast
 * second one. `createCommandRunner` owns a monotonic generation counter and an
 * `AbortController`; a response whose generation is no longer current is
 * discarded rather than applied. This is the same class of bug that made
 * persistence silently write nothing earlier in this project, and it is cheaper
 * to forbid structurally than to notice later.
 */

import { parseCommand, type ParsedCommand } from '../domain/query';
import {
  InterpreterTimeoutError,
  InterpreterUnavailableError,
  createHostInterpreter,
  readInterpreterConfig,
  type CommandInterpreter,
} from './interpreter';
import { parseInterpretation } from './parseInterpretation';

export type CommandSource = 'grammar' | 'interpreter';

/**
 * What the endpoint's answer implies about the SESSION, as distinct from the
 * command.
 *
 * These are three genuinely different situations and conflating them misleads
 * the user: `signed-out` means sign in; `forbidden` means you ARE signed in and
 * this account cannot use the interpreter, so telling them to sign in would
 * send them round a loop that changes nothing; `unavailable` means we could not
 * tell, and must not be reported as a logout at all.
 */
export type AuthSignal = 'signed-out' | 'forbidden' | 'unavailable';

export interface CommandOutcome {
  /** The canonical result. Downstream code cannot tell which parser produced it. */
  parsed: ParsedCommand;
  source: CommandSource;
  /** One muted line, set only when an interpreter existed and did not answer usefully. */
  note: string | null;
  /** Set only when the endpoint said something about the session. */
  authSignal?: AuthSignal;
}

const PREFIX = 'Interpreted with the built-in grammar — ';
export const NOTE_UNAVAILABLE = `${PREFIX}the language model was unavailable.`;
export const NOTE_TIMEOUT = `${PREFIX}the language model did not answer in time.`;
export const NOTE_UNUSABLE = `${PREFIX}the language model returned an answer Apsis could not use.`;
/** 401. The command still ran; the user simply is not signed in. */
export const NOTE_SIGN_IN = `${PREFIX}sign in to use the language model.`;
/**
 * 403. The user IS signed in — telling them to sign in would send them around a
 * loop that cannot fix anything. This account simply lacks the capability.
 */
export const NOTE_NO_ACCESS = `${PREFIX}AI interpretation is not available for this account.`;
/**
 * 503. Deliberately NOT phrased as a logout: the session is intact and the
 * sign-in service was momentarily unreachable. Telling the user they are signed
 * out here would be both wrong and alarming (D40).
 */
export const NOTE_AUTH_UNAVAILABLE = `${PREFIX}sign-in is temporarily unavailable.`;

export interface ResolveOptions {
  /** Cancellation from the caller. Never used for timeouts — see interpreter.ts. */
  signal?: AbortSignal;
  /**
   * Explicit interpreter, or `null` for "there is none".
   * Omitted entirely means "ask the host", which is the production path.
   */
  interpreter?: CommandInterpreter | null;
}

const grammarOutcome = (
  text: string,
  note: string | null = null,
  authSignal?: AuthSignal,
): CommandOutcome => ({
  parsed: parseCommand(text),
  source: 'grammar',
  note,
  ...(authSignal ? { authSignal } : {}),
});

/** The host's interpreter, or null. Read per call so a host may declare one late. */
function hostInterpreter(): CommandInterpreter | null {
  const config = readInterpreterConfig();
  return config ? createHostInterpreter(config) : null;
}

/**
 * Resolve a command to a `ParsedCommand`.
 *
 * Returns synchronously when no interpreter exists. The union return type is
 * not an accident of style — it is what makes "identical without a key"
 * something a test can assert rather than something a comment can claim.
 */
export function resolveCommand(
  text: string,
  options: ResolveOptions = {},
): CommandOutcome | Promise<CommandOutcome> {
  const interpreter =
    options.interpreter !== undefined ? options.interpreter : hostInterpreter();

  if (!interpreter) return grammarOutcome(text);

  return interpretThenFallBack(text, interpreter, options.signal);
}

async function interpretThenFallBack(
  text: string,
  interpreter: CommandInterpreter,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const controller = signal ? null : new AbortController();
  const effective = signal ?? controller!.signal;

  try {
    const raw = await interpreter.interpret(text, effective);
    const parsed = parseInterpretation(raw, text);

    // Nothing survived validation. `understood` is empty exactly when no filter
    // and no action was applied, so this is the single place that decides
    // "usable", rather than every caller re-deriving it.
    if (parsed.understood.length === 0) return grammarOutcome(text, NOTE_UNUSABLE);

    return { parsed, source: 'interpreter', note: null };
  } catch (error) {
    // A cancellation is the user's decision, not a failure to recover from.
    // Rethrow so the runner can drop it; falling back here would race a newer
    // command's result onto the screen.
    if (effective.aborted) throw error;
    if (error instanceof InterpreterTimeoutError) return grammarOutcome(text, NOTE_TIMEOUT);
    if (error instanceof InterpreterUnavailableError) {
      // Three different things, three different messages, three different
      // consequences for the session UI.
      if (error.status === 401) return grammarOutcome(text, NOTE_SIGN_IN, 'signed-out');
      if (error.status === 403) return grammarOutcome(text, NOTE_NO_ACCESS, 'forbidden');
      if (error.status === 503) {
        return grammarOutcome(text, NOTE_AUTH_UNAVAILABLE, 'unavailable');
      }
      return grammarOutcome(text, NOTE_UNAVAILABLE);
    }
    if (error instanceof SyntaxError) return grammarOutcome(text, NOTE_UNUSABLE);
    if (error instanceof Error && error.name === 'InterpretationFormatError') {
      return grammarOutcome(text, NOTE_UNUSABLE);
    }
    return grammarOutcome(text, NOTE_UNAVAILABLE);
  }
}

/* ------------------------------------------------------------- the runner --- */

export interface CommandRunner {
  /**
   * Resolve one submission.
   *
   * `null` means "this submission no longer owns the screen": it was superseded
   * by a newer command, cancelled, or was a duplicate of one already in flight.
   * Synchronous whenever `resolveCommand` is.
   */
  run(text: string): CommandOutcome | null | Promise<CommandOutcome | null>;
  /** Abandon anything in flight. */
  cancel(): void;
}

export function createCommandRunner(options: ResolveOptions = {}): CommandRunner {
  let generation = 0;
  let inFlight: { text: string; controller: AbortController } | null = null;

  return {
    run(text: string) {
      // A duplicate submit of the text already being worked on is ignored
      // rather than started twice — two identical requests can only disagree.
      if (inFlight && inFlight.text === text) return null;

      inFlight?.controller.abort();
      const controller = new AbortController();
      const mine = ++generation;

      const resolved = resolveCommand(text, { ...options, signal: controller.signal });

      if (!(resolved instanceof Promise)) {
        // The disabled path. No bookkeeping to unwind, no way to be stale.
        inFlight = null;
        return resolved;
      }

      inFlight = { text, controller };
      return resolved
        .then((outcome) => (mine === generation ? outcome : null))
        // The last safety net. A superseded or cancelled command resolves to
        // null; anything else that could possibly throw still has to leave the
        // user with a usable answer rather than a command bar stuck on
        // "Running…", so it lands on the grammar like every other failure.
        .catch(() => (mine === generation ? grammarOutcome(text, NOTE_UNAVAILABLE) : null))
        .finally(() => {
          if (mine === generation) inFlight = null;
        });
    },

    cancel() {
      generation++;
      inFlight?.controller.abort();
      inFlight = null;
    },
  };
}
