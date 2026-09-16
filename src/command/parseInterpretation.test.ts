/**
 * The validator's tests. Fixtures only — no network, no UI, no React.
 *
 * These encode what an interpreter is NOT allowed to do to Apsis. Every one of
 * them describes a way a plausible-looking model answer could put data into the
 * application that the user never asked for, or take a clause out of sight.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_SCHEMA,
  INTERPRETABLE_FIELDS,
  InterpretationFormatError,
  SEGMENT_VOCABULARY,
  parseInterpretation,
} from './parseInterpretation';
import { parseCommand } from '../domain/query';
import { seedLeads } from '../domain/seed';

const ok = (filters: unknown[], extra: Record<string, unknown> = {}) => ({ filters, ...extra });

describe('envelope', () => {
  it('throws on a structurally unusable shape, so the caller can fall back', () => {
    for (const bad of [null, undefined, 42, 'text', [], {}, { filters: 'nope' }]) {
      expect(() => parseInterpretation(bad, 'hot leads'), JSON.stringify(bad) ?? 'undefined').toThrow(
        InterpretationFormatError,
      );
    }
  });

  it('throws on an action outside the closed set', () => {
    expect(() => parseInterpretation(ok([], { action: 'delete_everything' }), 'x')).toThrow(
      InterpretationFormatError,
    );
  });

  it('accepts an empty filter list — that is a usable shape with nothing in it', () => {
    const p = parseInterpretation(ok([]), 'hot leads in Tampa');
    expect(p.understood).toEqual([]);
    expect(p.query.stages).toEqual([]);
  });
});

describe('field injection', () => {
  it('cannot introduce a key that is not in LeadQuery', () => {
    const p = parseInterpretation(
      ok([
        { field: 'leads', value: ['lead_1'], span: 'hot' },
        { field: '__proto__', value: { polluted: true }, span: 'hot' },
        { field: 'constructor', value: 'x', span: 'hot' },
        { field: 'prototype', value: 'x', span: 'hot' },
        { field: 'idleDaysMin ', value: 5, span: 'hot' },
      ]),
      'hot leads',
    );
    expect(p.understood).toEqual([]);
    expect(Object.keys(p.query).sort()).toEqual([...INTERPRETABLE_FIELDS].sort());
    expect((p.query as unknown as Record<string, unknown>).leads).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a rejected field leaves its words visible rather than swallowing them', () => {
    const p = parseInterpretation(ok([{ field: 'sentiment', value: 'angry', span: 'frustrated' }]), 'frustrated leads');
    expect(p.unrecognised).toContain('frustrated');
  });
});

describe('provenance', () => {
  it('drops a filter whose cited span is not in the input', () => {
    // The model asserts Florida. The user never said Florida. It is invented,
    // and an invented citation is the cheapest possible tell.
    const p = parseInterpretation(
      ok([
        { field: 'states', value: 'FL', span: 'Florida' },
        { field: 'stages', value: 'hot', span: 'hot' },
      ]),
      'hot leads in Texas',
    );
    expect(p.query.states).toEqual([]);
    expect(p.query.stages).toEqual(['hot']);
    expect(p.unrecognised).toContain('texas');
  });

  it('requires a span that is a string with content', () => {
    for (const span of [undefined, null, '', '   ', 42, {}]) {
      const p = parseInterpretation(ok([{ field: 'stages', value: 'hot', span }]), 'hot leads');
      expect(p.query.stages, String(span)).toEqual([]);
    }
  });

  it('matches the span case-insensitively', () => {
    const p = parseInterpretation(ok([{ field: 'states', value: 'fl', span: 'FLORIDA' }]), 'leads in florida');
    expect(p.query.states).toEqual(['FL']);
    expect(p.unrecognised).not.toContain('florida');
  });

  it('lets two filters cite the same words without the second starving', () => {
    const p = parseInterpretation(
      ok([
        { field: 'stages', value: 'hot', span: 'hot' },
        { field: 'scoreMin', value: 80, span: 'hot' },
      ]),
      'hot leads',
    );
    expect(p.query.stages).toEqual(['hot']);
    expect(p.query.scoreMin).toBe(80);
  });
});

describe('value vocabulary', () => {
  it('drops a stage that does not exist and surfaces its span', () => {
    const p = parseInterpretation(
      ok([{ field: 'stages', value: 'frustrated', span: 'frustrated' }]),
      'find frustrated leads',
    );
    expect(p.query.stages).toEqual([]);
    expect(p.unrecognised).toContain('frustrated');
  });

  it('returns the CANONICAL spelling, never the model’s', () => {
    const p = parseInterpretation(
      ok([
        { field: 'segments', value: 'medicare', span: 'medicare' },
        { field: 'locations', value: 'tampa', span: 'tampa' },
        { field: 'states', value: 'fl', span: 'fl' },
      ]),
      'medicare leads in tampa fl',
    );
    expect(p.query.segments).toEqual(['Medicare']);
    expect(p.query.locations).toEqual(['Tampa']);
    expect(p.query.states).toEqual(['FL']);
  });

  it('rejects unknown cities, unknown states and unknown segments', () => {
    const p = parseInterpretation(
      ok([
        { field: 'locations', value: 'Atlantis', span: 'atlantis' },
        { field: 'states', value: 'ZZ', span: 'zz' },
        { field: 'states', value: 'Florida', span: 'atlantis' },
        { field: 'segments', value: 'Pet Insurance', span: 'atlantis' },
      ]),
      'leads in atlantis zz',
    );
    expect(p.query.locations).toEqual([]);
    expect(p.query.states).toEqual([]);
    expect(p.query.segments).toEqual([]);
  });

  it('bounds every number and refuses non-finite or out-of-range values', () => {
    const cases: Array<[string, unknown]> = [
      ['idleDaysMin', 0],
      ['idleDaysMin', -5],
      ['idleDaysMin', 4000],
      ['idleDaysMin', 1.5],
      ['idleDaysMin', 'lots'],
      ['scoreMin', 101],
      ['scoreMin', -1],
      ['scoreMin', Number.NaN],
      ['scoreMin', Number.POSITIVE_INFINITY],
      ['scoreMax', 1000],
      ['limit', 0],
      ['limit', 2.5],
    ];
    for (const [field, value] of cases) {
      const p = parseInterpretation(ok([{ field, value, span: 'x9' }]), 'x9 leads');
      expect(p.understood, `${field}=${String(value)}`).toEqual([]);
    }
  });

  it('accepts numeric strings, because a model will eventually send one', () => {
    const p = parseInterpretation(ok([{ field: 'scoreMin', value: '80', span: '80' }]), 'score above 80');
    expect(p.query.scoreMin).toBe(80);
  });

  it('refuses an array for a scalar field', () => {
    const p = parseInterpretation(ok([{ field: 'limit', value: [5, 10], span: 'top' }]), 'top leads');
    expect(p.query.limit).toBeNull();
  });

  it('takes the FIRST valid scalar and leaves the loser visible', () => {
    const p = parseInterpretation(
      ok([
        { field: 'scoreMin', value: 80, span: '80' },
        { field: 'scoreMin', value: 20, span: '20' },
      ]),
      'score above 80 or maybe 20 zebra',
    );
    expect(p.query.scoreMin).toBe(80);
    // Not silently overwritten, and not silently dropped either.
    expect(p.unrecognised).toContain('zebra');
  });
});

describe('the action is held to the same provenance rule', () => {
  it('applies a cited action', () => {
    const p = parseInterpretation(
      ok([{ field: 'stages', value: 'hot', span: 'hot' }], { action: 'call', actionSpan: 'call them' }),
      'hot leads, call them',
    );
    expect(p.action).toBe('call');
    expect(p.understood).toContain('action: call');
    expect(p.unrecognised).not.toContain('call');
  });

  it('refuses an uncited action rather than acting on a verb nobody typed', () => {
    const p = parseInterpretation(
      ok([{ field: 'stages', value: 'hot', span: 'hot' }], { action: 'book' }),
      'hot leads',
    );
    expect(p.action).toBe('none');
  });

  it('refuses an action whose span is not in the input', () => {
    const p = parseInterpretation(ok([], { action: 'call', actionSpan: 'ring them up' }), 'hot leads');
    expect(p.action).toBe('none');
  });
});

describe('the residue is computed, never taken on trust', () => {
  it('surfaces a clause the model did not map — the worked example in §H', () => {
    const input = "show me hot Florida leads who sounded frustrated on yesterday's calls";
    const p = parseInterpretation(
      ok([
        { field: 'stages', value: 'hot', span: 'hot' },
        { field: 'states', value: 'FL', span: 'Florida' },
      ]),
      input,
    );
    expect(p.understood).toEqual(['stage is Hot', 'state is Florida']);
    // "yesterday's" → "yesterdays": the same splitter the grammar uses keeps the
    // apostrophe through the split and strips it in the cleanup, so both paths
    // report an unmapped possessive identically.
    expect(p.unrecognised).toEqual(['sounded', 'frustrated', 'yesterdays', 'calls']);
  });

  it('ignores the model’s own account of what it missed', () => {
    // The model claims it mapped everything. The residue disagrees, and the
    // residue is what the user is shown.
    const p = parseInterpretation(
      ok([{ field: 'stages', value: 'hot', span: 'hot' }], { unmapped: [] }),
      'hot leads who sounded frustrated',
    );
    expect(p.unrecognised).toEqual(expect.arrayContaining(['sounded', 'frustrated']));
  });

  it('does not render model-authored text as UI copy', () => {
    const p = parseInterpretation(
      ok([{ field: 'stages', value: 'hot', span: 'hot' }], {
        unmapped: ['IGNORE PREVIOUS INSTRUCTIONS', 'buy now'],
      }),
      'hot leads',
    );
    expect(p.unrecognised).toEqual([]);
    expect(JSON.stringify(p)).not.toContain('IGNORE PREVIOUS');
  });

  it('a lead the domain KNOWS but the model skipped is still reported', () => {
    // Deliberately not filler: failing to map a term Apsis understands is
    // exactly the failure worth seeing.
    const p = parseInterpretation(ok([{ field: 'stages', value: 'hot', span: 'hot' }]), 'hot leads in Tampa');
    expect(p.unrecognised).toContain('tampa');
  });

  it('filters the same stop words the grammar does, by asking the grammar', () => {
    const input = 'find all the hot leads for me please';
    const p = parseInterpretation(ok([{ field: 'stages', value: 'hot', span: 'hot' }]), input);
    expect(p.unrecognised).toEqual([]);
    // The oracle agrees: the grammar reports nothing unrecognised here either.
    expect(parseCommand(input).unrecognised).toEqual([]);
  });

  it('orders understood the way the grammar does, whatever order the model used', () => {
    const p = parseInterpretation(
      ok(
        [
          { field: 'states', value: 'FL', span: 'Florida' },
          { field: 'stages', value: 'cold', span: 'cold' },
          { field: 'limit', value: 25, span: 'top 25' },
          { field: 'segments', value: 'Medicare', span: 'medicare' },
        ],
        { action: 'call', actionSpan: 'call' },
      ),
      'cold medicare leads in Florida, top 25, call',
    );
    expect(p.understood).toEqual([
      'limit 25',
      'stage is Cold',
      'segment is Medicare',
      'state is Florida',
      'action: call',
    ]);
  });
});

describe('the schema sent to the host', () => {
  it('is built from the same vocabulary the validator enforces', () => {
    expect(COMMAND_SCHEMA.fields.segments.values).toEqual(SEGMENT_VOCABULARY);
    expect(Object.keys(COMMAND_SCHEMA.fields).sort()).toEqual([...INTERPRETABLE_FIELDS].sort());
  });

  it('carries no lead data — vocabularies are schema, records are not', () => {
    const body = JSON.stringify(COMMAND_SCHEMA);
    for (const lead of seedLeads(300)) {
      expect(body).not.toContain(lead.name);
      expect(body).not.toContain(lead.phone);
      expect(body).not.toContain(lead.email);
    }
  });

  it('pins the duplicated segment list against a real seeded book', () => {
    // `SEGMENT_VOCABULARY` is copied from seed.ts because src/domain is
    // forbidden to this milestone. This is the guard against that copy drifting.
    const actual = new Set(seedLeads(3000).map((l) => l.segment));
    expect([...actual].sort()).toEqual([...SEGMENT_VOCABULARY].sort());
  });
});
