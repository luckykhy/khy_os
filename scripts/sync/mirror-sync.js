#!/usr/bin/env node
'use strict';

/**
 * mirror-sync.js — 镜像推送执行器：推成功即清账，推失败即留账，恢复后自动补推。
 *
 * 为什么需要它：post-commit hook 里的推送必然会遇到断网和令牌过期。原来失败只打一行
 * WARN，那一行滚过去之后就再没有任何地方记得「这个分支还欠一次推送」。这里把欠账落到
 * .khy/sync/mirror-queue.json，并在每次执行时先重放队列 —— 于是网络恢复或令牌更新后
 * 的下一次提交（或一次手动 retry）就会把落后的分支补齐。
 *
 * 用法：
 *   node scripts/sync/mirror-sync.js            # 补推队列 + 推当前分支
 *   node scripts/sync/mirror-sync.js retry      # 只补推队列（网络/令牌恢复后用）
 *   node scripts/sync/mirror-sync.js status     # 只看欠账，不发起任何推送
 *
 * 常用参数：
 *   --branch=<name>     指定分支（默认当前分支）
 *   --remote=<name>     只处理某个远端，可重复
 *   --force             连 diverged（远端已领先）条目一起重放
 *   --non-interactive   禁用凭据交互（hook 用；令牌缺失时快速失败而不是挂住提交）
 *   --strict            推送失败时以非零码退出（CI 用；hook 永远不要开）
 *   --json              机器可读输出
 *
 * 纯逻辑（失败分类 / 队列 reducer / 文案）在 scripts/lib/mirrorSyncQueue.js，
 * 这里只负责 IO：读写队列文件、调 git、打印进度。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const queueLib = require('../lib/mirrorSyncQueue.js');

// 一次 git push 允许的「零输出」空窗。git 在传输期间会持续吐进度到 stderr，
// 所以这里用滑动空闲窗口而不是固定总时长：大仓的慢推送不会被误杀，
// 真断网时 TCP 卡住也不会让 hook 永久挂住。每收到一个字节就重置。
const IDLE_WINDOW_MS = 45_000;
const QUEUE_RELATIVE_PATH = path.join('.khy', 'sync', 'mirror-queue.json');
const MIRROR_REMOTES = ['origin', 'gitee'];

/* 参数解析 ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    action: 'push',
    branch: '',
    remotes: [],
    force: false,
    interactive: true,
    strict: false,
    json: false,
  };
  for (const arg of argv) {
    if (arg === 'push' || arg === 'retry' || arg === 'status') options.action = arg;
    else if (arg === '--force') options.force = true;
    else if (arg === '--non-interactive') options.interactive = false;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length).trim();
    else if (arg.startsWith('--remote=')) {
      const remote = arg.slice('--remote='.length).trim();
      if (remote) options.remotes.push(remote);
    }
  }
  return options;
}

/* git helpers --------------------------------------------------------------- */

function gitSync(args, cwd) {
  try {
    return cp.execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function resolveRepoRoot() {
  const root = gitSync(['rev-parse', '--show-toplevel'], process.cwd());
  if (root) return path.resolve(root);
  // 不在 git 仓库里也不崩：回落到脚本所在仓库根，让调用方拿到明确的报错文案。
  return path.resolve(__dirname, '..', '..');
}

function currentBranch(root) {
  return gitSync(['branch', '--show-current'], root);
}

function localBranchExists(root, branch) {
  return gitSync(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root) !== '';
}

function branchTip(root, branch) {
  return gitSync(['rev-parse', `refs/heads/${branch}`], root);
}

function knownRemotes(root) {
  const raw = gitSync(['remote'], root);
  return raw ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
}

/**
 * 只保留真实存在的镜像远端；KHY_GITEE_REPO 存在而 gitee 远端缺失时补一次注册
 * （沿用 push-mirrors.sh 原有约定：只存仓库 URL，不存令牌）。
 */
function resolveMirrorRemotes(root, requested) {
  const present = new Set(knownRemotes(root));
  const giteeRepo = (process.env.KHY_GITEE_REPO || '').trim();
  if (giteeRepo && !present.has('gitee')) {
    gitSync(['remote', 'add', 'gitee', giteeRepo], root);
    if (knownRemotes(root).includes('gitee')) present.add('gitee');
  }
  const wanted = requested.length > 0 ? requested : MIRROR_REMOTES;
  return wanted.filter(remote => present.has(remote));
}

/**
 * 以空闲窗口守护的 git push。每次收到输出就把窗口推后，静默超过 IDLE_WINDOW_MS
 * 才判定卡死并软终止（kill 子进程，本地提交与队列都不受影响）。
 */
function pushWithIdleWatch(root, remote, branch, interactive) {
  return new Promise(resolve => {
    const env = { ...process.env, GIT_PROGRESS_DELAY: '0' };
    if (!interactive) {
      // 令牌缺失/过期时立刻失败，而不是弹窗或等在 tty 提示上把 hook 挂死。
      env.GIT_TERMINAL_PROMPT = '0';
      env.GCM_INTERACTIVE = 'never';
    }
    const child = cp.spawn(
      'git',
      ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let lastActivity = Date.now();
    let idleTimer = null;
    let idleOut = false;

    const note = chunk => {
      output += chunk.toString();
      lastActivity = Date.now();
    };
    child.stdout.on('data', note);
    child.stderr.on('data', note);

    const finish = result => {
      if (idleTimer) clearInterval(idleTimer);
      resolve(result);
    };

    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < IDLE_WINDOW_MS) return;
      idleOut = true;
      try {
        child.kill();
      } catch {
        /* 子进程已退出 */
      }
    }, 1_000);

    child.on('error', error => {
      finish({ ok: false, output: `${output}\n${error.message}`.trim() });
    });
    child.on('close', code => {
      if (idleOut) {
        const idleSeconds = Math.round(IDLE_WINDOW_MS / 1000);
        finish({
          ok: false,
          output: `${output}\nfailed to connect: no output for ${idleSeconds}s, transfer aborted`.trim(),
        });
        return;
      }
      finish({ ok: code === 0, output: output.trim() });
    });
  });
}

