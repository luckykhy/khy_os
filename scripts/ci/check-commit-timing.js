#!/usr/bin/env node
'use strict';

/**
 * check-commit-timing.js — 提交时机判据（`PROCESS-009` / `[DESIGN-GIT-004]`）。
 *
 * ## 这个文件存在的理由
 *
 * 本仓的 Git 治理是**成对**的：`[DESIGN-GIT-001]` §2 与 `[DESIGN-GIT-002]` 管提交**格式**
 * （守卫 `check-commit-message.js`），`[DESIGN-GIT-003]` §4 管提交**内容**
 * （pre-commit 的 tmp / 大文件 / 密钥三项）。但**「什么时候该提交」没有任何判据** ——
 * 2026-09-19 全仓检索「提交时机 / 什么时埃该提交 / commit timing」只命中 3 处无关巧合。
 *
 * 后果是判据缺失被转嫁给人：AI 要么改完就提交（半成品入库），要么永不提交
 * （实测工作区 4002 项未提交）。两条路都不会被任何既有守卫报出来。
 *
 * 本执行器把 `[DESIGN-GIT-004]` §3 的五条判据变成可跑的检查。
 *
 * ## 五条判据
 *
 * | 判据 | finding | 强度 |
 * |---|---|---|
 * | T1 单元闭合（一个逻辑意图） | `unit-multi-intent` | warning |
 * | T2 可运行（有验证证据） | `unit-unverified` | warning |
 * | T3 仓库自洽（未卷入并发方改动） | `unit-sweeps-foreign-changes` | warning |
 * | T4 无游离产物 | `unit-stray-artifacts` | warning |
 * | T5 可回滚 | `unit-not-rollbackable` | warning |
 *
 * ## 为什么全部是 warning（这是设计决策，不是没做完）
 *
 * `[DESIGN-ARCH-113]` §5 的强度梯度结论：**过早阻断会逼 AI 撒谎**。
 * 若「没有验证证据」当场判 error，AI 会编一条 `verify.txt` 交差 —— 比不判更糟。
 * 故本机制按 `[DESIGN-PROCESS-002]` PP-1 定在 **S1 观察者**：恒 `exit 0`，只记录。
 * `STAGE` 常量是阶段权威（登记表只是镜像，`check-rollout-stage.js` 比对防漂移）。
 *
 * ## 纪律
 *
 * 零外部依赖、确定性、可离线跑、只读不改业务、不篡改 git 状态。
 * 判定逻辑是**纯函数**（`evaluate()`），I/O 只在 `collect()` 里 —— 便于离线单测与反例矩阵。
 *
 * Usage:
 *   node scripts/ci/check-commit-timing.js
 *   node scripts/ci/check-commit-timing.js --changed
 *   node scripts/ci/check-commit-timing.js --scenario=clean-unit
 *   node scripts/ci/check-commit-timing.js --files="M:a.js,A:b.js"
 *   node scripts/ci/check-commit-timing.js --explain
 *
 * Exit: 0 无 error（S1 恒 0），1 有 error，2 用法错误。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

/**
 * 本机制的落地阶段（`[DESIGN-PROCESS-002]` PP-1：新拦截型机制必须先过 S1 观测）。
 *
 * ⚠ 这个常量不是装饰：它是 `FEATURE-OWNERSHIP.json` 里 `commit-timing-contract` 条目的
 * `executorStage.constant`，`check-rollout-stage.js` 会拿它跟登记表比对，漂移即报错。
 * 当前 S1 ⇒ 只记录不阻断（PP-3）。升 S3 前须按 PP-2 攒够样本（≥200 条）。
 */
const STAGE = 'S1';

/** 规范形只存小写；输出时映射成 ruleguard 要的定宽 6 字符方言标签。
 *  ⚠ 判定 / 统计 / 输出三处不得各持一套字面量 —— 两套大小写会让 error 被静默计成
 *  warning、恒 exit 0，且表现恰好伪装成 S1 的预期行为。 */
const SEV_ERROR = 'error';
const SEV_WARNING = 'warning';
const labelOf = (s) => (s === SEV_ERROR ? 'ERROR' : 'WARN ');

/** 顶层板块：判「一个逻辑意图」用（对应 [DESIGN-LAY-005] 的 L0~L6）。 */
const TOP_BLOCKS = [
  'kernel', 'platform', 'services', 'apps', 'software',
  'extensions', 'tools', 'docs', 'scripts', 'packaging', 'deploy', 'electron',
];

