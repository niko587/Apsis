/**
 * Redaction, applied on the way OUT of the process — to run records, to logs,
 * to anything printed — and on the way IN to a prompt.
 *
 * The threat is not a model that asks for a key. It is the ordinary path: a
 * gate prints an environment dump, a stack trace includes a URL with a token, a
 * worker echoes a config file. Those land in `.apsis-autopilot/runs/…`, which
 * lives inside the repository, and the next planner packet reads project files.
 * That is how a secret makes one hop and becomes committed.
 *
 * Two layers, because either alone is insufficient:
 *   1. shape — patterns that look like credentials regardless of provenance;
 *   2. identity — the exact values of this process's own secret-shaped env
 *      vars, which catches a key whose format this file has never heard of.
 */

export const PLACEHOLDER = '[REDACTED]';

/** Names whose VALUES must never appear in output, whatever they look like. */
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE_PASSWORD)/i;

/** Short values are excluded: "1", "true", "dev" are not credentials. */
const MIN_SECRET_LENGTH = 8;

const SHAPES = [
  // OpenAI, current and legacy project/user forms.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Anthropic.
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  // GitHub.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // Slack.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key id, and anything following a secret-ish assignment.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer headers.
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // WorkOS.
  /\bsk_(?:test|live)_[A-Za-z0-9]{16,}/g,
];

/** `FOO_API_KEY=abcdef…` / `"apiKey": "abcdef…"` — assignment, any format. */
const ASSIGNMENT =
  /((?:api[_-]?key|apikey|secret|token|password|passwd|credential)["'\s]*[:=]\s*["']?)([A-Za-z0-9._~+/-]{8,})/gi;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The exact values of this process's secret-shaped environment variables.
 * Computed per call rather than cached, so a value set after import is still
 * caught.
 */
function envSecrets(env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    values.push(value);
  }
  // Longest first: redacting a prefix before its longer superstring would leave
  // the tail of the longer secret in place.
  return values.sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} input
 * @param {{env?: Record<string,string|undefined>, extra?: string[]}} [options]
 * @returns {string}
 */
export function redact(input, { env = process.env, extra = [] } = {}) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : String(input);

  for (const secret of [...envSecrets(env), ...extra.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)]) {
    text = text.split(secret).join(PLACEHOLDER);
  }
  for (const shape of SHAPES) text = text.replace(shape, PLACEHOLDER);
  text = text.replace(ASSIGNMENT, (_m, lead) => `${lead}${PLACEHOLDER}`);

  return text;
}

/** Deep-redact a structure destined for a run record. */
export function redactDeep(value, options) {
  if (typeof value === 'string') return redact(value, options);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_NAME.test(k) ? PLACEHOLDER : redactDeep(v, options)]),
    );
  }
  return value;
}

/**
 * A guard for the one direction redaction cannot fix after the fact.
 *
 * Prompts are built from repository files and command output. If a secret ever
 * reaches this point the answer is to abort, not to scrub — scrubbing would
 * hide the fact that the packet builder read something it should not have.
 */
export function assertNoSecrets(text, { env = process.env } = {}) {
  const found = envSecrets(env).filter((s) => text.includes(s));
  if (found.length > 0) {
    throw new Error(
      `refusing to send ${found.length} secret value(s) to a model — the context packet read something it should not have`,
    );
  }
  return text;
}

export const __test = { envSecrets, escapeRe };
