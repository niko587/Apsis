/**
 * Every git operation Autopilot is permitted to perform.
 *
 * Deliberately a short list. There is no force push, no reset --hard, no
 * rebase, no branch delete, no `git config` write, no remote add. Not "guarded
 * against" — ABSENT, which is the same argument Apsis made about its own dev
 * auth bypass (D38): a capability that is not in the graph cannot be reached by
 * a bug, a prompt injection, or a future edit that forgets why the guard was
 * there.
 *
 * `execFile` with an argument array throughout: no shell, so a branch name
 * derived from a model-supplied taskId is a string, never syntax. Uses whatever
 * `git` is on PATH — standalone git is fine; no `gh`, no Xcode CLT, no HTTPS
 * transport assumption.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail } from './errors.mjs';
import { redact } from './redaction.mjs';

const execFileAsync = promisify(execFile);

export async function git(args, { cwd = process.cwd(), execImpl = execFileAsync, timeout = 120_000 } = {}) {
  try {
    const { stdout } = await execImpl('git', args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    fail(CODES.GIT_FAILED, `git ${args[0]} failed: ${redact(error?.stderr || error?.message || String(error)).slice(0, 500)}`, {
      args,
    });
  }
}

export const makeGit = (deps = {}) => {
  const run = (args, cwd) => git(args, { ...deps, cwd: cwd ?? deps.cwd });
  const one = async (args, cwd) => (await run(args, cwd)).trim();

  return {
    run,

    async repoRoot(cwd) {
      try {
        return await one(['rev-parse', '--show-toplevel'], cwd);
      } catch {
        fail(CODES.NOT_A_REPO, `not inside a git repository: ${cwd ?? process.cwd()}`);
      }
    },

    version: () => one(['--version']),
    headSha: (cwd) => one(['rev-parse', 'HEAD'], cwd),
    revParse: (ref, cwd) => one(['rev-parse', ref], cwd),
    currentBranch: (cwd) => one(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),

    async isClean(cwd) {
      const status = await one(['status', '--porcelain'], cwd);
      return status === '';
    },

    async statusPorcelain(cwd) {
      return one(['status', '--porcelain'], cwd);
    },

    recentLog: (n, cwd) => one(['log', `-n${n}`, '--oneline', '--no-decorate'], cwd),

    /**
     * Everything this worktree changed relative to its base — tracked edits and
     * new files alike.
     *
     * Untracked files are included explicitly. A boundary check that looked
     * only at `git diff` would wave through a brand-new file in a forbidden
     * directory, which is the easiest boundary violation to commit by accident.
     */
    async changedFiles(cwd, baseSha) {
      const tracked = await one(['diff', '--name-only', baseSha, '--'], cwd);
      const untracked = await one(['ls-files', '--others', '--exclude-standard'], cwd);
      const all = [...tracked.split('\n'), ...untracked.split('\n')]
        .map((s) => s.trim())
        .filter(Boolean);
      return [...new Set(all)].sort();
    },

    /**
     * The diff the reviewer actually reads.
     *
     * THE RULE, and there is no third state: for every changed file, EITHER its
     * complete diff is in `text`, OR the file is named in `unreviewable`. An
     * unread file is not a reviewed file (D65), and a half-read file is worse
     * than an unread one — it looks complete.
     *
     * The first version of this got untracked files right and tracked files
     * wrong. It ran one `git diff BASE --` for everything tracked and then
     * sliced the combined string at the global budget, so a large tracked diff,
     * a tracked binary modification, or simply enough tracked changes could
     * leave Astra holding half a file with nothing in `unreviewable` to say so.
     * The fix is to stop treating "tracked" as one blob: every changed file is
     * now enumerated and budgeted individually, whatever its provenance.
     *
     * Covered: modifications, additions, deletions (the removed text IS the
     * thing to review), renames, and untracked additions. Binary is decided by
     * git's own `--numstat` for tracked paths and by a NUL-byte scan for
     * untracked ones.
     *
     * Nothing is staged to produce any of this: `git add` to make a diff would
     * mutate the index of a tree the controller has not accepted (D65).
     *
     * @returns {{text: string, unreviewable: {file: string, reason: string, bytes: number}[], truncated: boolean, files: string[]}}
     */
    async reviewDiff(cwd, baseSha, { maxBytes = 200_000, maxFileBytes = 64_000, fsImpl = fs } = {}) {
      const entries = [];

      /* --- tracked changes, one entry per path ------------------------- */
      const numstat = await run(['diff', '--numstat', '-z', baseSha, '--'], cwd);
      for (const entry of parseNumstatZ(numstat)) {
        entries.push({
          file: entry.path,
          tracked: true,
          binary: entry.binary,
          paths: entry.paths,
        });
      }

      /* --- untracked additions ----------------------------------------- */
      const untracked = (await one(['ls-files', '--others', '--exclude-standard'], cwd))
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean);
      for (const file of untracked) entries.push({ file, tracked: false, binary: false, paths: [file] });

      // Deterministic order, so the same change always produces the same bytes —
      // which is what makes the pre-commit fingerprint meaningful (D68).
      entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

      const unreviewable = [];
      const chunks = [];
      let budget = maxBytes;
      let truncated = false;

      for (const entry of entries) {
        const piece = entry.tracked
          ? await trackedPiece(entry)
          : untrackedPiece(entry, { maxFileBytes, fsImpl, cwd });

        if (piece.reason) {
          unreviewable.push({ file: entry.file, reason: piece.reason, bytes: piece.bytes });
          if (piece.reason === 'too-large-to-review') truncated = true;
          continue;
        }
        if (piece.text.length > maxFileBytes) {
          unreviewable.push({ file: entry.file, reason: 'too-large-to-review', bytes: piece.text.length });
          truncated = true;
          continue;
        }
        if (piece.text.length > budget) {
          // The GLOBAL budget ran out. Name this file rather than cutting it in
          // half: a file that is 60% present reads as reviewed.
          unreviewable.push({ file: entry.file, reason: 'exceeded-diff-budget', bytes: piece.text.length });
          truncated = true;
          continue;
        }
        chunks.push(piece.text);
        budget -= piece.text.length;
      }

      let text = chunks.join('');
      if (unreviewable.length > 0) {
        text +=
          `\n\n!!! ${unreviewable.length} file(s) in this change were NOT included above and have NOT been reviewed:\n` +
          unreviewable.map((u) => `  ${u.file} — ${u.reason} (${u.bytes} bytes)`).join('\n') +
          '\n';
      }

      return { text, unreviewable, truncated, files: entries.map((e) => e.file) };

      /** One tracked path's complete diff, or a reason it cannot be one. */
      async function trackedPiece(entry) {
        if (entry.binary) return { reason: 'binary', bytes: 0, text: '' };
        const diff = await run(['diff', baseSha, '--', ...entry.paths], cwd);
        return { reason: null, bytes: diff.length, text: diff };
      }
    },
    /** A new branch at an exact base commit, checked out in its own directory. */
    async addWorktree({ root, dir, branch, baseSha }) {
      await run(['worktree', 'add', '-b', branch, path.resolve(root, dir), baseSha], root);
      return path.resolve(root, dir);
    },

    /**
     * Removal is scoped: only a path inside the runtime directory is accepted,
     * so "clean up the worktree" can never become "delete part of the repo".
     */
    async removeWorktree({ root, dir }) {
      const resolved = path.resolve(root, dir);
      const runtime = path.resolve(root, '.apsis-autopilot');
      if (!resolved.startsWith(runtime + path.sep)) {
        fail(CODES.UNSAFE_PATH, `refusing to remove a worktree outside .apsis-autopilot: ${resolved}`);
      }
      await run(['worktree', 'remove', '--force', resolved], root);
    },

    async commitAll({ cwd, message, authorName, authorEmail }) {
      await run(['add', '-A'], cwd);
      const staged = await one(['diff', '--cached', '--name-only'], cwd);
      if (staged === '') return null;
      const args = ['commit', '-m', message];
      if (authorName && authorEmail) args.push('--author', `${authorName} <${authorEmail}>`);
      await run(args, cwd);
      return one(['rev-parse', 'HEAD'], cwd);
    },

    /**
     * Push exactly one task branch, and only on an explicit flag.
     *
     * No `--force`, no `--force-with-lease`, no refspec the caller composes.
     * Pushing anything that is not an `autopilot/` branch is refused here, so
     * "push the branch" can never become "push main".
     */
    async pushBranch({ cwd, branch, remote = 'origin' }) {
      if (!/^autopilot\/[A-Za-z0-9._\-/]+$/.test(branch)) {
        fail(CODES.REFUSED_PUSH, `refusing to push a branch outside autopilot/: ${branch}`);
      }
      await run(['push', '--set-upstream', remote, branch], cwd);
      return { remote, branch };
    },
  };
};