/** 可执行代码扩展名：改了这些就要求验证证据。 */
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.py', '.c', '.h', '.asm', '.dart', '.go', '.rs']);

/** 游离产物形状（T4）。与 pre-commit 第 1 项口径一致，向前兼容探针/临时脚本。 */
const STRAY_RE = /(^|\/)(tmp-|tmp_|\.tmp$)|\.tmp$|(^|\/)probe[-_]|(^|\/)_probe|\.bak$|\.orig$/;

/** 本机态 / 不该入库的目录（T3：卷进来极可能是并发方的）。 */
const LOCAL_STATE_DIRS = ['.khy/', '.khyos/', '.khyquant/', 'khy-Trajectory/', '.zcode/tmp/'];

/** 文档类扩展名：只改这些的单元不要求运行验证（T2 豁免）。 */
const DOC_EXTS = new Set(['.md', '.html', '.txt', '.json', '.yaml', '.yml', '.css', '.svg']);

/** `[DESIGN-GIT-004]` §4 的安全护栏：改动集超过此数须先问人。 */
const ASK_FILE_COUNT = 20;

/**
 * 每条判据的**阶段强度**：S1/S2 只记录（warning），S3/S4 起真拦（error）。
 *
 * ## 为什么强度要按阶段派生，而不是写死 warning
 *
 * 写死 `SEV_WARNING` 会让 `STAGE` 常量变成**装饰**：S1 与 S3 跑出完全一样的结果、
 * 一样的退出码 ⇒ 升到 S3 后机制**仍然不拦截**，而所有守卫全绿（登记表说 S3、代码里
 * 常量也是 S3，`check-rollout-stage.js` 的漂移比对也过）—— 典型的「登记了门禁但不生效」。
 * 这正是本仓 `[DESIGN-ARCH-113]` 执行器踩过的坑的同一形状：**表现恰好伪装成 S1 的预期行为**。
 *
 * ⇒ 强度由 `severityFor(criterion)` 单点派生，判定处只报「哪条判据命中」，
 *   校验方式：S1 与 S3 对**同一改动集**跑，`Summary` 的 error 数必须不同。
 */
const BLOCKING_AT = 3; // S3 起，R 判据升为 error

/** R 判据（必须）：S3 起真拦。T5 是 S 判据（建议），永远只记录。 */
const REQUIRED = new Set(['T1', 'T2', 'T3', 'T4']);

/** 阶段 → 严重度派生（单一真源，判定 / 统计 / 输出三处共用）。 */
function severityFor(criterion) {
  const order = { S1: 1, S2: 2, S3: 3, S4: 4 }[STAGE] || 1;
  if (order >= BLOCKING_AT && REQUIRED.has(criterion)) return SEV_ERROR;
  return SEV_WARNING;
}

// ────────────────────────────────────────────────────────────────────────────
// 纯函数层（无 I/O，可离线单测）
// ────────────────────────────────────────────────────────────────────────────

/** 取路径的顶层板块名；不在 TOP_BLOCKS 则返回第一段（点目录归 '.other'）。 */
function topBlock(file) {
  const norm = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const seg = norm.split('/')[0] || '';
  if (!seg) return '';
  if (seg.startsWith('.')) return '';
  return seg;
}

