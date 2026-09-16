/**
 * Validation of an interpreter's answer INTO the canonical `ParsedCommand`.
 *
 * This file is the safety boundary of the whole milestone, which is why §R of
 * the contract says to build it before anything can call a model. Everything it
 * receives is untrusted: a language model's output is a suggestion, not data.
 *
 * Three rules, in order of how badly they fail if you skip them:
 *
 * 1. **A field that is not in `LeadQuery` cannot be introduced.** The allowed
 *    keys are a closed set checked against a `Set`, so `leads`, `__proto__` or
 *    any invention lands in the same bucket as a typo: rejected.
 *
 * 2. **A value outside the closed vocabulary cannot be introduced.** Stages are
 *    checked against `STAGE_ORDER`, segments against the book's segment list,
 *    cities against `CITY_NAMES`, states against `STATE_NAMES`, numbers for
 *    finiteness and range. A stage of `"frustrated"` is dropped.
 *
 * 3. **Nothing is applied that the model cannot point at in the user's own
 *    words.** Every filter must cite a `span`, and that span must appear
 *    verbatim in the input. A citation that is not there is a hallucination,
 *    and the filter dies with it. The same rule governs the action — an action
 *    with no verifiable span is not applied, because "provenance, except for
 *    verbs" is not a rule anyone can rely on.
 *
 * And the honesty property, which is the point of the milestone (§H): what the
 * user typed and Apsis did NOT act on is computed by SUBTRACTION, exactly the
 * way `parseCommand` computes it. Accepted spans are blanked out of a working
 * copy of the input and whatever survives is the residue. The model's own
 * account of what it missed is never the source of truth — a model that
 * silently drops a clause and reports nothing would otherwise go unnoticed,
 * which is the failure §13 exists to prevent.
 *
 * Pure: no network, no clock, no store, no React. `parseCommand` is imported as
 * an oracle (see `isFiller`) and is never modified.
 */

import {
  parseCommand,
  type CommandAction,
  type LeadQuery,
  type ParsedCommand,
} from '../domain/query';
import { STAGES, STAGE_ORDER, type Stage } from '../domain/types';
import { CITY_NAMES, STATE_NAMES } from '../domain/geography';

/**
 * The only `LeadQuery` keys an interpreter may name.
 *
 * A closed set, not a `keyof` type: types vanish at runtime and this check has
 * to survive into the bundle, where the untrusted input actually arrives.
 */
export const INTERPRETABLE_FIELDS = [
  'stages',
  'segments',
  'locations',
  'states',
  'idleDaysMin',
  'scoreMin',
  'scoreMax',
  'limit',
] as const;

export type InterpretableField = (typeof INTERPRETABLE_FIELDS)[number];

const FIELD_SET: ReadonlySet<string> = new Set<string>(INTERPRETABLE_FIELDS);

const ACTIONS: ReadonlySet<string> = new Set<string>([
  'reactivate',
  'call',
  'book',
  'none',
]);

/**
 * The book's segments.
 *
 * Duplicated from `seed.ts` because `src/domain/**` is forbidden to this
 * milestone (§N) and the list is not exported. `parseInterpretation.test.ts`
 * pins it against a real seeded book in both directions, so a drift becomes a
 * failing test rather than a segment the interpreter can never name.
 */
export const SEGMENT_VOCABULARY: readonly string[] = [
  'Family Coverage',
  'Individual',
  'Medicare',
  'Small Business',
  'Self-Employed',
  'Supplemental',
  'Dental + Vision',
];

/** Bounds. Generous — these reject nonsense, they do not express taste. */
const MAX_IDLE_DAYS = 3650;
const MAX_LIMIT = 100_000;

/**
 * The static description sent to the host interpreter.
 *
 * Built from the SAME constants the validator checks against, so the vocabulary
 * the model is told about cannot drift from the vocabulary it is judged by.
 * Contains no lead data of any kind — see §L: closed vocabularies are schema,
 * not records.
 */
export const COMMAND_SCHEMA = {
  version: 1,
  fields: {
    stages: { type: 'enum[]', values: [...STAGE_ORDER] },
    segments: { type: 'enum[]', values: [...SEGMENT_VOCABULARY] },
    locations: { type: 'enum[]', values: [...CITY_NAMES], note: 'city names' },
    states: { type: 'enum[]', values: Object.keys(STATE_NAMES), note: 'two-letter codes' },
    idleDaysMin: { type: 'integer', min: 1, max: MAX_IDLE_DAYS },
    scoreMin: { type: 'number', min: 0, max: 100 },
    scoreMax: { type: 'number', min: 0, max: 100 },
    limit: { type: 'integer', min: 1, max: MAX_LIMIT },
  },
  actions: [...ACTIONS],
  response: {
    filters: [{ field: '<one of fields>', value: '<value or array>', span: '<exact substring of the input>' }],
    action: '<one of actions, optional>',
    actionSpan: '<exact substring of the input, REQUIRED to apply a non-none action>',
    unmapped: ['<text the model could not map, optional>'],
  },
  rules: [
    'Every filter must cite a span copied verbatim from the input.',
    'Never invent a field or a value outside the lists above.',
    'Anything you cannot map belongs in unmapped, not in a filter.',
  ],
} as const;

