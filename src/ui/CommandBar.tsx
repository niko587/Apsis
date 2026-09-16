/**
 * The command interface.
 *
 * §13 asks for: parse → show what Apsis understood → identify affected leads →
 * execute → stream progress → show the result. That is the shape below.
 *
 * The readout shows both halves of the parse — what was understood AND what was
 * not. A command whose key clause was silently dropped returns a confident,
 * wrong answer, and nothing on screen would tell you.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeCommand,
  isEmptyQuery,
  runQuery,
  type CommandAction,
  type FunnelStep,
} from '../domain/query';
import { createCommandRunner, type AuthSignal } from '../command/router';
import { readInterpreterConfig } from '../command/interpreter';
import type { LeadEventKind } from '../domain/types';
import { useApsis } from '../state/store';

const EXAMPLES = [
  "find all cold family leads in Tampa that haven't been contacted in 14+ days, start the reactivation sequence",
  'find hot medicare leads in Orlando, call them',
  'show qualified leads with score above 80, top 25',
];

/** What each action actually does to a lead. */
const ACTION_EMITS: Record<Exclude<CommandAction, 'none'>, LeadEventKind> = {
  reactivate: 'contacted',
  call: 'call_connected',
  book: 'appointment_offered',
};

interface Outcome {
  understood: string[];
  unrecognised: string[];
  funnel: FunnelStep[];
  matched: number;
  action: CommandAction;
  dispatched: number | null;
  /** Set when the command produced nothing actionable. */
  note: string | null;
  /**
   * Set only when an interpreter was configured and did not answer usefully.
   * A separate field from `note`: one is about the RESULT, the other about
   * which parser produced it, and collapsing them would make a fallback look
   * like a failed query.
   */
  interpreterNote: string | null;
}

/**
 * The four states the session UI can be in.
 *
 * `unknown` and `unavailable` are both "we cannot say", and both render
 * something other than a sign-in link — because claiming a user is signed OUT
 * when the sign-in service merely timed out is a lie that throws away a
 * perfectly good session and invites them to re-authenticate for nothing.
 */
type SessionState = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

/**
 * v1 gates the INTERPRETER, not the application.
 *
 * So this hook does nothing at all unless a host has declared an interpreter —
 * with none declared the default build asks nothing, renders nothing new, and
 * still makes zero network requests, which the browser suite asserts. Gating
 * the whole app would protect nothing that needs protecting today (the book is
 * seeded client-side) while breaking the "no credential needed to work on
 * Apsis" promise. That changes the day real customer data is served from the
 * server, and not before.
 */
function useSession(): {
  state: SessionState;
  gated: boolean;
  applySignal: (signal: AuthSignal) => void;
} {
  const gated = useMemo(() => readInterpreterConfig() !== null, []);
  const [state, setState] = useState<SessionState>('unknown');

  useEffect(() => {
    if (!gated) return;
    let live = true;
    void fetch('/api/session', { credentials: 'same-origin' })
      .then(async (r) => {
        // 503 is the server saying "I could not check", which is NOT a logout.
        if (r.status === 503) return 'unavailable' as const;
        if (!r.ok) return 'unavailable' as const;
        const body = (await r.json()) as { authenticated?: boolean };
        return body.authenticated ? ('signed-in' as const) : ('signed-out' as const);
      })
      // A session endpoint that cannot be reached is also "cannot say". The
      // grammar still works either way, so there is nothing to gain by
      // guessing, and a wrong guess of "signed out" is the harmful one.
      .catch(() => 'unavailable' as const)
      .then((next) => {
        if (live) setState(next);
      });
    return () => {
      live = false;
    };
  }, [gated]);

  /**
   * Fold what a command's outcome revealed into the session state.
   *
   * `forbidden` deliberately changes NOTHING: a 403 means the session is valid
   * and this account lacks the capability, so replacing sign-out with sign-in
   * would be both wrong and useless. `unavailable` preserves a known signed-in
   * state for the same reason — a provider blip is not a logout.
   */
  const applySignal = useCallback((signal: AuthSignal) => {
    setState((current) => {
      if (signal === 'signed-out') return 'signed-out';
      if (signal === 'forbidden') return current === 'unknown' ? 'signed-in' : current;
      return current === 'signed-in' ? 'signed-in' : 'unavailable';
    });
  }, []);

  return { state, gated, applySignal };
}

