'use strict';

/**
 * commit.js — `khy commit` 命令薄壳：**让 AI（或人）知道现在该不该提交，并在该提交时直接提交**。
 *
 * ## 这个命令解决什么
 *
 * 本仓的 Git 治理长期**成对缺失一半**：
 * - 提交**格式**有规范 + 守卫（`[DESIGN-GIT-001]/[002]`，`$g check-commit-message.js`）
 * - 提交**内容**有规范 + 守卫（`[DESIGN-GIT-003]` §4，pre-commit 前三项）
 * - 提交**时机**——「什么时候该提交」——**完全空白**（`PROCESS-009` / `[DESIGN-GIT-004]`）
 *
 * 结果是 AI 只有两个坏选项：改完立刻提交（半成品入库），或永远不提交（实测暂存区
 * 堆到 3993 项）。两条路都不会被任何既有守卫报出来 —— 机制缺失伪装成了个人习惯问题。
 *
 * 本命令给出第三条路：**按判据决定，该提交就提交**。
 *
 * ## 背后的逻辑全在纯叶子
 *
 * 判定（T1–T5 判据、三种结论、commit message 建议）全在纯叶子
 * `src/cli/commitTiming.js`（零 IO / env 门控 `KHY_COMMIT_TIMING` / fail-soft）。
 * 本薄壳只做三件叶子不能做的事：
 * 1. **读 git**：`git diff --cached --name-status -z` 采暂存集
 * 2. **写 git**：`git commit`（只在结论为 `commit-now` 且用户给了 `--yes`/`--message` 时才做）
 * 3. **渲染**：把结论说成人话
 *
 * 这样同一批暂存文件在任何机器、任何时刻都得到同一个结论，测试也不需要造 git 仓库。
 *
 * ## 三种结论（见纯叶子 `decide()`）
 *
 * | 结论 | 含义 | 本命令的动作 |
 * |---|---|---|
 * | `commit-now` | 判据全绿 | 给了 `--yes` → **直接提交**；否则打印就绪 + 建议 message |
 * | `ask-first` | 触发安全护栏（删除/过大/敏感路径） | 打印问询问句，**绝不提交** |
 * | `do-not-commit` | 判据不满足 | 打印缺哪一条 + 怎么补，**绝不提交** |
 *
 * ## 用法
 *
 * ```
 * khy commit                     # 只判断，不提交（默认。安全）
 * khy commit --summary           # 同上，但输出更短（给 AI 读）
 * khy commit --yes -m "…"        # 判据全绿时真的提交
 * khy commit help                # 本命令的帮助
 * ```
 *
 * ⚠ **用 `khy commit help` 而不是 `khy commit --help`**：顶层 `khy.js` 在
 *   bootstrap 之前就拦截了 argv 里任意位置的 `--help`（打印全局命令列表），
 *   这是全仓既有行为（`repo --help`、`hq --help` 同样如此），不是本命令的问题。
 *   故本命令额外接受 `help` 子命令，让帮助始终可达。
 *
 * ⚠ **默认不提交**：`khy commit` 只回答「现在该不该提交」。真提交需要显式 `--yes`。
 *   这是刻意的 —— 「AI 到点自己提交」的授权走的是 AI 调用路径（它读了结论再决定），
 *   而不是让一条 CLI 命令替任何人按下按钮。人敲 `khy commit` 时看到的是判断。
 *
 * 门控 `KHY_COMMIT_TIMING` 默认开；关 → 命令不接管（字节回退）。
 *
 * @module cli/handlers/commit
 */

// ── Imports ──

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 纯叶子（单一真源·零 IO·绝不抛）：判据、三结论、message 建议全在这里。
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const leaf = require('../commitTiming');
const { printSuccess, printError, printWarn, printInfo } = require('../formatters');

// ── Constants ──

/** `git diff --cached --name-status -z` 里我们认识的状态码。 */
const KNOWN_STATUS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

// ── Git helpers（与 handlers/repo.js 同款：execFileSync + 软失败） ──

