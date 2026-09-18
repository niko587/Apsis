/**
 * The environment child processes get — and the credentials they do not.
 *
 * THE DEFECT THIS EXISTS FOR: both child spawns used `env: process.env`. The
 * Claude worker therefore received `OPENAI_API_KEY`, and so did every gate,
 * which means model-written test or build code could read it. Autopilot's whole
 * premise is that two providers do different jobs behind a controller; handing
 * one provider's key to the other's process dissolves that separation in the
 * most ordinary way imaginable — by inheritance, silently, with nothing in the
 * code saying so.
 *
 * It is not only about OpenAI. The owner's shell is where `GITHUB_TOKEN`,
 * `WORKOS_API_KEY`, npm auth tokens and AWS credentials live. A coding agent
 * and a test suite have no business reading any of them, and "it did not occur
 * to me to use them" is not a security property.
 *
 * THE SHAPE OF THE FIX: deny by name, then deny by value. Names are removed
 * when they look secret-shaped, which catches the ordinary cases. Values are
 * then removed when they match a credential shape or exactly equal one of this
 * process's own secrets — which catches `FOO=sk-proj-…`, a variable whose name
 * gives nothing away.
 *
 * Deny-list rather than allow-list, deliberately. An allow-list of environment
 * variables sounds stricter and is: it is also how you discover in production
 * that `npm` needed `npm_config_cache`, that `git` needed `SSH_AUTH_SOCK`, or
 * that Playwright needed `PLAYWRIGHT_BROWSERS_PATH`. The thing being protected
 * here is credentials, and credentials are exactly the population a name-and-
 * value filter describes well.
 */

/**
 * Names whose values never reach a child. Substring match, case-insensitive.
 *
 * `AUTH` is included for `npm_config_//registry.npmjs.org/:_authToken` and its
 * relatives. `SSH_AUTH_SOCK` is exempted below: it is a socket path, not a
 * credential, and git needs it to talk to a remote.
 */
export const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE_PASSWORD|AUTH|PRIVATE|SESSION)/i;

/**
 * Names that match the pattern above but are not credentials. Kept short and
 * explicit: every entry here is a hole, and each one should be arguable.
 */
export const NAME_EXEMPTIONS = new Set([
  'SSH_AUTH_SOCK', // a unix socket path; git needs it, and it is not a secret
  'XPC_SERVICE_NAME', // macOS launchd noise
]);

/** Values that are credential-shaped regardless of what the variable is called. */
const VALUE_SHAPES = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^sk_(test|live)_[A-Za-z0-9]{16,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const MIN_SECRET_LENGTH = 8;

/**
 * The one narrowly-named opt-in.
 *
 * v1 assumes Claude Code is authenticated the normal way — the stored login the
 * owner already uses in their terminal. Some installations instead carry
 * `ANTHROPIC_API_KEY` in the environment. Passing *every* secret through to
 * make that work would be absurd, so exactly one variable can be re-admitted,
 * and only when the owner says so by name. Setting it is a deliberate act with
 * a documented consequence, which is the difference between a decision and an
 * accident.
 */
export const ANTHROPIC_OPT_IN = 'APSIS_AUTOPILOT_PASS_ANTHROPIC_KEY';

/**
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.source] environment to filter
 * @param {Record<string,string>} [options.add] variables to set afterwards
 * @param {boolean} [options.allowAnthropicKey] honour the opt-in above
 * @returns {{env: Record<string,string>, removed: string[]}}
 *   `removed` is a list of NAMES. It never contains a value, and it is what the
 *   run record may hold.
 */
export function sanitizedChildEnv({ source = process.env, add = {}, allowAnthropicKey = false } = {}) {
  const ownSecrets = new Set(
    Object.entries(source)
      .filter(([name, value]) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name) && !NAME_EXEMPTIONS.has(name))
      .map(([, value]) => value),
  );

  const env = {};
  const removed = [];

  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;

    if (SECRET_NAME.test(name) && !NAME_EXEMPTIONS.has(name)) {
      removed.push(name);
      continue;
    }
    // A variable with an innocuous name holding a credential-shaped value. This
    // is the case a name filter alone misses entirely.
    if (value.length >= MIN_SECRET_LENGTH && VALUE_SHAPES.some((re) => re.test(value))) {
      removed.push(name);
      continue;
    }
    // …and the case where the value is, byte for byte, one of this process's
    // own secrets, in a format nobody here has heard of.
    if (ownSecrets.has(value)) {
      removed.push(name);
      continue;
    }

    env[name] = value;
  }

  if (allowAnthropicKey && typeof source.ANTHROPIC_API_KEY === 'string' && source.ANTHROPIC_API_KEY !== '') {
    env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  }

  // The controller's own knobs are never part of a child's world, whether or
  // not they look secret-shaped.
  for (const name of Object.keys(env)) {
    if (name.startsWith('APSIS_AUTOPILOT_') || name.startsWith('OPENAI_')) {
      delete env[name];
      removed.push(name);
    }
  }

  return { env: { ...env, ...add }, removed: [...new Set(removed)].sort() };
}

/** Environment for the Claude worker. */
export const workerEnv = (options = {}) =>
  sanitizedChildEnv({
    ...options,
    allowAnthropicKey: (options.source ?? process.env)[ANTHROPIC_OPT_IN] === '1',
  });

/**
 * Environment for a gate subprocess.
 *
 * `CI=1` and `FORCE_COLOR=0` are added for the same reason they always were:
 * deterministic, non-interactive, unstyled output that a repair prompt can
 * quote. They are ordinary configuration, not credentials.
 */
export const gateEnv = (options = {}) =>
  sanitizedChildEnv({ ...options, add: { CI: '1', FORCE_COLOR: '0', ...(options.add ?? {}) } });
