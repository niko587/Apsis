/**
 * File-boundary enforcement: the structural half of the safety model.
 *
 * GPT writes `allowedFiles` and `forbiddenFiles`; the controller decides
 * whether the diff respected them. That order matters. If a reviewer could
 * wave through a change to a file the spec forbade, then the boundary is a
 * suggestion and the worker's blast radius is "whatever the reviewer was
 * persuaded of". So a violation is a controller verdict and GPT is not asked.
 *
 * Two independent questions are answered here:
 *   1. Is this path even expressible? (`../../../.ssh/id_rsa` is not a file
 *      this tool has an opinion about — it is a path that must never be
 *      accepted into a spec at all.)
 *   2. Did the actual diff stay inside the declared surface?
 */

import path from 'node:path';
import { CODES, fail } from './errors.mjs';

/**
 * Always forbidden, whatever the spec says. These are appended to every task's
 * forbidden list rather than merely documented, because the failure they
 * prevent — a worker committing a .env, or editing the controller that is
 * supervising it — is unrecoverable once pushed.
 */
export const ALWAYS_FORBIDDEN = Object.freeze([
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.apsis-autopilot/**',
  'tools/autopilot/**',
  '.git/**',
  '**/id_rsa',
  '**/*.pem',
  '**/.npmrc',
]);

/**
 * Is this a path the controller is willing to reason about at all?
 *
 * Repo-relative, no escape, no absolute root, no NUL, no Windows drive, no
 * `.git` internals. Checked before any glob work, so a hostile pattern never
 * reaches the matcher.
 */
export function isSafeRepoPath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  if (candidate.includes('\0')) return false;
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return false;
  if (candidate.startsWith('~')) return false;

  // Normalise with POSIX semantics and then ask whether anything climbed out.
  // `a/../../b` normalises to `../b`, which is the case this catches.
  const unixed = candidate.replace(/\\/g, '/');
  const normalised = path.posix.normalize(unixed);
  if (normalised === '..' || normalised.startsWith('../')) return false;
  if (normalised.split('/').includes('..')) return false;
  if (normalised.split('/').some((seg) => seg === '.git')) return false;

  return true;
}

export function assertSafeRepoPaths(paths, label) {
  for (const p of paths) {
    if (!isSafeRepoPath(p)) {
      fail(CODES.UNSAFE_PATH, `${label} contains a path that escapes the repository: ${JSON.stringify(String(p)).slice(0, 120)}`);
    }
  }
  return paths;
}

/**
 * Glob → RegExp, supporting exactly what a TaskSpec needs: `**` across
 * separators, `*` within a segment, `?` for one character. Deliberately no
 * brace expansion and no extglob — a smaller grammar is a smaller thing to be
 * wrong about, and every unsupported character is escaped rather than ignored.
 */
export function globToRegExp(glob) {
  const normalised = path.posix.normalize(glob.replace(/\\/g, '/'));
  let out = '';
  for (let i = 0; i < normalised.length; i += 1) {
    const c = normalised[i];
    if (c === '*') {
      if (normalised[i + 1] === '*') {
        // `**/` matches zero or more leading segments; a bare `**` matches all.
        if (normalised[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A directory pattern matches everything under it: `src/ui` covers
  // `src/ui/LeadList.tsx` without the author having to write `src/ui/**`.
  return new RegExp(`^${out}(?:/.*)?$`);
}

export const matchesAny = (file, globs) =>
  globs.some((g) => globToRegExp(g).test(path.posix.normalize(file.replace(/\\/g, '/'))));

/**
 * Compare an actual diff against the declared surface.
 *
 * Returns a verdict rather than throwing, because the caller records it, tells
 * the worker, and may repair — the same shape as a failed gate.
 *
 * @param {{changed: string[], allowedFiles: string[], forbiddenFiles: string[]}} input
 */
export function enforceBoundaries({ changed, allowedFiles, forbiddenFiles }) {
  const forbidden = [...forbiddenFiles, ...ALWAYS_FORBIDDEN];

  const unsafe = changed.filter((f) => !isSafeRepoPath(f));
  const violations = changed.filter((f) => isSafeRepoPath(f) && matchesAny(f, forbidden));
  const unlisted = changed.filter(
    (f) => isSafeRepoPath(f) && !matchesAny(f, forbidden) && !matchesAny(f, allowedFiles),
  );

  if (unsafe.length > 0) {
    return { ok: false, code: CODES.UNSAFE_PATH, unsafe, violations, unlisted };
  }
  if (violations.length > 0) {
    return { ok: false, code: CODES.FORBIDDEN_FILE, unsafe, violations, unlisted };
  }
  if (unlisted.length > 0) {
    return { ok: false, code: CODES.UNLISTED_FILE, unsafe, violations, unlisted };
  }
  return { ok: true, code: null, unsafe: [], violations: [], unlisted: [] };
}

/**
 * Branch and worktree names are derived from a model-supplied taskId, so they
 * are sanitised rather than trusted: git refs have their own metacharacters,
 * and a directory name is a filesystem path.
 */
export function sanitiseSlug(raw, fallback = 'task') {
  const slug = String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  // git rejects refs that are empty, start with '-', end in '.lock', or are '@'.
  if (slug === '' || slug === '@' || slug.endsWith('.lock')) return fallback;
  return slug;
}

export const branchNameFor = (index, taskId) =>
  `autopilot/task-${String(index).padStart(4, '0')}-${sanitiseSlug(taskId)}`;

export const worktreeDirFor = (index, taskId) =>
  path.join('.apsis-autopilot', 'worktrees', `task-${String(index).padStart(4, '0')}-${sanitiseSlug(taskId)}`);
