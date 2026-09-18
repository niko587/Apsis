/**
 * A JSON Schema validator small enough to read in one sitting.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY: Autopilot must add no runtime
 * dependency to Apsis, and the schemas it validates are ones this repository
 * wrote. A 120-line validator that supports exactly the keywords those schemas
 * use is auditable; a general-purpose validator is a supply-chain surface for a
 * developer tool that holds an API key.
 *
 * WHY IT EXISTS AT ALL, given the provider enforces `strict: true`: because
 * "the provider enforced it" is a claim made by the thing being validated. A
 * proxy, a model change, a truncated response or a future API revision all
 * produce bytes that arrive looking like an answer. The controller acts on this
 * data — it creates branches from it — so it checks the data itself.
 */

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const matchesType = (value, type) => {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
};

/**
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(value, schema, path = '$') {
  const errors = [];
  walk(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') {
    errors.push(`${path}: no schema`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return; // Everything below assumes the type held.
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }

  if (schema.type === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (schema.type === 'array') {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors));
    }
  }

  if (schema.type === 'object') {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}: missing "${required}"`);
    }
    // `additionalProperties: false` is not decoration. An unexpected key is how
    // a model smuggles an instruction into a structure the controller trusts.
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of keys) {
        if (!known.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) walk(value[key], sub, `${path}.${key}`, errors);
    }
  }
}

/**
 * The schema subset the OpenAI Responses API accepts with `strict: true` is
 * narrower than the subset this validator understands, so the schemas sent to
 * the model are stripped of the local-only keywords rather than being written
 * twice and drifting apart.
 */
const MODEL_ONLY_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
]);

export function forModel(schema) {
  if (Array.isArray(schema)) return schema.map(forModel);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!MODEL_ONLY_KEYWORDS.has(key)) continue;
    out[key] = key === 'properties' ? mapValues(value, forModel) : forModel(value);
  }
  return out;
}

const mapValues = (obj, fn) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
