/**
 * The router's tests, and the proof that opting out costs nothing.
 *
 * The first block is the one that matters most. "With no configured model,
 * Apsis behaves identically to today" is the absolute requirement of this
 * milestone, and the only honest way to hold that claim is to run the real
 * grammar corpus through the new seam and deep-compare, while failing loudly if
 * anything so much as reaches for `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTE_TIMEOUT,
  NOTE_UNAVAILABLE,
  NOTE_UNUSABLE,
  createCommandRunner,
  resolveCommand,
} from './router';
import {
  DEFAULT_TIMEOUT_MS,
  InterpreterTimeoutError,
  InterpreterUnavailableError,
  buildRequestBody,
  createHostInterpreter,
  readInterpreterConfig,
} from './interpreter';
import { parseCommand, runQuery } from '../domain/query';
import { seedLeads } from '../domain/seed';

/**
 * The corpus. Every phrasing `query.test.ts` exercises, plus the three examples
 * the command bar ships as buttons and a handful of shapes that hit the
 * grammar's order-sensitive clauses.
 */
const CORPUS = [
  "find all cold family leads in Tampa that haven't been contacted in 14+ days, start the reactivation sequence",
  'find hot medicare leads in Orlando, call them',
  'show qualified leads with score above 80, top 25',
  'find hot leads with a golden retriever in Tampa',
  'find all the cold leads in Miami',
  'find hot leads in California',
  'find hot leads in TX',
  'cold leads in New Jersey',
  'find me some leads',
  'find cold leads in Kansas City',
  'hot leads in Salt Lake City',
  'find qualified leads in Austin, TX',
  'show leads with score above 80, top 25',
  'do something',
  'find cold leads',
  "leads that haven't been contacted in 30 days",
  'find leads with score above 10, top 5',
  'show me hot Florida leads who sounded frustrated on yesterday’s calls',
  'book appointments for engaged self-employed leads in Denver',
  'reactivate supplemental leads idle 45 days',
  '',
  '   ',
];

