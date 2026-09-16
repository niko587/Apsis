/**
 * The host boundary, checked against what actually ships.
 *
 * `server/secrets.test.ts` proves no client SOURCE can name a credential. This
 * proves it about the built bytes, and proves the activation path works — that
 * `public/apsis-config.js` is genuinely how a host turns the interpreter on,
 * rather than a file we believe would work.
 *
 * It lives in the Playwright suite because `npm run test:e2e` builds first, so
 * these run against a fresh `dist/` every time instead of whenever someone
 * happened to build last.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'dist');

/**
 * Matched on WORD BOUNDARIES where the needle is an identifier.
 *
 * A substring scan flagged the shipped bundle for `APSIS_MODEL` because it
 * contains `__APSIS_MODEL_ENV__` — the §37 host-declared browser global, which
 * is not a credential and merely shares characters with one. A scan that cries
 * wolf is a scan somebody turns off.
 */
const FORBIDDEN: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['ANTHROPIC_API_KEY', /\bANTHROPIC_API_KEY\b/],
  ['APSIS_MODEL (the env var)', /\bAPSIS_MODEL\b/],
  ['OPENAI_API_KEY', /\bOPENAI_API_KEY\b/],
  ['api.anthropic.com', /api\.anthropic\.com/],
  ['anthropic-version', /anthropic-version/],
  ['x-api-key', /x-api-key/],
  ['sk-ant', /sk-ant/],
  ['sk-proj', /sk-proj/],
  ['VITE_ANTHROPIC', /VITE_ANTHROPIC/],
  ['VITE_OPENAI', /VITE_OPENAI/],
];

/** Lines that would actually run if the browser executed the file. */
const executableLines = (source: string) =>
  source
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('*') &&
        !line.startsWith('/*') &&
        !line.startsWith('*/') &&
        !line.startsWith('//'),
    )
    .join('\n');

test('the shipped bundle contains no credential surface', () => {
  const assets = readdirSync(join(DIST, 'assets'));
  const scanned = [
    ...assets
      .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
      .map((f) => join(DIST, 'assets', f)),
    join(DIST, 'index.html'),
    join(DIST, 'apsis-config.js'),
  ];
  // A scan that found nothing because it read nothing is not a passing test.
  expect(scanned.length).toBeGreaterThanOrEqual(3);

  for (const file of scanned) {
    const contents = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      expect(pattern.test(contents), `${label} found in ${file}`).toBe(false);
    }
  }
});

test('the shipped host config is inert, so the default build stays silent', () => {
  const config = readFileSync(join(DIST, 'apsis-config.js'), 'utf8');
  expect(executableLines(config)).toBe('');
});

test('the host config runs before the app, despite being last in the source', () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');

  const configTag = html.match(/<script[^>]*apsis-config\.js[^>]*>/)?.[0];
  expect(configTag, 'the host config must be loaded by index.html').toBeTruthy();

  // Vite hoists the app's entry into <head>, so the config tag is LAST in the
  // source and still executes FIRST: a classic script runs during parsing,
  // while `type="module"` defers until parsing is done. Asserting source order
  // would be asserting the wrong thing — this asserts the property that makes
  // the ordering correct.
  expect(configTag).not.toContain('type="module"');
  expect(configTag).not.toContain('defer');
  expect(configTag).not.toContain('async');

  const appTag = html.match(/<script[^>]*\/assets\/index-[^>]*>/)?.[0];
  expect(appTag, 'the app entry must be a module, i.e. deferred').toContain('type="module"');
});

test('a host that declares an endpoint actually activates the interpreter', async ({ page }) => {
  // The end-to-end proof of the activation path: serve a DECLARING version of
  // the real config file and check the client calls the endpoint. Nothing here
  // stubs the client's own wiring — the only substitution is the one thing a
  // deployment would edit.
  await page.route('**/apsis-config.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: "window.__APSIS_COMMAND_INTERPRETER__ = { endpoint: '/api/interpret' };",
    }),
  );

  let hits = 0;
  await page.route('**/api/interpret', (route) => {
    hits++;
    return route.fulfill({
      json: { filters: [{ field: 'stages', value: 'cold', span: 'cold' }] },
    });
  });

  await page.goto('/?leads=400&fx=off&feed=off');
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(1000);

  await page.getByLabel('Command Apsis').fill('cold leads');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  expect(hits, 'the declared endpoint must have been called').toBe(1);
  await expect(page.locator('.understood .chip')).toContainText(['stage is Cold']);
  // Interpreted, not fallen back: no note.
  await expect(page.locator('[data-interpreter-note]')).toHaveCount(0);
});