/* ------------------------------------------------------------- transport --- */

export interface InterpreterFilter {
  field: InterpretableField;
  value: unknown;
  /** The exact substring of the user's input this filter came from. */
  span: string;
}

export interface InterpreterResponse {
  filters: InterpreterFilter[];
  action?: CommandAction;
  /** Provenance for `action`. Without it the action is not applied. */
  actionSpan?: string;
  unmapped?: string[];
}

/**
 * A structurally unusable envelope.
 *
 * Mirrors `parseSession`'s discipline (D23): the SHAPE failing is fatal and the
 * caller falls back to the grammar, while an individual bad FILTER is dropped
 * and reported. Discarding a mostly-good interpretation because one clause was
 * wrong would lose work the user can see was understood.
 */
export class InterpretationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpretationFormatError';
  }
}

/* ------------------------------------------------------------ validation --- */

const emptyQuery = (): LeadQuery => ({
  stages: [],
  segments: [],
  locations: [],
  states: [],
  idleDaysMin: null,
  scoreMin: null,
  scoreMax: null,
  limit: null,
});

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
};

const inRange = (n: number | null, min: number, max: number, integer: boolean): number | null => {
  if (n === null || n < min || n > max) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
};

/** Case-insensitive lookup that returns the CANONICAL spelling, never the model's. */
const canonical = (v: unknown, vocabulary: readonly string[]): string | null => {
  if (typeof v !== 'string') return null;
  const needle = v.trim().toLowerCase();
  return vocabulary.find((c) => c.toLowerCase() === needle) ?? null;
};

const canonicalState = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const code = v.trim().toUpperCase();
  return STATE_NAMES[code] ? code : null;
};

/**
 * Filler detection, delegated to the grammar rather than duplicated.
 *
 * The residue must be filtered by the SAME stop-word list `parseCommand` uses,
 * and that list is private to `src/domain/query.ts`, which this milestone may
 * not modify (§N). Copying forty words here would drift silently.
 *
 * So the oracle is asked directly: a word is filler only if `parseCommand`
 * neither recognises it nor reports it — which is exactly what being a stop
 * word means. A word the grammar KNOWS ("tampa") is deliberately not filler: if
 * the interpreter failed to map a term the domain understands, saying so is the
 * whole point.
 */
const fillerCache = new Map<string, boolean>();
const isFiller = (word: string): boolean => {
  const cached = fillerCache.get(word);
  if (cached !== undefined) return cached;
  const probe = parseCommand(word);
  const filler =
    probe.understood.length === 0 &&
    probe.unrecognised.length === 0 &&
    probe.action === 'none';
  fillerCache.set(word, filler);
  return filler;
};

/** Grammar order, so both paths read identically in the UI. */
const UNDERSTOOD_ORDER: InterpretableField[] = [
  'idleDaysMin',
  'scoreMin',
  'scoreMax',
  'limit',
  'stages',
  'segments',
  'locations',
  'states',
];

function readEnvelope(raw: unknown): InterpreterResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InterpretationFormatError('interpretation must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.filters)) {
    throw new InterpretationFormatError('interpretation.filters must be an array');
  }
  if (r.action !== undefined && (typeof r.action !== 'string' || !ACTIONS.has(r.action))) {
    throw new InterpretationFormatError(`unknown action: ${String(r.action)}`);
  }
  if (r.actionSpan !== undefined && typeof r.actionSpan !== 'string') {
    throw new InterpretationFormatError('interpretation.actionSpan must be a string');
  }
  if (r.unmapped !== undefined && !Array.isArray(r.unmapped)) {
    throw new InterpretationFormatError('interpretation.unmapped must be an array');
  }
  return {
    filters: r.filters as InterpreterFilter[],
    action: r.action as CommandAction | undefined,
    actionSpan: r.actionSpan as string | undefined,
    unmapped: r.unmapped as string[] | undefined,
  };
}

/**
 * Validate an interpreter's answer into a `ParsedCommand`.
 *
 * Throws `InterpretationFormatError` only when the ENVELOPE is unusable. A
 * response whose every filter is rejected returns normally with an empty query
 * and an empty `understood` — the router reads that as "nothing was applied"
 * and falls back, which keeps the "is this usable?" decision in one place.
 */
