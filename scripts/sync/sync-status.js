#!/usr/bin/env node
'use strict';

/**
 * sync-status.js — unified read-only status view across the dual-machine
 * sync mechanisms (git-bundle / mirror-queue).
 *
 * Borrows the "one command shows everything" pattern from Syncthing's
 * /rest/db/status + git-town's per-repo sync report + multi-gitter's aggregate
 * status: a single invocation answers "which repos are ahead/behind/dirty, how
 * many pending mirror-queue debits are there, and is the sync manifest
 * consistent" — the question no existing tool answered in one view.
 *
 * Pure-read: runs `git rev-list --left-right` and reads the queue/manifest
 * files, never fetches / merges / pushes / touches the working tree. Safe to
 * run from the 10-minute scheduled task (`khy-hq-autopull`) or by hand.
 *
 * Usage:
 *   node scripts/sync/sync-status.js            # human-readable table
 *   node scripts/sync/sync-status.js --json     # machine-readable (scheduler)
 *
 * Repo discovery: the main repo is D:\Portable\khy-os (this repo).
 *
 * ⚠ khy-os-hq（指挥部）已于 2026-09-17 归档废弃 —— 它的能力被吸收进本仓库
 * （状态真源 `.ai/hq/`，命令面 `khy hq`，多机协作改为单仓 + 租约）。归档说明与
 * 完整镜像在 `D:/Portable/BuildArtifacts/hq-archive-2026-09-17/`。
 *
 * 因此默认**只监控 khy-os 一个仓库**。若哪天要临时把归档的 HQ 也纳入视图
 * （例如考古 / 对照），设 `KHY_OS_HQ_DIR` 指向解包后的 HQ 副本即可 —— 存在才纳入，
 * 不存在则静默跳过（fail-soft，与任一仓库缺失时的行为一致）。
 *
 * No hardcoded IPs/ports/absolute paths: repo roots come from env overrides
 * (KHY_OS_DIR / KHY_OS_HQ_DIR) with a filesystem-relative fallback, and git
 * is resolved the same way mirror-sync.js does (KHY_GIT env or PATH).
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const queueLib = require('../lib/mirrorSyncQueue.js');

/* git helpers (mirror-sync.js pattern) ------------------------------------ */