function _cwd() {
  return process.cwd();
}

/**
 * 跑一条 git 命令，返回 trimmed stdout；非零退出抛错。
 * @param {string[]} args
 * @param {object} [options]
 * @returns {string}
 */
function _git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: _cwd(),
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).toString();
}

/**
 * 跑一条 git 命令，返回 `{ ok, out, err }` 而不抛。适合「失败是预期分支」的场合
 * （比如还没 commit 过）。
 * @param {string[]} args
 * @param {object} [options]
 * @returns {{ok:boolean,out:string,err:string}}
 */
function _gitSoft(args, options = {}) {
  try {
    const out = _git(args, options);
    return { ok: true, out: out.trim(), err: '' };
  } catch (err) {
    const stderr = (err && err.stderr ? err.stderr.toString() : '') || '';
    return { ok: false, out: '', err: (stderr || err.message || String(err)).trim() };
  }
}

function _isGitRepo() {
  const res = _gitSoft(['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.out === 'true';
}

// ── Pure parsing ──

/**
 * 解析 `git diff --cached --name-status -z` 的输出。
 *
 * `-z` 模式下记录是 NUL 分隔的：`<status>\0<path>\0`，
 * 重命名/复制则是 `<status>\0<oldPath>\0<newPath>\0`（R100 / C75 这类带相似度分数）。
 *
 * ⚠ 抽成**纯函数**是为了可单测 —— 这层最容易在 R 上写错（吞掉 oldPath 或错位）。
 *
 * @param {string} raw
 * @returns {Array<{status:string,path:string,fromPath:string|null}>}
 */
function parseNameStatusZ(raw) {
  const out = [];
  if (!raw) return out;
  const parts = String(raw).split('\0');
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) {
      i += 1;
      continue;
    }
    const status = code[0];
    if (!KNOWN_STATUS.has(status)) {
      // 不认识的状态码：跳过这一条，别把后续记录读错位。
      i += 1;
      continue;
    }
    i += 1;
    const first = parts[i];
    i += 1;
    if (status === 'R' || status === 'C') {
      const second = parts[i];
      i += 1;
      out.push({ status, path: second || first || '', fromPath: first || null });
    } else {
      out.push({ status, path: first || '', fromPath: null });
    }
  }
  return out.filter((c) => c.path);
}

/**
 * 把 `git status --porcelain=v1 -z` 的输出收成 `{staged, unstaged}`。
 * 仅用于「还有没暂存的改动」提示，不参与判据。
 * @param {string} raw
 * @returns {{staged:number,unstaged:number}}
 */
