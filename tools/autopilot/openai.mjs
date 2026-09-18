/**
 * The OpenAI adapter. One file, raw `fetch`, no SDK.
 *
 * Endpoint: POST https://api.openai.com/v1/responses — the Responses API.
 *
 * The request shape below is the CURRENT one and differs from the older Chat
 * Completions form in the place people most often get wrong: structured output
 * is configured under `text.format` as a flat
 * `{type:'json_schema', name, strict, schema}`, NOT under
 * `response_format.json_schema.{name,schema,strict}`. Getting this wrong does
 * not error loudly — it degrades to freeform prose that then has to be guessed
 * at, which is exactly the failure mode this controller must not have.
 *
 * Also deliberate:
 *   - `store: false` — planning packets quote repository files; there is no
 *     reason for them to persist on a vendor's side.
 *   - `reasoning.effort` set, `temperature`/`top_p` NOT sent. Reasoning models
 *     reject sampling parameters, and Apsis already learned that lesson once
 *     (D32) when `temperature: 0` made a model switch a hard 400.
 *   - `max_output_tokens` — a bound, so a runaway generation is a failed call
 *     rather than a bill.
 */

import { CODES, fail } from './errors.mjs';
import { redact } from './redaction.mjs';

export const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.instructions  developer-role message
 * @param {string} opts.input         user-role message
 * @param {string} opts.schemaName
 * @param {object} opts.schema        already stripped to the strict subset
 * @param {'low'|'medium'|'high'} [opts.reasoningEffort]
 * @param {number} [opts.maxOutputTokens]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{data: object, raw: object}>}
 */
export async function requestStructured({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  reasoningEffort = 'high',
  maxOutputTokens = 16_000,
  timeoutMs = 300_000,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    fail(CODES.NO_API_KEY, 'OPENAI_API_KEY is not set in this shell');
  }

  const body = {
    model,
    input: [
      { role: 'developer', content: instructions },
      { role: 'user', content: input },
    ],
    store: false,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: maxOutputTokens,
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // Network failure, DNS, timeout, abort. Fail closed: there is no partial
    // plan and no partial review.
    fail(CODES.OPENAI_NETWORK, `OpenAI request failed: ${redact(error?.message ?? String(error))}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    fail(
      CODES.OPENAI_HTTP,
      `OpenAI returned ${response.status}: ${redact(text).slice(0, 600)}`,
      { status: response.status },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(CODES.OPENAI_MALFORMED, 'OpenAI response body was not JSON');
  }

  return { data: extractStructured(payload), raw: payload };
}

/**
 * Pull the single JSON object out of a Responses payload.
 *
 * Walks `output[]` rather than reading `output_text`: that convenience property
 * is an SDK affordance and is not guaranteed on the raw HTTP body. It is used
 * only as a fallback.
 */
export function extractStructured(payload) {
  if (!payload || typeof payload !== 'object') {
    fail(CODES.OPENAI_MALFORMED, 'OpenAI response was not an object');
  }

  // An incomplete response is a truncated one. Its JSON may even parse — which
  // is precisely why the status is checked before the content.
  if (payload.status && payload.status !== 'completed') {
    fail(
      CODES.OPENAI_INCOMPLETE,
      `OpenAI response status "${payload.status}"${
        payload.incomplete_details?.reason ? ` (${payload.incomplete_details.reason})` : ''
      }`,
    );
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'refusal') {
        fail(CODES.OPENAI_REFUSAL, `model refused: ${redact(part.refusal ?? '').slice(0, 400)}`);
      }
    }
  }

  let text = null;
  for (const item of output) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        text = text === null ? part.text : text + part.text;
      }
    }
  }
  if (text === null && typeof payload.output_text === 'string') text = payload.output_text;

  if (text === null || text.trim() === '') {
    fail(CODES.OPENAI_MALFORMED, 'OpenAI response carried no output text');
  }

  try {
    return JSON.parse(text);
  } catch {
    // Prose where an object was demanded. NEVER interpreted — a planner that
    // describes a task in English is a failed planner call, not a task.
    fail(CODES.OPENAI_MALFORMED, `OpenAI output was not valid JSON: ${redact(text).slice(0, 300)}`);
  }
}

/**
 * The only call `doctor --check-openai` makes. Listing models is a metadata
 * read: it proves the key works and the model name exists without generating
 * a single output token.
 */
export async function checkAccess({ apiKey, model, fetchImpl = globalThis.fetch }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    fail(CODES.NO_API_KEY, 'OPENAI_API_KEY is not set in this shell');
  }
  let response;
  try {
    response = await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    fail(CODES.OPENAI_NETWORK, `could not reach OpenAI: ${redact(error?.message ?? String(error))}`);
  }
  if (response.status === 401 || response.status === 403) {
    fail(CODES.OPENAI_HTTP, `OpenAI rejected the key (${response.status})`, { status: response.status });
  }
  if (!response.ok) {
    fail(CODES.OPENAI_HTTP, `model "${model}" is not available to this key (${response.status})`, {
      status: response.status,
    });
  }
  return { ok: true, model };
}
