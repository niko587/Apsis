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
     * THE DEFECT THIS EXISTS FOR: new files were rendered as
     * `(new file, contents not inlined)`. A task whose entire implementation is
     * one new module therefore produced a review in which Astra accepted code
     * it had never seen — and "reviewed" is the word the run record used. An
     * unread file is not a reviewed file, and the packet must not imply
     * otherwise.
     *
     * So untracked files are inlined as new-file hunks, read from disk. Nothing
     * is staged to achieve it: `git add` to produce a diff would mutate the
     * index of a tree the controller has not yet accepted.
     *
     * Two categories cannot be reviewed as text and are NOT quietly summarised:
     * binary files, and files too large for the byte budget. They come back in
     * `unreviewable`, and the controller escalates rather than asking anyone to
     * bless bytes nobody read (D65).
     *
     * @returns {{text: string, unreviewable: {file: string, reason: string, bytes: number}[], truncated: boolean}}
     */
    async reviewDiff(cwd, baseSha, { maxBytes = 200_000, maxFileBytes = 64_000, fsImpl = fs } = {}) {
      const tracked = await run(['diff', baseSha, '--'], cwd);
      const untracked = (await one(['ls-files', '--others', '--exclude-standard'], cwd))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();

      const unreviewable = [];
      let truncated = false;
      let budget = maxBytes - tracked.length;
      let extra = '';

      for (const file of untracked) {
        const full = path.resolve(cwd, file);
        let stat;
        try {
          stat = fsImpl.statSync(full);
        } catch {
          unreviewable.push({ file, reason: 'unreadable', bytes: 0 });
          continue;
        }
        if (!stat.isFile()) continue;

        if (stat.size > maxFileBytes) {
          unreviewable.push({ file, reason: 'too-large-to-review', bytes: stat.size });
          continue;
        }

        const bytes = fsImpl.readFileSync(full);
        if (isBinary(bytes)) {
          unreviewable.push({ file, reason: 'binary', bytes: stat.size });
          continue;
        }

        const body = bytes.toString('utf8');
        const hunk =
          `\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${body === '' ? 0 : body.split('\n').length} @@\n` +
          `${body.split('\n').map((line) => `+${line}`).join('\n')}\n`;

        if (hunk.length > budget) {
          // The budget ran out. Say so about THIS file rather than cutting the
          // packet mid-hunk and leaving a half-read module looking complete.
          unreviewable.push({ file, reason: 'exceeded-diff-budget', bytes: stat.size });
          truncated = true;
          continue;
        }
        extra += hunk;
        budget -= hunk.length;
      }

      let text = tracked + extra;
      if (text.length > maxBytes) {
        text = `${text.slice(0, maxBytes)}\n…diff truncated at ${maxBytes} bytes…`;
        truncated = true;
      }
      if (unreviewable.length > 0) {
        text +=
          `\n\n!!! ${unreviewable.length} file(s) in this change were NOT included above and have NOT been reviewed:\n` +
          unreviewable.map((u) => `  ${u.file} — ${u.reason} (${u.bytes} bytes)`).join('\n') +
          '\n';
      }
      return { text, unreviewable, truncated };
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