export function parseInterpretation(raw: unknown, input: string): ParsedCommand {
  const envelope = readEnvelope(raw);
  const query = emptyQuery();
  const lower = input.toLowerCase();

  /**
   * The residue. Accepted spans are blanked out of it; whatever survives is,
   * by definition, what the user typed and Apsis did not act on.
   */
  let residue = lower;
  const blank = (span: string) => {
    const needle = span.toLowerCase();
    const at = residue.indexOf(needle);
    if (at === -1) return; // already consumed by an earlier, overlapping span
    residue = residue.slice(0, at) + ' '.repeat(needle.length) + residue.slice(at + needle.length);
  };

  /** Provenance is checked against the ORIGINAL input, so two filters may cite the same words. */
  const cited = (span: unknown): span is string =>
    typeof span === 'string' && span.trim().length > 0 && lower.includes(span.toLowerCase());

  const understoodByField = new Map<InterpretableField, string[]>();
  const note = (field: InterpretableField, text: string) => {
    const list = understoodByField.get(field);
    if (list) list.push(text);
    else understoodByField.set(field, [text]);
  };

  for (const entry of envelope.filters) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { field, value, span } = entry as { field?: unknown; value?: unknown; span?: unknown };

    // 1. Closed field set. `__proto__`, `leads`, anything invented: rejected.
    if (typeof field !== 'string' || !FIELD_SET.has(field)) continue;
    // 2. Provenance. An uncitable filter is a hallucination, not a filter.
    if (!cited(span)) continue;

    const key = field as InterpretableField;
    // A list field may arrive as one value or several; a scalar never may.
    const values = Array.isArray(value) ? value : [value];
    let applied = false;

    switch (key) {
      case 'stages': {
        for (const v of values) {
          const stage = canonical(v, STAGE_ORDER) as Stage | null;
          if (!stage || query.stages.includes(stage)) continue;
          query.stages.push(stage);
          note(key, `stage is ${STAGES[stage].label}`);
          applied = true;
        }
        break;
      }
      case 'segments': {
        for (const v of values) {
          const segment = canonical(v, SEGMENT_VOCABULARY);
          if (!segment || query.segments.includes(segment)) continue;
          query.segments.push(segment);
          note(key, `segment is ${segment}`);
          applied = true;
        }
        break;
      }
      case 'locations': {
        for (const v of values) {
          const city = canonical(v, CITY_NAMES);
          if (!city || query.locations.includes(city)) continue;
          query.locations.push(city);
          note(key, `located in ${city}`);
          applied = true;
        }
        break;
      }
      case 'states': {
        for (const v of values) {
          const code = canonicalState(v);
          if (!code || query.states.includes(code)) continue;
          query.states.push(code);
          note(key, `state is ${STATE_NAMES[code]}`);
          applied = true;
        }
        break;
      }
      // Scalars: FIRST valid wins. A second one is rejected rather than allowed
      // to overwrite, and because rejection does not blank its span, the clause
      // stays visible instead of disappearing into a silent last-write-wins.
      case 'idleDaysMin': {
        if (query.idleDaysMin !== null || Array.isArray(value)) break;
        const n = inRange(asNumber(value), 1, MAX_IDLE_DAYS, true);
        if (n === null) break;
        query.idleDaysMin = n;
        note(key, `no contact for ${n}+ days`);
        applied = true;
        break;
      }
      case 'scoreMin': {
        if (query.scoreMin !== null || Array.isArray(value)) break;
        const n = inRange(asNumber(value), 0, 100, false);
        if (n === null) break;
        query.scoreMin = n;
        note(key, `score above ${n}`);
        applied = true;
        break;
      }
      case 'scoreMax': {
        if (query.scoreMax !== null || Array.isArray(value)) break;
        const n = inRange(asNumber(value), 0, 100, false);
        if (n === null) break;
        query.scoreMax = n;
        note(key, `score below ${n}`);
        applied = true;
        break;
      }
      case 'limit': {
        if (query.limit !== null || Array.isArray(value)) break;
        const n = inRange(asNumber(value), 1, MAX_LIMIT, true);
        if (n === null) break;
        query.limit = n;
        note(key, `limit ${n}`);
        applied = true;
        break;
      }
    }

    // Only an APPLIED filter earns the right to consume its words.
    if (applied) blank(span);
  }

  // The action is held to the same provenance rule as everything else.
  let action: CommandAction = 'none';
  const actionUnderstood: string[] = [];
  if (envelope.action && envelope.action !== 'none' && cited(envelope.actionSpan)) {
    action = envelope.action;
    actionUnderstood.push(`action: ${action}`);
    blank(envelope.actionSpan!);
  }

  const understood = [
    ...UNDERSTOOD_ORDER.flatMap((field) => understoodByField.get(field) ?? []),
    ...actionUnderstood,
  ];

  /**
   * `envelope.unmapped` is deliberately NOT rendered.
   *
   * The residue already guarantees that nothing the user typed can disappear,
   * and it is built from the user's own words. Merging the model's free text
   * into the outcome panel would let the interpreter write UI copy, which is a
   * surface worth not having for no gain in honesty.
   */
  const unrecognised = residue
    .split(/[^a-z0-9'+]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !isFiller(w));

  return { query, action, understood, unrecognised: [...new Set(unrecognised)] };
}