/**
 * `git diff --numstat -z` — the enumeration this module trusts.
 *
 * NUL-delimited because a filename may contain anything a filesystem allows,
 * including a newline, and a parser that splits on `\n` is a parser that can be
 * handed a path it will get wrong. Binary paths arrive as `-\t-\t`, which is
 * git's own answer to "is this reviewable text" and better than guessing.
 *
 * Rename and copy entries emit an empty path slot followed by the old and new
 * paths, so an entry carries BOTH and the diff is requested for the pair.
 */
export function parseNumstatZ(raw) {
  const out = [];
  const fields = raw.split('\0');
  let i = 0;
  while (i < fields.length) {
    const head = fields[i];
    if (head === undefined || head === '') {
      i += 1;
      continue;
    }
    const parts = head.split('\t');
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const [added, deleted, inlinePath] = parts;
    const binary = added === '-' && deleted === '-';
    if (inlinePath === '') {
      // Rename or copy: the next two fields are the old and new paths.
      const oldPath = fields[i + 1] ?? '';
      const newPath = fields[i + 2] ?? '';
      if (newPath !== '') out.push({ path: newPath, paths: [oldPath, newPath], binary });
      i += 3;
    } else {
      out.push({ path: inlinePath, paths: [inlinePath], binary });
      i += 1;
    }
  }
  return out;
}

