/**
 * The model provider. One interface, one implementation, no SDK.
 *
 * Anthropic's Messages API is a single POST, so `fetch` is the whole client.
 * That keeps D27's invariant — "no LLM SDK may enter package.json" — true
 * without an exception for the server, adds no dependency around a credential,
 * and means swapping providers is writing one more function with two methods.
 *
 * NOTHING FROM A VENDOR REACHES THE BROWSER. Errors are collapsed into a small
 * set of safe codes here, at the boundary, rather than being passed upward and
 * filtered later: a vendor message can carry account identifiers, model names,
 * quota details and occasionally a fragment of the request, and the caller
 * should not have to remember to strip them.
 */

import { TOOL_NAME, buildSystemPrompt, buildUserContent, interpretationTool } from './prompt';

/** Small on purpose. A second provider is a second file, not a registry. */
export interface ModelProvider {
  readonly name: string;
  /** The model's tool-call payload, as UNKNOWN. Throws `ProviderError` otherwise. */
  interpret(text: string, signal: AbortSignal): Promise<unknown>;
}

export type ProviderErrorCode =
  | 'provider_unconfigured'
  | 'provider_failed'
  | 'provider_unusable';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode) {
    // The message is the code. There is nothing else in here to leak.
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}

/**
 * Default model.
 *
 * The task is one sentence in and a small constrained object out, over a closed
 * vocabulary handed to the model in full — it wants reliable structured output,
 * strong instruction following and low latency inside a 4s client budget, not
 * frontier reasoning. `APSIS_MODEL` escalates without a code change.
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

/**
 * The Messages API request. **No sampling parameters, on any model.**
 *
 * This used to send `temperature: 0` for determinism. Claude Sonnet 5 — the
 * documented escalation path for `APSIS_MODEL` — returns a **400** for
 * `temperature`, `top_p` or `top_k` set to non-default values, so the escalation
 * path was a hard break: a one-variable change would have turned every command
 * into a 502 and silently demoted every user to the grammar.
 *
 * Omitting them is the fix, and it is deliberately not a model capability
 * table. A branch keyed on model id has to be updated for every future model,
 * fails closed only if someone remembers, and the failure mode is a 400 in
 * production rather than a test. Sending nothing is valid on every model —
 * each simply uses its own default — so there is no decision left to get wrong.
 *
 * What determinism was buying is already bought structurally: forced tool use
 * fixes the shape, the enum fixes the field names, and the browser validator
 * fixes what may reach `LeadQuery`. A slightly different paraphrase mapping the
 * same way twice was never a guarantee this design relied on.
 *
 * NOT EVERY MODEL ACCEPTS FORCED TOOL USE. `tool_choice: {type:'tool'}` returns
 * 400 on Claude Fable 5.1 and Mythos 5.1, and on manual extended thinking.
 * Adaptive-thinking models (Sonnet 5, Opus 5) accept it. `APSIS_MODEL` is free
 * text, so this is a real deployment footgun and it is called out in the README
 * rather than defended against with another capability table.
 */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  tools: Array<ReturnType<typeof interpretationTool>>;
  tool_choice: { type: 'tool'; name: string };
}

export function buildMessagesRequest(model: string, text: string): MessagesRequest {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserContent(text) }],
    tools: [interpretationTool()],
    // The structural constraint. A model that must call this tool cannot answer
    // in prose, and cannot invent a field name.
    tool_choice: { type: 'tool', name: TOOL_NAME },
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
}

export function createAnthropicProvider(config: AnthropicConfig): ModelProvider {
  const model = config.model || DEFAULT_MODEL;

  return {
    name: 'anthropic',
    async interpret(text: string, signal: AbortSignal): Promise<unknown> {
      const doFetch = config.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
      if (!doFetch) throw new ProviderError('provider_unconfigured');

      let response: Response;
      try {
        response = await doFetch(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': API_VERSION,
          },
          signal,
          body: JSON.stringify(buildMessagesRequest(model, text)),
        });
      } catch (error) {
        // Abort belongs to the caller and must stay distinguishable from a
        // failure — the handler decides whether that was a timeout or a user
        // who moved on.
        if (signal.aborted) throw error;
        throw new ProviderError('provider_failed');
      }

      if (!response.ok) {
        // Deliberately not reading the body. A vendor error body is exactly the
        // kind of thing that ends up in a log or a response by accident.
        throw new ProviderError('provider_failed');
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError('provider_unusable');
      }

      return extractToolInput(payload);
    },
  };
}

/**
 * Pull the tool call out of a Messages response.
 *
 * No prose salvage. If the model did not call the tool, there is no
 * interpretation — inventing one from free text is precisely the behaviour
 * forced tool use exists to prevent.
 */
export function extractToolInput(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') throw new ProviderError('provider_unusable');
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new ProviderError('provider_unusable');

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'tool_use' && b.name === TOOL_NAME) {
      if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) {
        throw new ProviderError('provider_unusable');
      }
      return b.input;
    }
  }
  throw new ProviderError('provider_unusable');
}

/**
 * Build the provider from the environment, or report that there is none.
 *
 * A missing key is `null` — never a call without credentials, never a silent
 * success. The handler turns that into a 502 and the browser falls back to its
 * grammar, which is the correct behaviour for a misconfigured deployment.
 */
export function providerFromEnv(
  env: Record<string, string | undefined> = process.env,
): ModelProvider | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return null;
  return createAnthropicProvider({ apiKey, model: env.APSIS_MODEL });
}