function extOf(file) {
  const norm = String(file || '').replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

function isCode(file) {
  return CODE_EXTS.has(extOf(file));
}

function isDoc(file) {
  return DOC_EXTS.has(extOf(file));
}

function isStray(file) {
  return STRAY_RE.test(String(file || '').replace(/\\/g, '/'));
}

function isLocalState(file) {
  const norm = String(file || '').replace(/\\/g, '/');
  return LOCAL_STATE_DIRS.some((d) => norm.startsWith(d) || norm.includes(`/${d}`));
}

/**
 * 判定一个改动集能否构成「一个可提交的单元」。
 *
 * **纯函数**：同输入必得同输出，零 I/O。这是 `[DESIGN-GIT-004]` §8「判定确定性」的落点。
 *
 * @param {Array<{status:string, path:string, mtimeMs?:number}>} changes
 *        改动集。status 取 git 的 `A`/`M`/`D`/`R`。
 * @param {{taskStartedAt?:number, verifyPending?:boolean, intent?:string}} [ctx]
 *        taskStartedAt：本会话开工时间（判 T3 卷入他人改动）；verifyPending：是否有验证证据。
 * @returns {{ok:boolean, findings:Array<{severity:string,finding:string,file:string,line:number,message:string}>}}
 */
function evaluate(changes, ctx = {}) {
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.path) : [];
  const findings = [];
  /**
   * 报一条判据。
   * @param {'T1'|'T2'|'T3'|'T4'|'T5'} criterion 判据编号（决定强度）
   * @param {string} finding finding id
   * @param {string} file 锚点
   * @param {string} message 人话说明
   */
  const add = (criterion, finding, file, message) => {
    findings.push({ severity: severityFor(criterion), finding, file, line: 1, message });
  };

  if (!list.length) return { ok: true, findings: [] };

  const codeFiles = list.filter((c) => isCode(c.path) && c.status !== 'D');
  const docOnly = list.length > 0 && list.every((c) => isDoc(c.path));

  // ── T1 单元闭合：顶层板块跨度 ──────────────────────────────────────
  // ⚠ 例外（不算多意图）：① 文档 + 其代码的同步（SOURCING-006 本就要求成批做）；
  //   ② 测试 + 被测代码。故判据是「代码板块跨度」而非「板块跨度」。
  const codeBlocks = new Set(codeFiles.map((c) => topBlock(c.path)).filter(Boolean));
  const allBlocks = new Set(list.map((c) => topBlock(c.path)).filter(Boolean));
  // 文档总跟代码走，不计入意图跨度。
  const intentBlocks = new Set([...allBlocks].filter((b) => b !== 'docs' && b !== 'scripts'));
  if (codeBlocks.size >= 3 || intentBlocks.size >= 3) {
    const blocks = [...(codeBlocks.size >= 3 ? codeBlocks : intentBlocks)].join(', ');
    add(
      'T1',
      'unit-multi-intent',
      list[0].path,
      `改动集跨 ${codeBlocks.size >= 3 ? codeBlocks.size : intentBlocks.size} 个顶层板块（${blocks}）` +
        ' —— T1 要求一个提交只有一个逻辑意图。若确实是一个单元（如文档+执行器同步），' +
        '请在提交信息里说明；否则请拆分。'
    );
  }

  // ── T2 可运行：有验证证据 ──────────────────────────────────────────
  // 只改文档/配置的单元不要求运行验证（否则每个文档提交都要报，误报会让人整体忽略本守卫）。
  if (codeFiles.length && !docOnly && !ctx.verifyPending) {
    add(
      'T2',
      'unit-unverified',
      codeFiles[0].path,
      `改了 ${codeFiles.length} 个代码文件但没有验证证据 —— T2「没跑过的不算做完」。` +
        `请把验证命令的原始输出存到 .khy/feedback/<task-id>/verify.txt（不许转述）。` +
        `若本单元确实无法运行验证（如纯声明性改动），请在提交信息里写明原因。`
    );
  }

  // ── T3 仓库自洽：未卷入并发方改动 / 本机态 ──────────────────────────
  const localState = list.filter((c) => isLocalState(c.path));
  if (localState.length) {
    add(
      'T3',
      'unit-sweeps-foreign-changes',
      localState[0].path,
      `暂存集含 ${localState.length} 个本机态文件（如 ${localState[0].path}）—— ` +
        '这些是被 gitignore 的运行态，通常由 `git add -A`/`git add .` 误收。请显式 `git add <路径>`。'
    );
  } else if (ctx.taskStartedAt && Number.isFinite(ctx.taskStartedAt)) {
    // mtime 早于本会话开工 + 不在本次意图内 ⇒ 极可能是并发方未提交的改动。
    const foreign = list.filter((c) => Number.isFinite(c.mtimeMs) && c.mtimeMs < ctx.taskStartedAt);
    if (foreign.length && foreign.length >= list.length * 0.5 && list.length >= 5) {
      add(
        'T3',
        'unit-sweeps-foreign-changes',
        foreign[0].path,
        `暂存集里 ${foreign.length}/${list.length} 个文件的修改时间早于本会话开工时间 —— ` +
          '本仓多智能体并发写，`git add -A` 会把别人的未提交改动卷进你的提交（而 git log 看起来正常）。' +
          '请只 `git add` 你本次真正改动的路径。'
      );
    }
  }

  // ── T4 无游离产物 ──────────────────────────────────────────────────
  const strays = list.filter((c) => isStray(c.path));
  if (strays.length) {
    add(
      'T4',
      'unit-stray-artifacts',
      strays[0].path,
      `暂存集含 ${strays.length} 个游离产物（如 ${strays[0].path}）—— ` +
        'tmp-* / *.tmp / probe / *.bak / *.orig 不应入库。请 `git restore --staged <路径>` 后清理。'
    );
  }

  // ── T5 可回滚 ──────────────────────────────────────────────────────
  // 判据用 git 语义：一次提交若能单独 revert 即达标。含删除的额外要求见 RUNTIME-009，
  // 本规范不重复报（避免同一问题两条 finding）。
  if (list.length > ASK_FILE_COUNT) {
    add(
      'T5',
      'unit-not-rollbackable',
      list[0].path,
      `改动集含 ${list.length} 个文件（> ${ASK_FILE_COUNT}）—— T5 要求一个提交能被单独 revert。` +
        '这么大的单元一旦出错只能整体回退，且无法二分定位。请按逻辑意图分片。'
    );
  }

  return { ok: findings.length === 0, findings };
}