/** One untracked file rendered as a complete new-file hunk, or a reason it cannot be. */
function untrackedPiece(entry, { maxFileBytes, fsImpl, cwd }) {
  const full = path.resolve(cwd, entry.file);
  let stat;
  try {
    stat = fsImpl.statSync(full);
  } catch {
    return { reason: 'unreadable', bytes: 0, text: '' };
  }
  if (!stat.isFile()) return { reason: 'unreadable', bytes: 0, text: '' };
  if (stat.size > maxFileBytes) return { reason: 'too-large-to-review', bytes: stat.size, text: '' };

  const bytes = fsImpl.readFileSync(full);
  if (isBinary(bytes)) return { reason: 'binary', bytes: stat.size, text: '' };

  const body = bytes.toString('utf8');
  const lines = body === '' ? 0 : body.split('\n').length;
  const text =
    `\n--- /dev/null\n+++ b/${entry.file}\n@@ -0,0 +1,${lines} @@\n` +
    `${body.split('\n').map((line) => `+${line}`).join('\n')}\n`;
  return { reason: null, bytes: stat.size, text };
}

/**
 * A fingerprint of exactly what the reviewer was shown (D68).
 *
 * The pre-commit check already proved the changed FILE SET had not moved. It
 * could not see a file whose NAME survived and whose BYTES changed — a worker
 * (or a gate, or a stray editor save) touching `foo.ts` again after the review
 * produces an identical file list and a different commit. That is a review
 * TOCTOU gap, and comparing names cannot close it.
 *
 * So the controller hashes the review representation itself and re-derives it
 * immediately before committing. The inputs are everything the verdict was
 * based on: the file list, the complete diff text, and the unreviewable
 * metadata. Anything else changing is not something Astra saw.
 */
export function reviewFingerprint({ changedFiles = [], text = '', unreviewable = [] } = {}) {
  const canonical = JSON.stringify({
    files: [...changedFiles].sort(),
    text,
    unreviewable: [...unreviewable]
      .map((u) => ({ file: u.file, reason: u.reason, bytes: u.bytes }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Binary detection, the pragmatic way git itself uses: a NUL byte in the first
 * few KB. Cheap, and wrong only for text files that contain NULs — which are
 * not files a reviewer should be reading as text either.
 */
export function isBinary(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (window.includes(0)) return true;
  // Invalid UTF-8 round-trips to replacement characters.
  const text = window.toString('utf8');
  return text.includes('\uFFFD');
}

export const defaultGit = makeGit();
