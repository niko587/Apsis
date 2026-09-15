import { describe, expect, it } from 'vitest';
import { isEmptyQuery, parseCommand, runQuery } from './query';
import { seedLeads } from './seed';

const NOW = 1_700_000_000_000;
const DAY = 1000 * 60 * 60 * 24;

describe('parseCommand', () => {
  it('parses the reference command from the design brief', () => {
    const p = parseCommand(
      "Apsis, find all cold family leads in Tampa that haven't been contacted in 14+ days. Start the reactivation sequence.",
    );
    expect(p.query.stages).toEqual(['cold']);
    expect(p.query.segments).toEqual(['Family Coverage']);
    expect(p.query.locations).toEqual(['Tampa']);
    expect(p.query.idleDaysMin).toBe(14);
    expect(p.action).toBe('reactivate');
  });

  it('reports clauses it could not place instead of silently dropping them', () => {
    // The failure this guards: quietly ignoring a clause and returning confident
    // results for the rest, so "no matches" and "I ignored your filter" look alike.
    const p = parseCommand('find hot leads with a golden retriever in Tampa');
    expect(p.query.stages).toEqual(['hot']);
    expect(p.unrecognised).toContain('golden');
    expect(p.unrecognised).toContain('retriever');
  });

  it('does not report ordinary filler as unrecognised', () => {
    const p = parseCommand('find all the cold leads in Miami');
    expect(p.unrecognised).toEqual([]);
  });

  it('parses states by full name and by uppercase abbreviation', () => {
    expect(parseCommand('find hot leads in California').query.states).toEqual(['CA']);
    expect(parseCommand('find hot leads in TX').query.states).toEqual(['TX']);
    expect(parseCommand('cold leads in New Jersey').query.states).toEqual(['NJ']);
  });

  it('does NOT read lowercase state codes as states', () => {
    // `me`, `or`, `in`, `ok`, `hi` and `de` are all ordinary words. Matching
    // two-letter codes case-insensitively would turn "find me leads" into a
    // filter for Maine and quietly return the wrong book.
    for (const s of ['find me leads', 'show me hot or cold leads', 'leads in ok shape']) {
      expect(parseCommand(s).query.states, s).toEqual([]);
    }
  });

  it('prefers the longest city name so multi-word cities survive', () => {
    // "Kansas" before "Kansas City" would eat half the name and leave "city"
    // behind as an unrecognised word.
    const p = parseCommand('find cold leads in Kansas City');
    expect(p.query.locations).toEqual(['Kansas City']);
    expect(p.unrecognised).toEqual([]);

    const q = parseCommand('hot leads in Salt Lake City');
    expect(q.query.locations).toEqual(['Salt Lake City']);
    expect(q.unrecognised).toEqual([]);
  });

  it('parses a city and a state together', () => {
    const p = parseCommand('find qualified leads in Austin, TX');
    expect(p.query.locations).toEqual(['Austin']);
    expect(p.query.states).toEqual(['TX']);
    expect(p.unrecognised).toEqual([]);
  });

  it('parses score bounds and limits', () => {
    const p = parseCommand('show leads with score above 80, top 25');
    expect(p.query.scoreMin).toBe(80);
    expect(p.query.limit).toBe(25);
  });

  it('treats a command with no filters as empty', () => {
    expect(isEmptyQuery(parseCommand('do something').query)).toBe(true);
    expect(isEmptyQuery(parseCommand('find cold leads').query)).toBe(false);
  });
});

describe('runQuery', () => {
  const leads = seedLeads(2000, 0x5f3a21, NOW);

  it('narrows monotonically and records the funnel', () => {
    const { query } = parseCommand('find cold family leads in Tampa');
    const { leadIds, funnel } = runQuery(query, leads, NOW);
    expect(funnel[0].remaining).toBe(2000);
    for (let i = 1; i < funnel.length; i++) {
      expect(funnel[i].remaining).toBeLessThanOrEqual(funnel[i - 1].remaining);
    }
    expect(leadIds.length).toBe(funnel[funnel.length - 1].remaining);
  });

  it('returns only leads matching every clause', () => {
    const { query } = parseCommand('find cold family leads in Tampa');
    const { leadIds } = runQuery(query, leads, NOW);
    const byId = new Map(leads.map((l) => [l.id, l]));
    for (const id of leadIds) {
      const l = byId.get(id)!;
      expect(l.stage).toBe('cold');
      expect(l.segment).toBe('Family Coverage');
      expect(l.location.startsWith('Tampa')).toBe(true);
    }
  });

  it('honours the idle filter', () => {
    const { query } = parseCommand("leads that haven't been contacted in 30 days");
    const { leadIds } = runQuery(query, leads, NOW);
    const byId = new Map(leads.map((l) => [l.id, l]));
    for (const id of leadIds) {
      expect(byId.get(id)!.lastEventAt).toBeLessThanOrEqual(NOW - 30 * DAY);
    }
  });

  it('keeps the warmest when a limit truncates', () => {
    const { query } = parseCommand('find leads with score above 10, top 5');
    const { leadIds } = runQuery(query, leads, NOW);
    const byId = new Map(leads.map((l) => [l.id, l]));
    const scores = leadIds.map((id) => byId.get(id)!.score);
    expect(leadIds.length).toBe(5);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