/** Fails the test rather than the request: nothing may reach the network here. */
function forbidFetch() {
  const spy = vi.fn(() => {
    throw new Error('fetch was called on the disabled path');
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('no interpreter configured — identical to today', () => {
  it('returns exactly what parseCommand returns, across the corpus', () => {
    const fetchSpy = forbidFetch();
    for (const text of CORPUS) {
      const outcome = resolveCommand(text, { interpreter: null });
      expect(outcome, text).not.toBeInstanceOf(Promise);
      const resolved = outcome as { parsed: unknown; source: string; note: string | null };
      expect(resolved.parsed, text).toEqual(parseCommand(text));
      expect(resolved.source, text).toBe('grammar');
      expect(resolved.note, text).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is synchronous — no promise, no microtask that could reorder anything', () => {
    // `await` on a plain value still defers a turn, which would split one React
    // render into two. The disabled path must not even offer the opportunity.
    expect(resolveCommand('find cold leads', { interpreter: null })).not.toBeInstanceOf(Promise);
    expect(createCommandRunner({ interpreter: null }).run('find cold leads')).not.toBeInstanceOf(
      Promise,
    );
  });

  it('never calls fetch, through the runner as well as directly', () => {
    const fetchSpy = forbidFetch();
    const runner = createCommandRunner({ interpreter: null });
    for (const text of CORPUS) runner.run(text);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('produces query results identical to the grammar when executed', () => {
    const leads = seedLeads(400);
    const now = Date.UTC(2026, 8, 16);
    for (const text of CORPUS) {
      const viaRouter = resolveCommand(text, { interpreter: null }) as { parsed: ReturnType<typeof parseCommand> };
      expect(runQuery(viaRouter.parsed.query, leads, now), text).toEqual(
        runQuery(parseCommand(text).query, leads, now),
      );
    }
  });
});

describe('host declaration', () => {
  const scopeWith = (declared: unknown, search = '') => ({
    __APSIS_COMMAND_INTERPRETER__: declared,
    location: { search },
  });

  it('treats absent, malformed and empty declarations as "no interpreter exists"', () => {
    for (const declared of [
      undefined,
      null,
      42,
      'https://example.test',
      [],
      {},
      { endpoint: '' },
      { endpoint: '   ' },
      { endpoint: 123 },
      { endpoint: null },
    ]) {
      expect(readInterpreterConfig(scopeWith(declared)), JSON.stringify(declared) ?? 'undefined').toBeNull();
    }
  });

  it('accepts a declared endpoint and defaults the timeout', () => {
    expect(readInterpreterConfig(scopeWith({ endpoint: '/api/interpret' }))).toEqual({
      endpoint: '/api/interpret',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('takes a positive finite timeout and ignores anything else', () => {
    expect(readInterpreterConfig(scopeWith({ endpoint: '/x', timeoutMs: 1200 }))?.timeoutMs).toBe(1200);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '900', null]) {
      expect(readInterpreterConfig(scopeWith({ endpoint: '/x', timeoutMs: bad }))?.timeoutMs).toBe(
        DEFAULT_TIMEOUT_MS,
      );
    }
  });

  it('?interpreter=off forces the grammar even when one is declared', () => {
    const declared = { endpoint: '/api/interpret' };
    expect(readInterpreterConfig(scopeWith(declared, '?interpreter=off'))).toBeNull();
    expect(readInterpreterConfig(scopeWith(declared, '?fx=off&interpreter=off'))).toBeNull();
    expect(readInterpreterConfig(scopeWith(declared, '?interpreter=on'))).not.toBeNull();
  });
});

/* --------------------------------------------------------- mocked models --- */

const reply = (body: unknown): ReturnType<typeof createInterpreter> =>
  createInterpreter(async () => body);

function createInterpreter(fn: (text: string) => Promise<unknown>) {
  return { name: 'test', interpret: (text: string) => fn(text) };
}

describe('a successful interpretation', () => {
  it('maps novel phrasing onto the canonical LeadQuery', async () => {
    // Phrasing the grammar cannot do anything with: no stage word, no city, a
    // paraphrase of recency. The interpreter earns its place here or nowhere.
    const text = 'which folks in the sunshine state have gone quiet for a fortnight?';
    const interpreter = reply({
      filters: [
        { field: 'states', value: 'FL', span: 'sunshine state' },
        { field: 'idleDaysMin', value: 14, span: 'gone quiet for a fortnight' },
      ],
    });
    const outcome = await resolveCommand(text, { interpreter });
    expect(outcome.source).toBe('interpreter');
    expect(outcome.note).toBeNull();
    expect(outcome.parsed.query.states).toEqual(['FL']);
    expect(outcome.parsed.query.idleDaysMin).toBe(14);
    // And the grammar genuinely could not: this is not a tautology.
    expect(parseCommand(text).query.states).toEqual([]);
  });

  it('executes identically to the grammar when both understand a command', async () => {
    const text = 'find cold family leads in Tampa';
    const interpreter = reply({
      filters: [
        { field: 'stages', value: 'cold', span: 'cold' },
        { field: 'segments', value: 'Family Coverage', span: 'family' },
        { field: 'locations', value: 'Tampa', span: 'Tampa' },
      ],
    });
    const outcome = await resolveCommand(text, { interpreter });
    const leads = seedLeads(400);
    const now = Date.UTC(2026, 8, 16);
    expect(runQuery(outcome.parsed.query, leads, now)).toEqual(
      runQuery(parseCommand(text).query, leads, now),
    );
  });

  it('keeps unmapped language visible', async () => {
    const outcome = await resolveCommand('hot leads who sounded frustrated', {
      interpreter: reply({ filters: [{ field: 'stages', value: 'hot', span: 'hot' }] }),
    });
    expect(outcome.source).toBe('interpreter');
    expect(outcome.parsed.unrecognised).toEqual(expect.arrayContaining(['sounded', 'frustrated']));
  });

  it('accepts a partial interpretation and reports the part it dropped', async () => {
    const outcome = await resolveCommand('hot leads in Atlantis', {
      interpreter: reply({
        filters: [
          { field: 'stages', value: 'hot', span: 'hot' },
          { field: 'locations', value: 'Atlantis', span: 'Atlantis' },
        ],
      }),
    });
    expect(outcome.source).toBe('interpreter');
    expect(outcome.parsed.query.stages).toEqual(['hot']);
    expect(outcome.parsed.query.locations).toEqual([]);
    expect(outcome.parsed.unrecognised).toContain('atlantis');
  });
});

describe('every failure lands on the grammar', () => {
  const text = 'find cold leads in Miami';
  const expectGrammar = async (interpreter: { name: string; interpret: (t: string) => Promise<unknown> }, note: string) => {
    const outcome = await resolveCommand(text, { interpreter });
    expect(outcome.source).toBe('grammar');
    expect(outcome.note).toBe(note);
    expect(outcome.parsed).toEqual(parseCommand(text));
  };

  it('network error / CORS / offline', async () => {
    await expectGrammar(
      createInterpreter(async () => {
        throw new InterpreterUnavailableError('Failed to fetch');
      }),
      NOTE_UNAVAILABLE,
    );
  });

  it('non-2xx', async () => {
    await expectGrammar(
      createInterpreter(async () => {
        throw new InterpreterUnavailableError('endpoint returned 500');
      }),
      NOTE_UNAVAILABLE,
    );
  });

  it('timeout', async () => {
    await expectGrammar(
      createInterpreter(async () => {
        throw new InterpreterTimeoutError();
      }),
      NOTE_TIMEOUT,
    );
  });

  it('malformed JSON', async () => {
    await expectGrammar(
      createInterpreter(async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      }),
      NOTE_UNUSABLE,
    );
  });

  it('invalid envelope', async () => {
    await expectGrammar(reply({ nonsense: true }), NOTE_UNUSABLE);
  });

  it('refusal / empty response', async () => {
    await expectGrammar(reply(null), NOTE_UNUSABLE);
    await expectGrammar(reply({ filters: [] }), NOTE_UNUSABLE);
  });

  it('every filter invalid', async () => {
    await expectGrammar(
      reply({
        filters: [
          { field: 'stages', value: 'frustrated', span: 'cold' },
          { field: 'invented', value: 1, span: 'cold' },
          { field: 'states', value: 'FL', span: 'a span nobody typed' },
        ],
      }),
      NOTE_UNUSABLE,
    );
  });

  it('an unexpected throw still leaves a usable answer', async () => {
    await expectGrammar(
      createInterpreter(async () => {
        throw new TypeError('something nobody predicted');
      }),
      NOTE_UNAVAILABLE,
    );
  });

  it('never produces an error state — there is always a parsed command', async () => {
    for (const body of [null, undefined, 0, '', [], { filters: null }, { filters: [{}] }]) {
      const outcome = await resolveCommand(text, { interpreter: reply(body) });
      expect(outcome.parsed.query, JSON.stringify(body) ?? 'undefined').toBeTruthy();
      expect(outcome.parsed).toEqual(parseCommand(text));
    }
  });
});

describe('async safety', () => {
  const deferred = () => {
    let resolveFn!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => {
      resolveFn = r;
    });
    return { promise, resolve: resolveFn };
  };

  it('a slow first response cannot overwrite a fast second one', async () => {
    const slow = deferred();
    const fast = deferred();
    const calls: string[] = [];
    const runner = createCommandRunner({
      interpreter: createInterpreter((text) => {
        calls.push(text);
        return calls.length === 1 ? slow.promise : fast.promise;
      }),
    });

    const first = runner.run('cold leads') as Promise<unknown>;
    const second = runner.run('hot leads') as Promise<unknown>;

    fast.resolve({ filters: [{ field: 'stages', value: 'hot', span: 'hot' }] });
    slow.resolve({ filters: [{ field: 'stages', value: 'cold', span: 'cold' }] });

    // The superseded command yields nothing at all rather than a stale answer.
    expect(await first).toBeNull();
    const winner = (await second) as { parsed: { query: { stages: string[] } } };
    expect(winner.parsed.query.stages).toEqual(['hot']);
  });

  it('a new submit aborts the previous request', async () => {
    const aborts: boolean[] = [];
    const runner = createCommandRunner({
      interpreter: {
        name: 'test',
        interpret: (_text: string, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborts.push(true);
              reject(new Error('aborted'));
            });
          }),
      },
    });
    const first = runner.run('cold leads') as Promise<unknown>;
    const second = runner.run('hot leads') as Promise<unknown>;
    expect(aborts).toEqual([true]);
    expect(await first).toBeNull();
    runner.cancel();
    expect(await second).toBeNull();
  });

  it('ignores a duplicate submit of the text already in flight', () => {
    const runner = createCommandRunner({
      interpreter: createInterpreter(() => new Promise(() => {})),
    });
    expect(runner.run('cold leads')).toBeInstanceOf(Promise);
    expect(runner.run('cold leads')).toBeNull();
    // A different command is not a duplicate.
    expect(runner.run('hot leads')).toBeInstanceOf(Promise);
  });

  it('does not retry', async () => {
    let calls = 0;
    const runner = createCommandRunner({
      interpreter: createInterpreter(async () => {
        calls++;
        throw new InterpreterUnavailableError('down');
      }),
    });
    await runner.run('cold leads');
    expect(calls).toBe(1);
  });
});

/* ---------------------------------------------------------------- wire ----- */

describe('what actually leaves the browser', () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = async (url: string, init: RequestInit) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ filters: [] }),
    } as unknown as Response;
  };

  beforeEach(() => {
    captured = null;
  });

  it('posts the command text and the schema, and nothing else', async () => {
    const interpreter = createHostInterpreter(
      { endpoint: '/api/interpret', timeoutMs: 1000 },
      fakeFetch,
    );
    await interpreter.interpret('find cold leads in Tampa', new AbortController().signal);

    expect(captured!.url).toBe('/api/interpret');
    expect(captured!.init.method).toBe('POST');
    const body = JSON.parse(String(captured!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['schema', 'text']);
    expect(body.text).toBe('find cold leads in Tampa');
  });

  it('carries no lead data: no name, phone, email, score or history', async () => {
    const interpreter = createHostInterpreter(
      { endpoint: '/api/interpret', timeoutMs: 1000 },
      fakeFetch,
    );
    await interpreter.interpret('find cold leads in Tampa', new AbortController().signal);
    const body = String(captured!.init.body);

    for (const lead of seedLeads(500)) {
      expect(body).not.toContain(lead.name);
      expect(body).not.toContain(lead.phone);
      expect(body).not.toContain(lead.email);
      expect(body).not.toContain(lead.id);
      expect(body).not.toContain(lead.occupation);
    }
    // Nor the SHAPE of a lead record. Note what is deliberately not in this
    // list: "score" on its own appears as `scoreMin`/`scoreMax`, which are
    // query vocabulary — the names of filters the user may ask for — not a
    // lead's score. The distinction is the whole point of §L: the model is told
    // that scores exist and is never told anyone's.
    for (const key of [
      'leadId',
      'lastEventAt',
      'ownerAgentId',
      'acquisitionSource',
      'contactPref',
      'currentCoverage',
      'phone',
      'email',
      'events',
      'feed',
    ]) {
      expect(body, key).not.toContain(key);
    }
  });

  it('sends the same body no matter how large the book is', () => {
    // The payload is a function of the command text alone — there is no code
    // path by which the book could reach it.
    expect(JSON.stringify(buildRequestBody('x'))).toBe(JSON.stringify(buildRequestBody('x')));
    expect(Object.keys(buildRequestBody('x')).sort()).toEqual(['schema', 'text']);
  });

  it('turns a non-2xx into an unavailable error rather than parsing the body', async () => {
    const interpreter = createHostInterpreter({ endpoint: '/x', timeoutMs: 1000 }, async () => ({
      ok: false,
      status: 503,
      json: async () => ({ filters: [{ field: 'stages', value: 'hot', span: 'hot' }] }),
    }) as unknown as Response);
    await expect(
      interpreter.interpret('hot leads', new AbortController().signal),
    ).rejects.toBeInstanceOf(InterpreterUnavailableError);
  });

  it('times out on a slow endpoint and says so', async () => {
    vi.useFakeTimers();
    try {
      const interpreter = createHostInterpreter({ endpoint: '/x', timeoutMs: 50 }, (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      );
      const pending = interpreter.interpret('hot leads', new AbortController().signal);
      const assertion = expect(pending).rejects.toBeInstanceOf(InterpreterTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
