/**
 * Command parsing and execution.
 *
 * This is a real grammar over the vocabulary the domain actually has — stages,
 * segments, locations, recency, score — not an LLM and not a mock. It parses a
 * command into a structured `LeadQuery`, runs it against the store, and reports
 * a funnel showing what each filter removed.
 *
 * The design commitment that matters: **it reports what it did NOT understand.**
 * §13 asks the interface to show what Apsis understood; a parser that silently
 * drops the half of a sentence it cannot handle and returns confident results for
 * the rest is worse than one that returns nothing, because you cannot tell the
 * difference between "no leads match" and "I ignored your most important clause".
 *
 * Swapping in an LLM later means replacing `parseCommand` with a call that emits
 * the same `LeadQuery`. Execution, the funnel and the UI stay exactly as they are.
 */

import { STAGES, STAGE_ORDER, type Lead, type Stage } from './types';
import { CITY_NAMES, STATE_NAMES, cityOf } from './geography';

export interface LeadQuery {
  stages: Stage[];
  segments: string[];
  /** City names, e.g. `"Tampa"`. Matches every state using that name. */
  locations: string[];
  /** Two-letter state codes, e.g. `"FL"`. */
  states: string[];
  /** Match leads with NO event for at least this many days. */
  idleDaysMin: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  limit: number | null;
}

export type CommandAction = 'reactivate' | 'call' | 'book' | 'none';

export interface ParsedCommand {
  query: LeadQuery;
  action: CommandAction;
  /** Human-readable account of each clause that was recognised. */
  understood: string[];
  /** Words the parser could not place. Surfaced, never swallowed. */
  unrecognised: string[];
}

const EMPTY_QUERY = (): LeadQuery => ({
  stages: [],
  segments: [],
  locations: [],
  states: [],
  idleDaysMin: null,
  scoreMin: null,
  scoreMax: null,
  limit: null,
});

/** Segment keywords → the canonical segment strings used in the lead book. */
const SEGMENT_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\bfamil(y|ies)\b/, 'Family Coverage'],
  [/\bindividual(s)?\b/, 'Individual'],
  [/\bmedicare\b/, 'Medicare'],
  [/\bsmall business(es)?\b/, 'Small Business'],
  [/\bself[- ]employed\b/, 'Self-Employed'],
  [/\bsupplemental\b/, 'Supplemental'],
  [/\b(dental|vision)\b/, 'Dental + Vision'],
];

const STAGE_WORDS: ReadonlyArray<[RegExp, Stage]> = [
  [/\bcold\b/, 'cold'],
  [/\bcontacted\b/, 'contacted'],
  [/\bengaged\b/, 'engaged'],
  [/\bqualified\b/, 'qualified'],
  [/\bhot\b/, 'hot'],
  [/\bappointment[- ]ready\b/, 'appointment_ready'],
  [/\bbooked\b/, 'booked'],
];

const ACTION_WORDS: ReadonlyArray<[RegExp, CommandAction]> = [
  [/\b(reactivat|re-?engage|wake)\w*\b/, 'reactivate'],
  [/\b(call|dial|phone)\b/, 'call'],
  [/\b(book|schedule)\b/, 'book'],
];

/** Filler that carries no filtering meaning — not worth reporting as unknown. */
const STOPWORDS = new Set([
  'apsis', 'find', 'show', 'me', 'all', 'the', 'a', 'an', 'in', 'on', 'at', 'of',
  'and', 'or', 'with', 'that', 'who', 'have', 'has', 'havent', 'hasnt', 'been',
  'not', 'for', 'to', 'start', 'sequence', 'leads', 'lead', 'list', 'get',
  'please', 'days', 'day', 'more', 'than', 'least', 'over', 'under', 'last',
  'within', 'past', 'them', 'their', 'is', 'are', 'my', 'our', 'up', 'run',
  'then', 'also', 'this', 'these', 'those', 'it', 'by', 'from',
]);