function countPorcelainZ(raw) {
  let staged = 0;
  let unstaged = 0;
  if (!raw) return { staged, unstaged };
  for (const rec of String(raw).split('\0')) {
    if (!rec || rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    if (x !== ' ' && x !== '?') staged += 1;
    if (y !== ' ' && y !== '?') unstaged += 1;
    if (x === '?' && y === '?') unstaged += 1;
  }
  return { staged, unstaged };
}

// ── I/O: 采数据（本命令唯一的读 git 处） ──

/**
 * 采暂存集。带 mtime，供 T3 的「卷入并发方改动」判据用。
 * @returns {Array<{status:string,path:string,fromPath:string|null,mtimeMs:number}>}
 */
function collectStaged() {
  const res = _gitSoft(['diff', '--cached', '--name-status', '-z']);
  if (!res.ok) return [];
  const rows = parseNameStatusZ(res.out ? res.out + '\0' : '');
  return rows.map((r) => ({ ...r, mtimeMs: _mtimeOf(r.path) }));
}

/** 读文件 mtime（best-effort，失败返回 NaN 让判据忽略它）。 */
function _mtimeOf(file) {
  try {
    const st = fs.statSync(path.join(_cwd(), file));
    return st.mtimeMs;
  } catch {
    return NaN;
  }
}

/**
 * 找验证证据：`.khy/feedback/<task-id>/verify.txt` 里最新的是否**比暂存集里最老的改动还新**。
 *
 * ⚠⚠ 这里有一个**致命陷阱**，别改回去：最初用 `process.uptime()` 当「会话开工时间」，
 *   结果 `since ≈ now`，任何早于 0.2 秒的 verify.txt 都被判为「太旧」——
 *   **T2 永远失败，提交被永久阻断**（一个伪装成保守的假阴性死机制）。
 *
 *   正确的锚点是**改动自身的 mtime**：问的不是「是不是我这个进程产生的」，
 *   而是「有没有一份验证证据，比我要提交的这批改动更新」。人不小心把
 *   verify.txt 落在开工前是常见现象，那时它照样是有效证据。
 *
 * @param {Array<{mtimeMs?:number}>} changes 暂存集（用它当时间锚）
 * @returns {boolean}
 */
function hasVerifyEvidence(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const base = path.join(_cwd(), '.khy', 'feedback');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return false;
  }

  // 锚点 = 暂存集里**最老**的改动时间。没有可用 mtime 时退化为「有就算有」。
  const times = list.map((c) => c && c.mtimeMs).filter((t) => Number.isFinite(t));
  const anchor = times.length ? Math.min(...times) : NaN;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const f = path.join(base, ent.name, 'verify.txt');
    try {
      const st = fs.statSync(f);
      if (!Number.isFinite(anchor) || st.mtimeMs >= anchor) return true;
    } catch {
      // 该 task 没有 verify.txt —— 正常，继续找下一个。
    }
  }
  return false;
}

// ── 渲染 ──

const DECISION_LABEL = {
  'commit-now': '可以提交',
  'ask-first': '先问一下',
  'do-not-commit': '先别提交',
};

/**
 * 把结论渲染成人话。
 * @param {object} result decide() 的返回值
 * @param {object} ctx
 * @returns {string[]} 要打印的行
 */
function renderDecision(result, ctx = {}) {
  const lines = [];
  const label = DECISION_LABEL[result.decision] || result.decision;

  lines.push('');
  printInfo(`提交时机判断：${label}`, '提交');
  lines.push(`  ${result.reason}`);

  if (result.suggestions && result.suggestions.length) {
    lines.push('');
    lines.push(result.decision === 'do-not-commit' ? '  缺什么、怎么补：' : '  建议：');
    for (const s of result.suggestions) lines.push(`    - ${s}`);
  }

  if (result.decision === 'commit-now') {
    const msg = ctx.message || null;
    lines.push('');
    if (msg) {
      lines.push(`  将提交：${msg}`);
      lines.push('  （用 --yes 确认提交）');
    } else {
      const sug = leaf.suggestMessage(ctx.changes || []);
      lines.push('  下一步：给个提交说明，然后加 --yes，例如');
      lines.push(`    khy commit --yes -m "${sug.type}(${sug.scope || 'scope'}): 一句话说清这次做了什么"`);
      lines.push(`  说明类型建议：${sug.type} —— ${sug.reason}`);
    }
  }

  if (result.decision === 'ask-first') {
    lines.push('');
    lines.push('  这次改动值得人看一眼 —— 确认后再提交。');
  }

  if (ctx.unstaged > 0) {
    lines.push('');
    printWarn(`另有 ${ctx.unstaged} 处改动没进暂存区（本次不提交）。`);
  }

  return lines;
}

function _usage() {
  console.log('');
  console.log('  khy commit — 判断现在该不该提交（默认只判断，不提交）');
  console.log('');
  console.log('  用法：');
  console.log('    khy commit                  只判断，打印结论');
  console.log('    khy commit --summary        同上，输出更短');
  console.log('    khy commit --yes -m "…"     判据全绿时真的提交');
  console.log('    khy commit help             显示本帮助');
  console.log('');
  console.log('  ⚠ --help 会被顶层 `khy` 拦走（打印全局命令列表），');
  console.log('    要看本命令的帮助请用 `khy commit help`。');
  console.log('');
  console.log('  三种结论：');
  console.log('    可以提交      判据全绿，随时可提交');
  console.log('    先问一下      含删除 / 改动过大 / 碰了敏感路径 —— 请人确认');
  console.log('    先别提交      判据不满足，打印缺哪一条');
  console.log('');
  console.log('  判据（PROCESS-009 / [DESIGN-GIT-004]）：');
  console.log('    T1 单元闭合   一个提交只有一个逻辑意图');
  console.log('    T2 可运行     有验证证据');
  console.log('    T3 仓库自洽   没卷入并发方改动');
  console.log('    T4 无游离产物 没有 tmp/probe/.bak');
  console.log('');
}