// ────────────────────────────────────────────────────────────────────────────
// I/O 层
// ────────────────────────────────────────────────────────────────────────────

/** 预置场景：让反例可复现（`[DESIGN-GIT-004]` §9 的机器可跑版本）。 */
const SCENARIOS = {
  'clean-unit': {
    changes: [{ status: 'M', path: 'services/backend/src/cli/router.js' }],
    verifyPending: true,
  },
  'unit-multi-intent': {
    changes: [
      { status: 'M', path: 'services/backend/src/cli/router.js' },
      { status: 'M', path: 'apps/ai-frontend/src/App.vue' },
      { status: 'A', path: 'extensions/demo/index.js' },
    ],
    verifyPending: true,
  },
  'unit-unverified': {
    changes: [{ status: 'M', path: 'services/backend/src/services/aiGateway.js' }],
    verifyPending: false,
  },
  'unit-stray-artifacts': {
    changes: [
      { status: 'M', path: 'services/backend/src/cli/router.js' },
      { status: 'A', path: 'tmp-probe.js' },
      { status: 'A', path: 'docs/_probe_out.txt' },
    ],
    verifyPending: true,
  },
  'sweeps-foreign': {
    changes: [
      { status: 'M', path: '.khy/settings.json' },
      { status: 'M', path: '.khyos/diag/scan-structure.py' },
      { status: 'M', path: 'services/backend/src/cli/router.js' },
    ],
    verifyPending: true,
  },
  'docs-only': {
    changes: [
      { status: 'M', path: 'docs/10_规范/DESIGN-GIT/[DESIGN-GIT-004] 提交时机规范.md' },
      { status: 'M', path: 'docs/10_规范/DESIGN-GIT/00_INDEX_DESIGN-GIT-总目录.md' },
    ],
    verifyPending: false,
  },
};

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : '';
}

/**
 * 传给 `--files=` 的值。
 *
 * ⚠ `--files=`（空值）与「未提供 `--files`」必须可区分，否则会静默 fall through 到
 * 读真实暂存集 —— 在本仓会读到数千项，而调用方以为自己在测一个空集。
 * 故返回 `null`（未提供）而非 `''`，由调用方显式判断。
 */
function filesArgOrNull() {
  const hit = process.argv.find((a) => a.startsWith('--files='));
  return hit ? hit.slice('--files='.length) : null;
}

function parseFilesArg(s) {
  return String(s || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const i = t.indexOf(':');
      return i > 0 ? { status: t.slice(0, i), path: t.slice(i + 1) } : { status: 'M', path: t };
    });
}

/**
 * 收集**待提交集**（提交单元 = 暂存区）。
 *
 * ⚠ 这里必须是 `--cached` 而不是工作区全量。本仓工作区长期有 3000~4000 项未提交
 * （实测 4002），若按工作区全量判，任何一次提交都会得到「跨 10 个板块 / 3993 个文件」
 * 这种**真实但不可行动**的结论 —— 读数全偏，守卫的 4 条 finding 会变成常驻噪声，
 * 而噪声会被整体忽略（比没有守卫更糟）。
 *
 * 门（ruleguard `--changed`）传入时的语义也正是「本次提交的内容」，
 * 与 `.githooks/pre-commit` 的 `git diff --cached` 一致 —— 三者对齐。
 * 需要看尚未暂存的改动时用 `--worktree`（明确、非常态）。
 */
function collectStaged() {
  const out = git(['diff', '--cached', '--name-status', '-z']);
  if (!out) return [];
  return parseNameStatusZ(out);
}

