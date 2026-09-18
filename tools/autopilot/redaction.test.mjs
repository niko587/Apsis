/**
 * Tests 9 and 10: secrets do not leave, in either direction.
 *
 * The values below are FAKE — invented strings shaped like credentials. No real
 * key appears in this repository, and none ever should.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, redactDeep, assertNoSecrets, PLACEHOLDER } from './redaction.mjs';
import { describeConfig, loadConfig } from './config.mjs';
import { buildWorkerPrompt } from './worker-prompt.mjs';
import { validSpec } from './schemas.test.mjs';

const FAKE_OPENAI = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_ANTHROPIC = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FAKE_GITHUB = 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const FAKE_WORKOS = 'sk_test_DDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const FAKE_ODD = 'zz-this-format-nobody-knows-9182736455';

test('9. credential-shaped strings are redacted by shape alone', () => {
  for (const secret of [FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_GITHUB, FAKE_WORKOS]) {
    const out = redact(`the log said: ${secret} and then continued`);
    assert.ok(!out.includes(secret), `${secret.slice(0, 8)}… survived`);
    assert.ok(out.includes(PLACEHOLDER));
  }
});

test('9. a bearer header and a PEM block are redacted', () => {
  assert.ok(!redact(`authorization: Bearer ${FAKE_OPENAI}`).includes(FAKE_OPENAI));
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.ok(!redact(`key:\n${pem}`).includes('MIIEow'));
});

test('9. a secret in an UNKNOWN format is still redacted, by identity', () => {
  // The case shape-matching cannot catch: a credential this file has never seen
  // the format of. It is caught because the process knows its own env values.
  const env = { SOME_VENDOR_API_KEY: FAKE_ODD };
  const out = redact(`config dump: SOME_VENDOR_API_KEY=${FAKE_ODD}`, { env });
  assert.ok(!out.includes(FAKE_ODD));
});

test('9. a short env value is not treated as a secret', () => {
  const env = { NODE_ENV_TOKEN: 'dev' };
  assert.equal(redact('running in dev mode', { env }), 'running in dev mode');
});

test('9. an assignment to an unknown-format value is redacted', () => {
  const out = redact('api_key: "abcdefghijklmnop"');
  assert.ok(!out.includes('abcdefghijklmnop'));
});

test('9. overlapping secrets are redacted longest-first, leaving no tail', () => {
  const short = 'AAAAAAAAAAAAAAAA';
  const long = `${short}BBBBBBBBBBBBBBBB`;
  const env = { A_TOKEN: short, B_TOKEN: long };
  const out = redact(`value=${long}`, { env });
  assert.ok(!out.includes(short), `a tail survived: ${out}`);
  assert.ok(!out.includes('BBBB'));
});

test('9. redactDeep blanks secret-named keys and scrubs nested strings', () => {
  const record = {
    ok: true,
    apiKey: FAKE_OPENAI,
    nested: { note: `used ${FAKE_GITHUB}`, list: [`x ${FAKE_ANTHROPIC}`] },
  };
  const out = redactDeep(record);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(FAKE_OPENAI));
  assert.ok(!text.includes(FAKE_GITHUB));
  assert.ok(!text.includes(FAKE_ANTHROPIC));
  assert.equal(out.ok, true, 'non-secret data survives');
});

test('9. the describable config never contains the key', () => {
  const config = loadConfig({ env: { OPENAI_API_KEY: FAKE_OPENAI }, cwd: process.cwd() });
  assert.equal(config.hasApiKey, true);
  assert.equal(config.readApiKey(), FAKE_OPENAI, 'readable when explicitly asked');

  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes(FAKE_OPENAI));
  assert.match(described, /"apiKey":"present"/);

  // And it does not leak through an accidental serialisation of the config.
  assert.ok(!JSON.stringify(config).includes(FAKE_OPENAI));
});

test('10. no secret value enters a generated worker prompt', () => {
  const env = { OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC };
  const prompt = buildWorkerPrompt({
    taskSpec: validSpec(),
    baseSha: 'abc123',
    branch: 'autopilot/task-0001-x',
    worktreePath: '/tmp/wt',
    projectNotes: `a note that wrongly quotes ${FAKE_OPENAI}`,
  });
  assert.ok(!prompt.includes(FAKE_OPENAI));
  assert.doesNotThrow(() => assertNoSecrets(prompt, { env }));
});

test('10. assertNoSecrets ABORTS rather than scrubbing, when a secret reaches a prompt', () => {
  // Deliberate: silently scrubbing here would conceal a packet-builder bug that
  // read a file it should never have opened.
  const env = { OPENAI_API_KEY: FAKE_OPENAI };
  assert.throws(
    () => assertNoSecrets(`please use ${FAKE_OPENAI}`, { env }),
    /refusing to send 1 secret value/,
  );
});

test('10. assertNoSecrets passes clean text through unchanged', () => {
  const text = 'a perfectly ordinary planner packet';
  assert.equal(assertNoSecrets(text, { env: { OPENAI_API_KEY: FAKE_OPENAI } }), text);
});
