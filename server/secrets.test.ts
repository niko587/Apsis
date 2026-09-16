/**
 * The secret boundary, asserted rather than trusted.
 *
 * The bundle is built from `src/`, `index.html` and `public/`. If none of those
 * can name a credential, the bundle cannot contain one — so scanning the
 * sources is the load-bearing check and it runs on every `npm test`, with no
 * build required. `e2e/bundle-secrets.spec.ts` scans the actual built artifact
 * afterwards, because "it follows logically" is a weaker guarantee than
 * "we looked".
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Anything that, if it appeared in a client file, would mean a key could ship.
 *
 * Matched on WORD BOUNDARIES, not as substrings. The first version of this test
 * used `includes` and flagged `src/orchestrator/registry.ts`, which contains
 * `__APSIS_MODEL_ENV__` — the §37 host-declared browser global, which has
 * nothing to do with a credential and merely shares eleven characters with one.
 * A scan that cries wolf gets disabled; `\b` around an identifier distinguishes
 * the environment variable `APSIS_MODEL` from a longer name containing it.
 */
const FORBIDDEN_IN_CLIENT: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['ANTHROPIC_API_KEY', /\bANTHROPIC_API_KEY\b/],
  ['APSIS_MODEL (the env var)', /\bAPSIS_MODEL\b/],
  ['OPENAI_API_KEY', /\bOPENAI_API_KEY\b/],
  ['api.anthropic.com', /api\.anthropic\.com/],
  ['x-api-key', /x-api-key/],
  ['sk-ant', /sk-ant/],
  ['VITE_ANTHROPIC', /VITE_ANTHROPIC/],
  ['VITE_OPENAI', /VITE_OPENAI/],
  ['VITE_API_KEY', /VITE_API_KEY/],
];

describe('nothing that ships to the browser can name a credential', () => {
  const clientFiles = [
    ...filesUnder(join(ROOT, 'src')),
    ...filesUnder(join(ROOT, 'public')),
    join(ROOT, 'index.html'),
  ];

  it('scans a non-trivial number of files (a passing scan of nothing proves nothing)', () => {
    expect(clientFiles.length).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN_IN_CLIENT)('no client file mentions %s', (_label, pattern) => {
    const offenders = clientFiles.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it('still catches a real leak — the scan is not vacuous', () => {
    // Guards the guard: if the matcher were broken, every case above would pass
    // for the wrong reason.
    const [, anthropicKey] = FORBIDDEN_IN_CLIENT[0];
    expect(anthropicKey.test('const k = process.env.ANTHROPIC_API_KEY')).toBe(true);
    expect(anthropicKey.test('window.__APSIS_MODEL_ENV__')).toBe(false);
    const [, model] = FORBIDDEN_IN_CLIENT[1];
    expect(model.test('env.APSIS_MODEL')).toBe(true);
    expect(model.test('window.__APSIS_MODEL_ENV__ = {}')).toBe(false);
  });

  it('src/ contains no VITE_-prefixed variable at all', () => {
    // Vite inlines exactly and only `VITE_`-prefixed values, so the prefix IS
    // the boundary. The app reads `import.meta.env` for build-mode diagnostics,
    // which is fine; a custom VITE_ variable would be the thing to notice.
    const offenders = filesUnder(join(ROOT, 'src'))
      .filter((file) => /\bVITE_[A-Z0-9_]+/.test(readFileSync(file, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('the committed host config declares nothing', () => {
    const config = readFileSync(join(ROOT, 'public/apsis-config.js'), 'utf8');
    // Every occurrence of the global must be inside a comment. Executing this
    // file must not define it — that is what keeps the default build silent.
    const executable = config
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
      .join('\n');
    expect(executable).not.toContain('window.__APSIS_COMMAND_INTERPRETER__ =');
  });

  it('the secret files are gitignored before any key can exist', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('.env.local');
    expect(ignore).toContain('.env*.local');
  });

  it('no LLM SDK entered package.json — fetch on both sides (D27)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const name of all) {
      expect(name, `${name} looks like a model SDK`).not.toMatch(
        /anthropic|openai|langchain|llamaindex|ai-sdk|@ai-sdk/i,
      );
    }
    /**
     * The dependency list, pinned exactly.
     *
     * `@workos-inc/node` is the ONE approved addition (D39): authentication
     * only, server-side only, and justified because session sealing, JWT
     * validation and refresh rotation are the wrong things to hand-roll. It
     * changes nothing about D27 — the model path is still `fetch` with no SDK,
     * which the regex above keeps enforcing. Anything else appearing here has
     * to be argued for in this test first.
     */
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@react-three/drei',
      '@react-three/fiber',
      '@react-three/postprocessing',
      '@workos-inc/node',
      'postprocessing',
      'react',
      'react-dom',
      'three',
      'zustand',
    ]);
  });
});