/** 工作区全部改动（未暂存 + 已暂存）。仅 `--worktree` 时用。 */
function collectWorktree() {
  const out = git(['status', '--porcelain=v1', '-z']);
  if (!out) return [];
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (const p of parts) {
    // porcelain v1 -z: "XY <path>"（重命名时后随原路径，此处不细分）
    const m = /^([ MADRCU?!]{2}) (.+)$/.exec(p);
    if (!m) continue;
    const xy = m[1];
    const status = xy.includes('D') ? 'D' : xy.includes('A') || xy.includes('?') ? 'A' : 'M';
    changes.push({ status, path: m[2] });
  }
  return changes;
}

/** 解析 `git diff --name-status -z` 的输出（含 R/C 两段式）。 */
function parseNameStatusZ(out) {
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i += 1) {
    const st = parts[i];
    if (!/^[AMDRC]/.test(st)) continue;
    if (/^[RC]/.test(st)) {
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 2;
      if (to) changes.push({ status: st[0], path: to, from });
    } else {
      const p = parts[i + 1];
      i += 1;
      if (p) changes.push({ status: st[0], path: p });
    }
  }
  return changes;
}

/** 判断是否存在验证证据（`.khy/feedback/<task-id>/verify.txt`）。 */
function hasVerifyEvidence() {
  const base = path.join(REPO_ROOT, '.khy', 'feedback');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const v = path.join(base, e.name, 'verify.txt');
      if (fs.existsSync(v) && fs.statSync(v).size > 0) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function main() {
  const changedMode = process.argv.includes('--changed');
  const explain = process.argv.includes('--explain');
  const scenario = argValue('--scenario');
  const filesArg = filesArgOrNull();

  let result;
  let ctx = {};

  if (scenario) {
    const sc = SCENARIOS[scenario];
    if (!sc) {
      process.stderr.write('未知场景：' + scenario + '\n可用：' + Object.keys(SCENARIOS).join(' ') + '\n');
      return 2;
    }
    result = sc.changes;
    ctx = { verifyPending: sc.verifyPending };
  } else if (filesArg !== null) {
    result = parseFilesArg(filesArg);
    ctx = { verifyPending: true }; // 自定义集合默认「已备验证」，专注测 T1/T4/T5
  } else {
    const worktreeMode = process.argv.includes('--worktree');
    result = worktreeMode ? collectWorktree() : collectStaged();
    ctx = { verifyPending: hasVerifyEvidence() };
  }

  const { findings } = evaluate(result, ctx);
  const errors = findings.filter((f) => f.severity === SEV_ERROR);
  const warnings = findings.filter((f) => f.severity === SEV_WARNING);

  // ⚠ `--changed` 一票否决 verbose：门里的消费者只认 finding 方言。
  const verbose = !changedMode;

  if (verbose) {
    process.stdout.write('check-commit-timing: 提交时机判据（PROCESS-009 / [DESIGN-GIT-004]）\n');
    process.stdout.write(`stage: ${STAGE} · changes: ${result.length} · verify: ${ctx.verifyPending ? 'yes' : 'no'}\n`);
    if (!findings.length) process.stdout.write('result: no commit-timing findings.\n');
    else {
      process.stdout.write('result:\n');
      for (const f of [...errors, ...warnings]) {
        process.stdout.write(`[${labelOf(f.severity)}] ${f.finding} ${f.file}:${f.line}\n`);
        process.stdout.write(`  ${f.message}\n`);
      }
    }
  } else {
    for (const f of [...errors, ...warnings]) {
      process.stdout.write(`[${labelOf(f.severity)}] ${f.finding} ${f.file}:${f.line}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
  }

  if (explain && verbose) {
    process.stdout.write('\n判据：\n');
    process.stdout.write('  T1 单元闭合（一个逻辑意图）→ unit-multi-intent\n');
    process.stdout.write('  T2 可运行（有验证证据）→ unit-unverified\n');
    process.stdout.write('  T3 仓库自洽（未卷入并发方改动）→ unit-sweeps-foreign-changes\n');
    process.stdout.write('  T4 无游离产物 → unit-stray-artifacts\n');
    process.stdout.write('  T5 可回滚 → unit-not-rollbackable\n');
  }

  process.stdout.write(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);

  // S1 观察者（PP-3）：恒 exit 0，只记录不阻断。
  if (STAGE === 'S1' || STAGE === 'S2') return 0;
  return errors.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, evaluate, topBlock, extOf, isCode, isStray, isLocalState, SCENARIOS, STAGE };
