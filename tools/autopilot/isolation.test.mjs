/**
 * Test 20, plus the rest of the root-project protection (B22).
 *
 * The claim being defended: Autopilot is developer tooling that happens to live
 * in this repository, and Apsis cannot tell it is here. Nothing under src/,
 * server/ or api/ references it; no browser bundle contains its policy text,
 * its model names, or the string OPENAI_API_KEY.
 *
 * The source-graph half runs always. The bundle half runs when dist/ exists —
 * which it does after `npm run build`, i.e. on every full gate run and in CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKET_FILES } from './context.mjs';
import { ALWAYS_FORBIDDEN } from './boundaries.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
};

/** Strings that would prove Autopilot leaked into the product. */
const MARKERS = ['OPENAI_API_KEY', 'gpt-6-astra', 'tools/autopilot', 'OPENAI_AUTOPILOT_MODEL', 'APSIS_AUTOPILOT_CLAUDE_MODEL'];

/**
 * Test files are excluded, and the exclusion is the point rather than a
 * loophole: `server/secrets.test.ts` exists precisely to assert that
 * OPENAI_API_KEY does NOT appear in src/**, and a test that checks for a name
 * has to be able to write the name. Test files are not bundled either, so the
 * property that matters — nothing reaches the browser — is asserted against
 * dist/ below.
 */
const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/.test(file);

test('20. no Apsis runtime source references Autopilot or any OpenAI credential', () => {
  const runtime = ['src', 'server', 'api']
    .flatMap((dir) => walk(path.join(root, dir)))
    .filter((f) => !isTestFile(f));
  assert.ok(runtime.length > 0, 'expected to find Apsis runtime sources');

  const offenders = [];
  for (const file of runtime) {
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of MARKERS) {
      if (text.includes(marker)) offenders.push(`${path.relative(root, file)} → ${marker}`);
    }
  }
  assert.deepEqual(offenders, [], `Autopilot leaked into Apsis runtime code:\n${offenders.join('\n')}`);
});

test('20. no Apsis runtime source imports anything from tools/', () => {
  const runtime = ['src', 'server', 'api']
    .flatMap((dir) => walk(path.join(root, dir)))
    .filter((f) => !isTestFile(f));
  const offenders = runtime.filter((file) =>
    /(?:from|import|require)\s*\(?\s*['"][^'"]*tools\//.test(fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});

test('20. the production bundle contains no Autopilot marker', (t) => {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) {
    t.skip('dist/ not built — run `npm run build` (the full gate run always does)');
    return;
  }
  const files = walk(dist).filter((f) => /\.(js|mjs|cjs|css|html|json|map)$/.test(f));
  assert.ok(files.length > 0, 'dist/ exists but is empty');

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of MARKERS) {
      if (text.includes(marker)) offenders.push(`${path.relative(root, file)} → ${marker}`);
    }
    if (text.includes('Apsis Autopilot')) offenders.push(`${path.relative(root, file)} → policy text`);
  }
  assert.deepEqual(offenders, [], `Autopilot reached the browser bundle:\n${offenders.join('\n')}`);
});

test('20. Autopilot adds no dependency to the root project', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const all = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];

  // Every package Autopilot would plausibly have reached for. It reached for
  // none of them: an OpenAI SDK, a dotenv loader, a JSON-schema validator, an
  // arg parser and a process runner are all written here against Node built-ins
  // instead, because this tool holds an API key and its dependency surface is
  // part of its threat model.
  const autopilotish = all.filter((d) =>
    /^(openai|@openai\/|@anthropic-ai\/|dotenv|ajv|zod|commander|yargs|minimist|execa|node-fetch|axios)/i.test(d),
  );
  assert.deepEqual(autopilotish, [], 'Autopilot must run on Node built-ins alone');

  // The one runtime dependency Apsis has is the pre-existing auth SDK (D41).
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@react-three/')).sort(), [
    '@workos-inc/node',
    'postprocessing',
    'react',
    'react-dom',
    'three',
    'zustand',
  ]);
});

test('20. Autopilot imports nothing outside node: builtins and its own directory', () => {
  const files = walk(here).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
      if (!ok) offenders.push(`${path.basename(file)} → ${spec}`);
      if (spec.startsWith('../') && !spec.startsWith('./')) offenders.push(`${path.basename(file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `unexpected import:\n${offenders.join('\n')}`);
});

test('the runtime directory is gitignored, so run records cannot be committed', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.apsis-autopilot\/?$/m);
  assert.match(ignore, /^\.env\.autopilot$/m, 'a local autopilot env file must be ignored');
});

test('no real credential is committed anywhere in tools/autopilot', () => {
  for (const file of walk(here)) {
    const text = fs.readFileSync(file, 'utf8');
    // The test fixtures use obviously-fake repeated-letter values; a real key
    // would not look like that. This catches an accidental paste.
    for (const [match] of text.matchAll(/\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/g)) {
      const body = match.replace(/^sk-(ant-)?/, '');
      const distinct = new Set(body.replace(/[^A-Za-z0-9]/g, '')).size;
      assert.ok(
        distinct <= 12 || /fake|test|example|AAAA|BBBB|CCCC|DDDD/i.test(match),
        `${path.relative(root, file)} contains something that looks like a real key`,
      );
    }
  }
});

test('the .env example names variables and gives no values', () => {
  const example = fs.readFileSync(path.join(here, '.env.example'), 'utf8');
  assert.match(example, /^OPENAI_API_KEY=$/m, 'the key line must be empty');
  assert.ok(!/^VITE_/m.test(example), 'no VITE_-prefixed credential may exist, ever');
  for (const line of example.split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const [name, value] = line.split('=');
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(name)) {
      assert.equal(value.trim(), '', `${name} must have no value in the example file`);
    }
  }
});

test('the context packet reads an allow-list, and .env is not on it', () => {
  for (const file of PACKET_FILES) {
    assert.ok(!file.includes('.env'), `${file} must never be in the packet`);
    assert.ok(!file.startsWith('/') && !file.includes('..'), `${file} must be repo-relative`);
  }
  // And the tool cannot be edited by a task it plans.
  assert.ok(ALWAYS_FORBIDDEN.includes('tools/autopilot/**'));
  assert.ok(ALWAYS_FORBIDDEN.includes('.env'));
});