// ── 入口 ──

/**
 * `khy commit` 入口。
 *
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令（门控关 → false）。
 */
async function handleCommit(_subCommand, args = [], _options = {}) {
  const argv = Array.isArray(args) ? args : [];

  if (!leaf.isEnabled(process.env)) {
    printInfo('commit 命令未启用（KHY_COMMIT_TIMING 为关）。');
    return false;
  }

  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    _usage();
    return true;
  }

  if (!_isGitRepo()) {
    printError('当前目录不是 Git 仓库。');
    printInfo('先在本项目目录运行: git init');
    return true;
  }

  const summary = argv.includes('--summary') || argv.includes('--json');
  const doCommit = argv.includes('--yes') || argv.includes('-y');
  const message = _argValue(argv, '-m') || _argValue(argv, '--message') || '';

  // ── 采数据 ──
  const changes = collectStaged();
  const tail = _gitSoft(['status', '--porcelain=v1', '-z']);
  const counts = countPorcelainZ(tail.ok ? tail.out : '');

  const ctx = {
    changes,
    verifyPending: hasVerifyEvidence(changes),
    message,
    unstaged: counts.unstaged,
  };

  // ── 判 ──
  const result = leaf.decide(changes, ctx);

  if (summary) {
    // 给 AI 读的紧凑格式：一行结论 + 一行理由。
    console.log(`${result.decision}\t${result.reason}`);
    return true;
  }

  for (const line of renderDecision(result, ctx)) {
    if (typeof line === 'string' && line.trim()) console.log(line);
  }

  // ── 执行（只在 commit-now + --yes 时） ──
  if (result.decision !== 'commit-now') return true;

  if (!doCommit) {
    console.log('');
    printInfo('没有提交（本命令默认只判断）。确认后加 --yes。');
    return true;
  }

  if (!message || !message.trim()) {
    console.log('');
    printError('要提交就得给个说明：加 -m "…"。');
    const sug = leaf.suggestMessage(changes);
    printInfo(`例如：khy commit --yes -m "${sug.type}(${sug.scope || 'scope'}): 一句话说清这次做了什么"`);
    return true;
  }

  const res = _gitSoft(['commit', '-m', message.trim()], { timeout: 60000 });
  console.log('');
  if (res.ok) {
    printSuccess('已提交。');
    printInfo(message.trim(), '说明');
    printInfo('还没推送到远端 —— 要推的话用 `khy repo push`。', '下一步');
  } else {
    printError('提交失败（很可能是 pre-commit 钩子拦下了）。');
    console.log(res.err || '');
    printInfo('钩子的报错通常在第一行——先修它，再重试。');
  }
  return true;
}

/** 取 `--flag value` 或 `--flag=value` 的值；没给返回 ''。 */
function _argValue(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1] || '';
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return '';
}

module.exports = {
  handleCommit,
  // 导出纯函数与 I/O 采集器供测试
  parseNameStatusZ,
  countPorcelainZ,
  collectStaged,
  hasVerifyEvidence,
  renderDecision,
  [MANIFEST_EXPORT_KEY]: {
    name: 'commit',
    description: '判断现在该不该提交（提交时机）：判据全绿可直接提交，含删除/过大/敏感路径先问人',
    usage: 'commit [--summary] [--yes -m "…"]',
    subCommands: [],
    category: 'dev',
    handler: async (parsed) => handleCommit(null, parsed.args, parsed.options),
  },
};
