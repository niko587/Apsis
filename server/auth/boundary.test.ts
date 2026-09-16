/**
 * Two boundaries that exist only as a shape in the import graph, and would
 * therefore rot silently without a test that walks it.
 *
 * 1. `@workos-inc/node` may be imported by `server/auth/provider.ts` and its
 *    tests, and nowhere else (D39). If it leaks into `server/interpret.ts` or
 *    `src/**`, the seam has stopped being a seam and swapping providers stops
 *    being one file.
 *
 * 2. The development identity must be ABSENT from the production artifact, not
 *    disabled by a flag (D38). An environment check fails open when set wrongly
 *    and leaves the code present to be reached; absence is the only version
 *    that cannot be misconfigured.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => file.slice(ROOT.length + 1);

/** Every module specifier a file imports, static or dynamic. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

describe('only the adapter may import the auth SDK (D39)', () => {
  const PACKAGE = '@workos-inc/node';
  const ALLOWED = new Set(['server/auth/provider.ts']);

  const candidates = [
    ...filesUnder(join(ROOT, 'src')),
    ...filesUnder(join(ROOT, 'server')),
    ...filesUnder(join(ROOT, 'api')),
    ...filesUnder(join(ROOT, 'scripts')),
  ];

  it('scans a meaningful number of files', () => {
    expect(candidates.length).toBeGreaterThan(30);
  });

  it('is imported by server/auth/provider.ts and nothing else', () => {
    const importers = candidates
      .filter((file) => importsOf(file).some((s) => s === PACKAGE || s.startsWith(`${PACKAGE}/`)))
      .map(rel)
      // Tests may import it to type their fakes.
      .filter((path) => !path.endsWith('.test.ts'));
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });

  it('never reaches the browser bundle: nothing under src/ mentions it', () => {
    const offenders = filesUnder(join(ROOT, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('workos'))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no WorkOS credential name appears under src/', () => {
    const forbidden = [
      /\bWORKOS_API_KEY\b/,
      /\bWORKOS_CLIENT_ID\b/,
      /\bWORKOS_COOKIE_PASSWORD\b/,
      /\bWORKOS_REDIRECT_URI\b/,
      /VITE_WORKOS/,
    ];
    for (const file of filesUnder(join(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${pattern} in ${rel(file)}`).toBe(false);
      }
    }
  });

  it('the endpoint depends on the generic seam, not on the provider module', () => {
    // `interpret.ts` may reach the provider only through `authProviderFromEnv`
    // and the cookie helpers; it must never name a WorkOS type.
    const source = readFileSync(join(ROOT, 'server/interpret.ts'), 'utf8');
    expect(source).not.toContain('@workos-inc/node');
    expect(source).not.toContain('WorkOSAuthenticateResult');
    expect(source).toContain("from './auth/identity'");
  });
});

describe('the development bypass is absent from the production graph (D38)', () => {
  /** Resolve a relative specifier to a real file, trying the usual suffixes. */
  function resolveLocal(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  /** Everything reachable from an entry point by following relative imports. */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importsOf(file)) {
        const target = resolveLocal(file, specifier);
        if (target) queue.push(target);
      }
    }
    return seen;
  }

  it('api/interpret.ts cannot reach scripts/ at all', () => {
    const graph = reachableFrom(join(ROOT, 'api/interpret.ts'));
    const leaks = [...graph].map(rel).filter((path) => path.startsWith('scripts/'));
    expect(leaks, 'the dev identity must not be in the deployed bundle').toEqual([]);
    // Sanity: the walk is actually walking.
    expect([...graph].map(rel)).toContain('server/interpret.ts');
    expect([...graph].map(rel)).toContain('server/auth/provider.ts');
  });

  it('every api/ entry point is equally isolated', () => {
    for (const file of filesUnder(join(ROOT, 'api'))) {
      const leaks = [...reachableFrom(file)].map(rel).filter((p) => p.startsWith('scripts/'));
      expect(leaks, rel(file)).toEqual([]);
    }
  });

  it('the dev identity is imported only by scripts/', () => {
    const importers = [
      ...filesUnder(join(ROOT, 'src')),
      ...filesUnder(join(ROOT, 'server')),
      ...filesUnder(join(ROOT, 'api')),
      ...filesUnder(join(ROOT, 'scripts')),
    ]
      .filter((file) => importsOf(file).some((s) => s.includes('devIdentity')))
      .map(rel);
    expect(importers).toEqual(['scripts/dev-interpreter.mjs']);
  });

  it('there is NO flag, header or query parameter that disables authentication', () => {
    // The thing the contract forbids by name. A bypass that can be switched on
    // is a bypass that will be, by accident, in production.
    const forbidden = [
      /auth\s*=\s*off/i,
      /\bAUTH_DISABLED\b/,
      /\bDISABLE_AUTH\b/,
      /\bSKIP_AUTH\b/,
      /\bAPSIS_DEV_AUTH\b/,
      /\bBYPASS_AUTH\b/,
    ];
    for (const file of [...filesUnder(join(ROOT, 'server')), ...filesUnder(join(ROOT, 'api'))]) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${pattern} in ${rel(file)}`).toBe(false);
      }
    }
  });

  it('authentication fails closed when unconfigured, rather than being skipped', () => {
    const source = readFileSync(join(ROOT, 'server/interpret.ts'), 'utf8');
    // The unconfigured branch must produce a 401, not fall through.
    expect(source).toContain('auth_unconfigured');
    expect(source).toMatch(/if \(!authenticate\)[\s\S]{0,160}401/);
  });
});