/** City names carry dots ("St. Louis"), which are regex metacharacters. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseCommand(input: string): ParsedCommand {
  const query = EMPTY_QUERY();
  const understood: string[] = [];

  /**
   * Working text. Each recognised clause is BLANKED OUT of it, so no span can be
   * claimed twice and whatever survives to the end is, by definition, the part
   * that was not understood.
   *
   * Order below is load-bearing. "haven't been contacted in 14+ days" is a
   * recency clause whose own wording contains a stage name; matching stages
   * first turned that command into `cold AND contacted`, which no lead can
   * satisfy — it returned zero matches and looked like a legitimate empty result
   * rather than a parse failure. Recency must consume its words first.
   */
  let remaining = input.toLowerCase();

  const consume = (re: RegExp): RegExpMatchArray | null => {
    const m = remaining.match(re);
    if (m && m.index !== undefined) {
      remaining =
        remaining.slice(0, m.index) +
        ' '.repeat(m[0].length) +
        remaining.slice(m.index + m[0].length);
    }
    return m;
  };

  // 1. Recency — must run before stages. See note above.
  const idle = consume(
    /\b(?:not|no|haven'?t|hasn'?t|without)[\w\s']{0,28}?(\d+)\s*\+?\s*days?\b|\bidle\s+(\d+)\s*\+?\s*days?\b/,
  );
  if (idle) {
    const n = Number.parseInt(idle[1] ?? idle[2], 10);
    if (Number.isFinite(n)) {
      query.idleDaysMin = n;
      understood.push(`no contact for ${n}+ days`);
    }
  }

  // 2. Numeric bounds, which also embed words that could read as other clauses.
  const above = consume(/\bscore\s*(?:above|over|greater than|>)\s*(\d+)/);
  if (above) {
    query.scoreMin = Number.parseInt(above[1], 10);
    understood.push(`score above ${query.scoreMin}`);
  }
  const below = consume(/\bscore\s*(?:below|under|less than|<)\s*(\d+)/);
  if (below) {
    query.scoreMax = Number.parseInt(below[1], 10);
    understood.push(`score below ${query.scoreMax}`);
  }
  const top = consume(/\b(?:top|first|limit)\s+(\d+)\b/);
  if (top) {
    query.limit = Number.parseInt(top[1], 10);
    understood.push(`limit ${query.limit}`);
  }

  // 3. Action verbs.
  let action: CommandAction = 'none';
  for (const [re, a] of ACTION_WORDS) {
    if (consume(re)) {
      action = a;
      understood.push(`action: ${a}`);
      break;
    }
  }

  // 4. Plain vocabulary, over whatever text is left.
  for (const [re, stage] of STAGE_WORDS) {
    if (consume(re)) {
      query.stages.push(stage);
      understood.push(`stage is ${STAGES[stage].label}`);
    }
  }
  for (const [re, segment] of SEGMENT_WORDS) {
    if (consume(re)) {
      query.segments.push(segment);
      understood.push(`segment is ${segment}`);
    }
  }
  // 5. Geography. Cities before states, and `CITY_NAMES` is sorted longest
  // first: matching "Kansas" before "Kansas City" would eat half the city name
  // and leave "city" behind as an unrecognised word. Greedy-longest makes the
  // scan correct without lookahead.
  //
  // "Washington" resolves to the DC metro rather than Washington state, because
  // the book has a city by that name and no WA city called Washington. `WA`
  // still selects the state.
  for (const city of CITY_NAMES) {
    if (consume(new RegExp(`\\b${escapeRe(city.toLowerCase())}\\b`))) {
      query.locations.push(city);
      understood.push(`located in ${city}`);
    }
  }

  for (const [code, name] of Object.entries(STATE_NAMES)) {
    if (consume(new RegExp(`\\b${name.toLowerCase()}\\b`))) {
      query.states.push(code);
      understood.push(`state is ${name}`);
    }
  }

  /**
   * State abbreviations, read from the ORIGINAL-CASE input.
   *
   * Matching bare two-letter codes case-insensitively is a trap: `ME`, `OR`,
   * `IN`, `OK`, `HI` and `DE` are all ordinary English words, so "find me leads"
   * would silently filter to Maine. Requiring uppercase in what the user
   * actually typed is the signal that distinguishes a postal code from a word.
   * Indices line up because `toLowerCase()` preserves length for ASCII.
   */
  for (const m of input.matchAll(/\b[A-Z]{2}\b/g)) {
    const code = m[0];
    if (!STATE_NAMES[code] || m.index === undefined) continue;
    if (remaining.slice(m.index, m.index + 2).trim() === '') continue; // already consumed
    if (query.states.includes(code)) continue;
    remaining = remaining.slice(0, m.index) + '  ' + remaining.slice(m.index + 2);
    query.states.push(code);
    understood.push(`state is ${STATE_NAMES[code]}`);
  }

  const unrecognised = remaining
    .split(/[^a-z0-9'+]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  return { query, action, understood, unrecognised: [...new Set(unrecognised)] };
}

export interface FunnelStep {
  label: string;
  remaining: number;
}

export interface QueryResult {
  leadIds: string[];
  funnel: FunnelStep[];
}

const DAY = 1000 * 60 * 60 * 24;

/**
 * Run a query, recording how many leads survive each filter.
 *
 * The funnel is the useful part: "19 leads" alone is unreadable, but "4,892
 * scanned → 703 family → 84 in Tampa → 19 idle 14+ days" tells you which clause
 * did the work and which one was too aggressive.
 */
export function runQuery(
  query: LeadQuery,
  leads: Iterable<Lead>,
  now: number,
): QueryResult {
  let pool = [...leads];
  const funnel: FunnelStep[] = [{ label: 'scanned', remaining: pool.length }];

  if (query.segments.length) {
    pool = pool.filter((l) => query.segments.includes(l.segment));
    funnel.push({ label: query.segments.join(' / '), remaining: pool.length });
  }
  if (query.states.length) {
    pool = pool.filter((l) => query.states.some((s) => l.location.endsWith(s)));
    funnel.push({
      label: query.states.map((s) => STATE_NAMES[s] ?? s).join(' / '),
      remaining: pool.length,
    });
  }
  if (query.locations.length) {
    // Compare the city part, not a prefix of the whole string: two metros share
    // the name "Charleston", and a bare city filter should mean both of them.
    pool = pool.filter((l) => query.locations.includes(cityOf(l.location)));
    funnel.push({ label: query.locations.join(' / '), remaining: pool.length });
  }
  if (query.stages.length) {
    pool = pool.filter((l) => query.stages.includes(l.stage));
    funnel.push({
      label: query.stages.map((s) => STAGES[s].label.toLowerCase()).join(' / '),
      remaining: pool.length,
    });
  }
  if (query.idleDaysMin !== null) {
    const cutoff = now - query.idleDaysMin * DAY;
    pool = pool.filter((l) => l.lastEventAt <= cutoff);
    funnel.push({ label: `idle ${query.idleDaysMin}+ days`, remaining: pool.length });
  }
  if (query.scoreMin !== null) {
    pool = pool.filter((l) => l.score > query.scoreMin!);
    funnel.push({ label: `score > ${query.scoreMin}`, remaining: pool.length });
  }
  if (query.scoreMax !== null) {
    pool = pool.filter((l) => l.score < query.scoreMax!);
    funnel.push({ label: `score < ${query.scoreMax}`, remaining: pool.length });
  }

  // Warmest first — if a limit is about to discard leads, discard the coldest.
  pool.sort((a, b) => b.score - a.score);
  if (query.limit !== null && pool.length > query.limit) {
    pool = pool.slice(0, query.limit);
    funnel.push({ label: `top ${query.limit}`, remaining: pool.length });
  }

  return { leadIds: pool.map((l) => l.id), funnel };
}

/**
 * A human sentence for what a command is doing (§17 CURRENT FOCUS).
 *
 * Built from the PARSED command rather than the raw input, so the focus line
 * reflects what Apsis actually understood. Echoing the user's typing back would
 * claim comprehension the parser may not have — a clause it ignored would still
 * appear in the focus line as though it were being acted on.
 */
export function describeCommand(parsed: ParsedCommand): string {
  const { query, action } = parsed;
  const verb =
    action === 'reactivate'
      ? 'Reactivating'
      : action === 'call'
        ? 'Calling'
        : action === 'book'
          ? 'Booking'
          : 'Reviewing';

  const parts: string[] = [];
  if (query.stages.length) {
    parts.push(query.stages.map((s) => STAGES[s].label.toLowerCase()).join(' / '));
  }
  if (query.segments.length) parts.push(query.segments.join(' / ').toLowerCase());
  parts.push('leads');
  const where = [
    ...query.locations,
    ...query.states.map((s) => STATE_NAMES[s] ?? s),
  ];
  if (where.length) parts.push(`in ${where.join(' / ')}`);
  if (query.idleDaysMin !== null) parts.push(`idle ${query.idleDaysMin}+ days`);

  return `${verb} ${parts.join(' ')}`;
}

/** True when a query would match the entire book — i.e. nothing was specified. */
export function isEmptyQuery(q: LeadQuery): boolean {
  return (
    q.stages.length === 0 &&
    q.segments.length === 0 &&
    q.locations.length === 0 &&
    q.states.length === 0 &&
    q.idleDaysMin === null &&
    q.scoreMin === null &&
    q.scoreMax === null
  );
}

export const ALL_STAGES = STAGE_ORDER;
