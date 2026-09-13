/**
 * Core self-update logic: fetch + fast-forward merge of origin/main, then
 * npm ci when the lockfile changed. Guarded for non-git installs, dirty
 * working trees, non-main branches, and diverged history. Never touches
 * anything on failure — every guard returns before the merge.
 */
import { execSync as _execSync } from 'child_process';
import { existsSync as _existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { answered, failed, observed, refused } from '../internals/verdict.js';

// src/core/update.js -> repo root, independent of process.cwd()
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function _resolve(deps) {
  return {
    execSync: deps?.execSync || _execSync,
    existsSync: deps?.existsSync || _existsSync,
    repoRoot: deps?.repoRoot || REPO_ROOT,
  };
}

export async function update({ _deps } = {}) {
  const { execSync, existsSync, repoRoot } = _resolve(_deps);
  const git = (args, timeout = 15000) =>
    execSync(`git ${args}`, { cwd: repoRoot, timeout, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  if (!existsSync(join(repoRoot, '.git'))) {
    return failed('not_a_git_checkout', {
      error: `Not a git checkout (${repoRoot}). tv_update needs a git clone — re-install with: git clone https://github.com/tradesdontlie/tradingview-mcp`,
    });
  }

  let branch;
  try {
    branch = git('rev-parse --abbrev-ref HEAD');
  } catch (err) {
    return failed('unavailable', { error: `git unavailable or repo unreadable: ${err.message}` });
  }
  if (branch !== 'main') {
    return failed('not_on_main', {
      branch,
      error: `On branch "${branch}", not "main" — update skipped so your work isn't disturbed. Run: git checkout main, then retry.`,
    });
  }

  const dirty = git('status --porcelain');
  if (dirty) {
    return failed('dirty_working_tree', {
      error: 'Working tree has local changes — commit or stash them, then retry.',
      changed_files: dirty.split('\n').slice(0, 10),
    });
  }

  const before = git('rev-parse HEAD');
  try {
    git('fetch origin main', 30000);
  } catch (err) {
    return failed('unavailable', { error: `git fetch failed (offline? no origin?): ${err.message}` });
  }
  const remote = git('rev-parse origin/main');
  if (before === remote) {
    return answered({ updated: false, status: 'up_to_date', commit: before.slice(0, 8) });
  }

  const ahead = Number(git('rev-list --count origin/main..HEAD'));
  if (ahead > 0) {
    return failed('diverged', {
      error: `Local main has ${ahead} commit(s) not on origin — fast-forward is not possible. Inspect with: git log origin/main..HEAD`,
    });
  }

  const behind = Number(git('rev-list --count HEAD..origin/main'));
  const lockChanged = git('diff --name-only HEAD origin/main -- package-lock.json') !== '';

  git('merge --ff-only origin/main', 30000);
  const after = git('rev-parse HEAD');

  // HEAD is read back after the merge; a merge that left HEAD short of
  // origin/main is not an update, whatever git's exit code said.
  if (after !== remote) {
    return refused(`HEAD is ${after.slice(0, 8)} after fast-forwarding to origin/main ${remote.slice(0, 8)}`, {
      updated: false,
      from_commit: before.slice(0, 8),
      head_commit: after.slice(0, 8),
      expected_commit: remote.slice(0, 8),
    });
  }

  let depsInstalled = false;
  let depsWarning;
  if (lockChanged) {
    try {
      execSync('npm ci --no-audit --no-fund', { cwd: repoRoot, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
      depsInstalled = true;
    } catch (err) {
      depsWarning = `Code updated but npm ci failed — run it manually in ${repoRoot}: ${err.message}`;
    }
  }

  return observed({ head_commit: after.slice(0, 8) }, {
    updated: true,
    from_commit: before.slice(0, 8),
    to_commit: after.slice(0, 8),
    commits_pulled: behind,
    deps_installed: depsInstalled,
    ...(depsWarning && { warning: depsWarning }),
    restart_required: true,
    note: 'Update applied. Restart the MCP server (reconnect it in your client) to load the new code — the running process still has the old version.',
  });
}
