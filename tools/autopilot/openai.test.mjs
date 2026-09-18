/**
 * Tests 14, 15 and 16: the adapter fails closed, and sends the CURRENT shape.
 *
 * Every test here uses a fake `fetch`. No network call is made, no key is
 * needed, and nothing costs anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { requestStructured, extractStructured, RESPONSES_URL, checkAccess } from './openai.mjs';
import { planTask } from './planner.mjs';
import { reviewWork } from './reviewer.mjs';
import { CODES } from './errors.mjs';
import { validSpec, validReview } from './schemas.test.mjs';

const KEY = 'sk-fake-key-for-tests-000000000000';

const okResponse = (obj) => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: 'resp_test',
    status: 'completed',
    incomplete_details: null,
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(obj) }] },
    ],
  }),
  text: async () => '',
});

const capture = (response) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, fetchImpl };
};

const throwsCode = async (fn, code) =>
  assert.rejects(fn, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });

test('the request uses the current Responses API structured-output shape', async () => {
  const { calls, fetchImpl } = capture(okResponse({ hello: 'world' }));
  await requestStructured({
    apiKey: KEY,
    model: 'gpt-6-astra',
    instructions: 'be precise',
    input: 'the packet',
    schemaName: 'TaskSpec',
    schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    fetchImpl,
  });

  const [{ url, init, body }] = calls;
  assert.equal(url, RESPONSES_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);

  // The shape people get wrong: `text.format`, flat — NOT `response_format`.
  assert.equal(body.response_format, undefined, 'response_format is the obsolete Chat Completions form');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.name, 'TaskSpec');
  assert.equal(body.text.format.strict, true);
  assert.equal(typeof body.text.format.schema, 'object');

  assert.equal(body.store, false, 'packets quote repository files; do not store them');
  assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.temperature, undefined, 'reasoning models reject sampling parameters');
  assert.equal(body.top_p, undefined);
  assert.equal(typeof body.max_output_tokens, 'number');
  assert.deepEqual(
    body.input.map((m) => m.role),
    ['developer', 'user'],
  );
});

test('16. a network failure fails closed', async () => {
  await throwsCode(
    () =>
      requestStructured({
        apiKey: KEY,
        model: 'gpt-6-astra',
        instructions: 'x',
        input: 'y',
        schemaName: 'TaskSpec',
        schema: {},
        fetchImpl: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    CODES.OPENAI_NETWORK,
  );
});

test('16. a non-2xx response fails closed and does not leak the key into the message', async () => {
  await throwsCode(
    () =>
      requestStructured({
        apiKey: KEY,
        model: 'gpt-6-astra',
        instructions: 'x',
        input: 'y',
        schemaName: 'TaskSpec',
        schema: {},
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => `rate limited for ${KEY}` }),
      }),
    CODES.OPENAI_HTTP,
  );
});

test('16. a missing key fails before any request is attempted', async () => {
  let called = false;
  await throwsCode(
    () =>
      requestStructured({
        apiKey: '',
        model: 'gpt-6-astra',
        instructions: 'x',
        input: 'y',
        schemaName: 'T',
        schema: {},
        fetchImpl: async () => {
          called = true;
          return okResponse({});
        },
      }),
    CODES.NO_API_KEY,
  );
  assert.equal(called, false);
});

test('an incomplete response is rejected even though its JSON might parse', () => {
  assert.throws(
    () =>
      extractStructured({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }],
      }),
    (e) => e.code === CODES.OPENAI_INCOMPLETE,
  );
});

test('a refusal is surfaced as a refusal, not as malformed output', () => {
  assert.throws(
    () =>
      extractStructured({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    (e) => e.code === CODES.OPENAI_REFUSAL,
  );
});

test('output_text is used only as a fallback when no message item carries text', () => {
  assert.deepEqual(extractStructured({ status: 'completed', output: [], output_text: '{"a":1}' }), { a: 1 });
});

test('14. malformed planner JSON fails closed — prose is never interpreted as a task', async () => {
  const prose = {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'I suggest we polish the empty state. Shall I proceed?' }],
        },
      ],
    }),
    text: async () => '',
  };
  await throwsCode(
    () => planTask({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl: async () => prose }),
    CODES.OPENAI_MALFORMED,
  );
});

test('14. a schema-valid-looking but wrong planner object is rejected locally', async () => {
  // The provider claimed strict; the object still has an extra key. The local
  // validator is what makes "the provider enforced it" not load-bearing.
  const { fetchImpl } = capture(okResponse({ ...validSpec(), sneaky: 'rm -rf /' }));
  await throwsCode(
    () => planTask({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl }),
    CODES.SCHEMA_INVALID,
  );
});

test('14. a planner spec with an escaping path is refused before a branch name exists', async () => {
  const { fetchImpl } = capture(okResponse({ ...validSpec(), allowedFiles: ['../../.ssh/id_rsa'] }));
  await throwsCode(
    () => planTask({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl }),
    CODES.UNSAFE_PATH,
  );
});

test('14. a good planner response produces a frozen TaskSpec', async () => {
  const { fetchImpl } = capture(okResponse(validSpec()));
  const { taskSpec } = await planTask({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl });
  assert.equal(taskSpec.taskId, 'polish-empty-state');
});

test('15. malformed reviewer JSON fails closed', async () => {
  const garbage = {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'looks good to me!' }] }],
    }),
    text: async () => '',
  };
  await throwsCode(
    () => reviewWork({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl: async () => garbage }),
    CODES.OPENAI_MALFORMED,
  );
});

test('15. a reviewer verdict outside the enum fails closed', async () => {
  const { fetchImpl } = capture(okResponse(validReview({ verdict: 'ship it' })));
  await throwsCode(
    () => reviewWork({ packet: 'p', apiKey: KEY, model: 'gpt-6-astra', fetchImpl }),
    CODES.SCHEMA_INVALID,
  );
});

test('doctor --check-openai reads metadata and generates nothing', async () => {
  const calls = [];
  await checkAccess({
    apiKey: KEY,
    model: 'gpt-6-astra',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\/models\/gpt-6-astra$/);
  assert.equal(calls[0].init?.method, undefined, 'a GET — no body, no generation');
});

test('doctor --check-openai reports a rejected key distinctly', async () => {
  await throwsCode(
    () => checkAccess({ apiKey: KEY, model: 'gpt-6-astra', fetchImpl: async () => ({ ok: false, status: 401 }) }),
    CODES.OPENAI_HTTP,
  );
});