/* 队列持久化 ---------------------------------------------------------------- */

function queuePath(root) {
  return path.join(root, QUEUE_RELATIVE_PATH);
}

function readQueue(root) {
  try {
    return queueLib.normalizeQueue(JSON.parse(fs.readFileSync(queuePath(root), 'utf8')));
  } catch {
    // 首次运行、文件被手工改坏、磁盘临时不可读 —— 都按空队列继续，绝不阻断提交。
    return queueLib.normalizeQueue(null);
  }
}

function writeQueue(root, queue) {
  const target = queuePath(root);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error(`[WARN] 队列写入失败（${target}）：${error.message}`);
    return false;
  }
}

/* 主流程 -------------------------------------------------------------------- */

function printStatus(root, queue, options) {
  const lines = queueLib.describeQueue(queue);
  if (options.json) {
    console.log(JSON.stringify({ queueFile: queuePath(root), ...queue }, null, 2));
    return;
  }
  if (lines.length === 0) {
    console.log('[OK] 镜像补推队列为空，所有分支已同步。');
    return;
  }
  console.log(`[PENDING] ${lines.length} 个目标待补推（队列：${QUEUE_RELATIVE_PATH}）`);
  for (const line of lines) console.log(`  ${line}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveRepoRoot();
  let queue = readQueue(root);

  if (options.action === 'status') {
    printStatus(root, queue, options);
    return 0;
  }

  const remotes = resolveMirrorRemotes(root, options.remotes);
  const targets = [];
  if (options.action === 'push') {
    const branch = options.branch || currentBranch(root);
    if (!branch || branch === 'HEAD') {
      console.error('[WARN] 无法确定当前分支（游离 HEAD?），本次只补推队列。');
    } else if (remotes.length === 0) {
      console.error('[WARN] 未配置镜像远端（origin / gitee），跳过推送。');
    } else {
      for (const remote of remotes) targets.push({ remote, branch });
    }
  }

  // 队列里每个分支的当前 tip：让 planWork 看出「人已经 rebase 过了」，
  // 从而在 diverged 条目上自动放行一次，而不是逼用户想起来加 --force。
  const tips = {};
  for (const entry of queue.entries) {
    if (!tips[entry.branch]) tips[entry.branch] = branchTip(root, entry.branch);
  }

  const { work, held } = queueLib.planWork({ queue, targets, tips, force: options.force });

  if (work.length === 0 && held.length === 0) {
    if (options.action === 'retry') console.log('[OK] 镜像补推队列为空，无需补推。');
    return 0;
  }

  let failed = 0;
  for (let index = 0; index < work.length; index += 1) {
    const item = work[index];
    const position = `${index + 1}/${work.length}`;
    const at = new Date().toISOString();

    if (!localBranchExists(root, item.branch)) {
      // 本地分支已被删除或历史被重写掉：这条欠账再也推不出去，清掉而不是永久刷警告。
      queue = queueLib.removeEntry(queue, { remote: item.remote, branch: item.branch, at });
      console.log(`[SKIP] ${item.remote}/${item.branch} 本地分支不存在，已从队列移除（${position}）`);
      continue;
    }

    const retryNote = item.reason === 'queued' ? `补推第 ${item.attempts + 1} 次` : '本次提交';
    console.log(`[PUSH] 推送 ${item.remote}/${item.branch}（${retryNote}，${position}）`);

    const result = await pushWithIdleWatch(root, item.remote, item.branch, options.interactive);
    if (result.ok) {
      queue = queueLib.removeEntry(queue, { remote: item.remote, branch: item.branch, at });
      console.log(`[OK] ${item.remote}/${item.branch} 已同步（${position}）`);
      continue;
    }

    failed += 1;
    const verdict = queueLib.classifyPushFailure(result.output);
    queue = queueLib.upsertEntry(queue, {
      remote: item.remote,
      branch: item.branch,
      commit: branchTip(root, item.branch),
      kind: verdict.kind,
      message: result.output,
      at,
    });
    console.error(
      `[WARN] ${item.remote}/${item.branch} 推送失败 —— ${verdict.label}（${position}）。`
      + `本地提交已保留并记入补推队列：${verdict.hint}`,
    );
    const detail = queueLib.redactSecrets(result.output).split(/\r?\n/).filter(Boolean).slice(-3);
    for (const line of detail) console.error(`       ${line}`);
  }

  for (const entry of held) {
    const meta = queueLib.describeKind(entry.kind);
    console.error(
      `[HOLD] ${entry.remote}/${entry.branch} 留在队列未重放 —— ${meta.label}`
      + `（已尝试 ${entry.attempts} 次）：${meta.hint}`,
    );
  }

  writeQueue(root, queue);

  if (queue.entries.length > 0) {
    console.error(
      `[PENDING] ${queue.entries.length} 个目标仍待补推，`
      + '恢复网络或更新令牌后执行：npm run sync:mirrors:retry',
    );
  }

  // 默认退出 0：post-commit hook 绝不能把一次成功的本地提交变成失败的提交。
  return options.strict && failed > 0 ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`[WARN] mirror-sync 异常退出：${error && error.message}`);
    process.exit(0);
  });