function findGit() {
  const fromEnv = (process.env.KHY_GIT || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return 'git';
}

function gitSync(git, args, cwd) {
  try {
    return cp.execFileSync(git, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the repo roots without hardcoding absolute paths:
 *   - khy-os: KHY_OS_DIR env, else the parent of this file's repo root
 *   - hq:     **仅当 KHY_OS_HQ_DIR 显式设置时**才纳入（可选、opt-in）
 *
 * ⚠ 不再自动探测 `<khy-os 父目录>/khy-os-hq`（2026-09-17 起）：
 * HQ 已归档废弃，本机工作副本已删除，自动探测会永久指向一个不存在的路径。
 * 归档副本在 `D:/Portable/BuildArtifacts/hq-archive-2026-09-17/`；
 * 需要考古/对照时显式设 `KHY_OS_HQ_DIR` 指过去即可。
 *
 * Returns null for a missing repo (status view is fail-soft: show what's
 * present, never crash).
 */
function discoverRepos() {
  const khyDir = process.env.KHY_OS_DIR
    ? path.resolve(process.env.KHY_OS_DIR)
    : path.resolve(__dirname, '..', '..');

  const repos = [{ name: 'khy-os', root: khyDir }];

  // HQ 是可选仓库：只在显式指定时纳入，不猜路径。
  const hqEnv = (process.env.KHY_OS_HQ_DIR || '').trim();
  if (hqEnv) {
    repos.push({ name: 'khy-os-hq (archived)', root: path.resolve(hqEnv) });
  }

  return repos.filter((r) => {
    try {
      return fs.statSync(path.join(r.root, '.git')).isDirectory();
    } catch {
      return false; // not a git repo on this machine — skip, don't crash
    }
  });
}

/* Per-repo snapshot -------------------------------------------------------- */

function aheadBehind(git, root) {
  // `--left-right` with HEAD...@{upstream}: left = commits only in HEAD
  // (ahead), right = commits only in upstream (behind). Missing upstream
  // yields an empty string → both zero, reported honestly as "no upstream".
  const raw = gitSync(git, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root);
  const parts = raw.split(/\s+/).filter(Boolean);
  const ahead = parts[0] ? (parseInt(parts[0], 10) || 0) : 0;
  const behind = parts[1] ? (parseInt(parts[1], 10) || 0) : 0;
  return { ahead, behind, hasUpstream: raw !== '' };
}

function dirtyCount(git, root) {
  const raw = gitSync(git, ['status', '--porcelain'], root);
  return raw ? raw.split(/\r?\n/).filter(Boolean).length : 0;
}

function currentBranch(git, root) {
  return gitSync(git, ['branch', '--show-current'], root);
}

/* Mirror queue debits ------------------------------------------------------ */

function queueDebints(git, root) {
  const queueFile = path.join(root, '.khy', 'sync', 'mirror-queue.json');
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  } catch {
    return { present: false, pending: 0, lines: [] };
  }
  const norm = queueLib.normalizeQueue(queue);
  return {
    present: norm.entries.length > 0,
    pending: norm.entries.length,
    lines: queueLib.describeQueue(norm),
  };
}

/* Sync manifest integrity (P0-2 companion) --------------------------------- */

/**
 * manifest.json lives alongside an exported bundle in the khy-sync/ dir.
 * If present, verify every recorded commit still exists in the local repo;
 * report missing/extra entries so the operator knows the truth side drifted.
 */
function checkManifest(git, root, manifestDir) {
  const candidates = [
    path.join(root, 'manifest.json'),
    manifestDir ? path.join(manifestDir, 'manifest.json') : '',
  ].filter(Boolean);
  let file = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      file = c;
      break;
    }
  }
  if (!file) {
    return { present: false, ok: null, missing: [], extra: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { present: true, ok: false, missing: ['(unreadable manifest)'], extra: [] };
  }
  const recorded = Array.isArray(manifest.commits) ? manifest.commits : [];
  const localCommits = new Set(
    gitSync(git, ['rev-list', 'HEAD'], root)
      .split(/\r?\n/)
      .filter(Boolean)
  );
  const missing = recorded.filter((sha) => !localCommits.has(sha));
  const extra = localCommits.size - recorded.length; // heuristic: how many ahead
  return { present: true, ok: missing.length === 0, missing, extra: extra > 0 ? extra : 0 };
}

/* Assembly ----------------------------------------------------------------- */

function collect(git, repos, manifestDir) {
  return repos.map((repo) => {
    const root = repo.root;
    const branch = currentBranch(git, root);
    const { ahead, behind, hasUpstream } = aheadBehind(git, root);
    const dirty = dirtyCount(git, root);
    const queue = queueDebints(git, root);
    const manifest = checkManifest(git, root, manifestDir);
    const tip = gitSync(git, ['rev-parse', '--short', 'HEAD'], root);
    return {
      name: repo.name,
      root,
      branch: branch || '(detached)',
      tip,
      hasUpstream,
      ahead,
      behind,
      dirty,
      queue,
      manifest,
    };
  });
}

function printHuman(entries, manifestDir) {
  const head = '='.repeat(70);
  console.log(head);
  console.log('双机同步统一状态视图（只读，未做任何 fetch/merge/push）');
  if (manifestDir) {
    console.log(`manifest 目录: ${manifestDir}`);
  }
  console.log(head);
  for (const e of entries) {
    console.log(`\n[${e.name}] ${e.root}`);
    console.log(
      `  分支 ${e.branch} @ ${e.tip} | 领先 ${e.ahead} / 落后 ${e.behind} / 未提交 ${e.dirty}`
    );
    if (!e.hasUpstream) {
      console.log('  （无上游分支，领先/落后按 0 计）');
    }
    if (e.queue.present) {
      console.log(`  镜像补推队列: ${e.queue.pending} 条待补推`);
      for (const line of e.queue.lines) console.log(`    ${line}`);
    } else {
      console.log('  镜像补推队列: 空（无欠账）');
    }
    if (e.manifest.present) {
      if (e.manifest.ok) {
        console.log(`  manifest: 一致（${e.manifest.extra} 个本地领先提交）`);
      } else {
        console.log(`  manifest: 不一致 —— 缺失 ${e.missingCount} 个已记录提交`);
        for (const sha of e.manifest.missing.slice(0, 5)) {
          console.log(`    缺 ${sha}`);
        }
      }
    } else {
      console.log('  manifest: 未找到（未执行过带清单的导出）');
    }
  }
  console.log('\n' + head);
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const manifestDir = (() => {
    const i = argv.indexOf('--manifest-dir');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
  })();

  const git = findGit();
  const entries = collect(git, discoverRepos(), manifestDir);

  // Expose missing-commit count on each entry for the human printer.
  for (const e of entries) {
    e.missingCount = e.manifest.present ? e.manifest.missing.length : 0;
  }

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repos: entries }, null, 2));
  } else {
    printHuman(entries, manifestDir);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { collect, discoverRepos, queueDebints, checkManifest, aheadBehind, dirtyCount };