export function CommandBar() {
  const [input, setInput] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);

  const setMatched = useApsis((s) => s.setMatched);
  const requestWork = useApsis((s) => s.requestWork);
  const setFocus = useApsis((s) => s.setFocus);

  const placeholder = useMemo(() => EXAMPLES[0], []);
  const { state: sessionState, gated, applySignal } = useSession();

  /**
   * Owns the abort controller and the generation counter (§J). One per mounted
   * command bar, so a second submit cancels the first rather than racing it.
   */
  const runner = useMemo(() => createCommandRunner(), []);

  const run = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setRunning(true);

      /**
       * The only change to this function.
       *
       * `pending` is a plain value whenever no interpreter is configured, and
       * the `await` is skipped in that case ON PURPOSE: awaiting a non-promise
       * still defers a turn, which would split what is currently one React
       * render into two and make the default path observably different from the
       * one that shipped. With no interpreter this stays a single synchronous
       * block, exactly as before.
       */
      const pending = runner.run(text);
      const resolved = pending instanceof Promise ? await pending : pending;

      // Superseded by a newer command, cancelled, or a duplicate of one already
      // in flight. The submission that owns the screen will clear `running`.
      if (resolved === null) return;

      const { parsed, note: interpreterNote } = resolved;
      // What the endpoint revealed about the session, if anything.
      if (resolved.authSignal) applySignal(resolved.authSignal);
      const { query, action, understood, unrecognised } = parsed;

      if (isEmptyQuery(query)) {
        setMatched(null);
        setFocus(null);
        setOutcome({
          understood,
          unrecognised,
          funnel: [],
          matched: 0,
          action,
          dispatched: null,
          note: 'No filter recognised — nothing to run. Name a stage, segment, city, recency or score.',
          interpreterNote,
        });
        setRunning(false);
        return;
      }

      const { leads } = useApsis.getState();
      const { leadIds, funnel } = runQuery(query, leads.values(), Date.now());
      setMatched(leadIds);
      // Describe what was UNDERSTOOD, not what was typed — see describeCommand.
      setFocus(leadIds.length > 0 ? describeCommand(parsed) : null);

      let dispatched: number | null = null;
      if (action !== 'none' && leadIds.length > 0) {
        const kind = ACTION_EMITS[action];
        let n = 0;
        // Dispatch is real: each of these opens an AgentTask that occupies an
        // agent, draws an arc, and resolves into an event that moves the lead.
        for (const id of leadIds) {
          if (requestWork(id, kind)) n++;
        }
        dispatched = n;
      }

      setOutcome({
        understood,
        unrecognised,
        funnel,
        matched: leadIds.length,
        action,
        dispatched,
        note:
          leadIds.length === 0
            ? 'No leads match. Try relaxing a clause.'
            : action !== 'none' && dispatched === 0
              ? 'Every matched lead is already being worked by an agent.'
              : null,
        interpreterNote,
      });
      setRunning(false);
    },
    [requestWork, setMatched, setFocus, runner, applySignal],
  );

  const clear = () => {
    runner.cancel();
    setRunning(false);
    setOutcome(null);
    setMatched(null);
    setFocus(null);
    setInput('');
  };

  return (
    <div className="command">
      <form
        className="command-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
      >
        <span className="command-mark" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          aria-label="Command Apsis"
          spellCheck={false}
        />
        {outcome && (
          <button type="button" className="command-clear" onClick={clear}>
            clear
          </button>
        )}
        <button type="submit" className="command-send" disabled={running || !input.trim()}>
          {running ? 'Running…' : 'Run'}
        </button>
      </form>

      {/* Restrained on purpose: the command bar works signed out, so this is an
          offer rather than a wall. Rendered only when a host has configured an
          interpreter — otherwise there is nothing to sign in FOR. */}
      {/* A div, not a p: the sign-out control is a <form>, which is flow content
          and is not permitted inside a paragraph — the browser would silently
          close the <p> early and the layout would come apart. */}
      {gated && sessionState !== 'unknown' && (
        <div className="command-auth muted">
          {sessionState === 'signed-in' && (
            <>
              AI interpretation enabled ·{' '}
              {/* A FORM, not a link: logout mutates, so it is a same-origin
                  POST. A GET that clears a session can be fired by any
                  `<img src>` on any page, and SameSite=Lax would happily
                  attach the cookie to it. The button is a real submit, so it
                  stays keyboard-reachable. */}
              <form method="post" action="/api/auth/logout" className="command-auth-form">
                <button type="submit" className="linklike" data-auth-signout>
                  sign out
                </button>
              </form>
            </>
          )}
          {sessionState === 'signed-out' && (
            <a
              href={`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}
              data-auth-signin
            >
              Sign in to use AI interpretation
            </a>
          )}
          {sessionState === 'unavailable' && (
            // Not "signed out" — we genuinely do not know, and saying so is
            // better than inviting a pointless re-authentication.
            <span data-auth-unavailable>Sign-in is temporarily unavailable.</span>
          )}
        </div>
      )}

      {outcome && (
        <div className="command-out">
          <div className="understood">
            {outcome.understood.length > 0 ? (
              outcome.understood.map((u) => (
                <span key={u} className="chip">
                  {u}
                </span>
              ))
            ) : (
              <span className="chip chip-none">nothing recognised</span>
            )}
            {outcome.unrecognised.map((u) => (
              <span key={u} className="chip chip-unknown" title="Apsis ignored this">
                ignored: {u}
              </span>
            ))}
          </div>

          {outcome.funnel.length > 0 && (
            <ol className="funnel">
              {outcome.funnel.map((f, i) => (
                <li key={`${f.label}-${i}`}>
                  <span className="funnel-n">{f.remaining.toLocaleString()}</span>
                  <span className="funnel-l">{f.label}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="command-result">
            {outcome.note ? (
              <span className="muted">{outcome.note}</span>
            ) : (
              <>
                <strong>{outcome.matched.toLocaleString()}</strong> leads matched
                {outcome.dispatched !== null && (
                  <>
                    {' · '}
                    <strong className="accent-text">{outcome.dispatched}</strong> agent
                    {outcome.dispatched === 1 ? '' : 's'} dispatched
                  </>
                )}
              </>
            )}
          </div>

          {/* Which parser answered, and only when that is not the obvious one.
              Never a modal, never an error state: the results above are real
              and usable, and this says where they came from. */}
          {outcome.interpreterNote && (
            <p className="command-note muted" data-interpreter-note>
              {outcome.interpreterNote}
            </p>
          )}
        </div>
      )}

      {!outcome && (
        <div className="command-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setInput(ex); void run(ex); }}>
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
