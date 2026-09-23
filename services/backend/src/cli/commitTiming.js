'use strict';

/**
 * commitTiming.js — 提交时机决策的**纯叶子**（`PROCESS-009` / `[DESIGN-GIT-004]`）。
 *
 * ## 为什么是纯叶子
 *
 * 判定必须**确定性、可单测、零 IO** —— 本文件的 docstring 承诺纯叶子契约
 * （零 IO / env 门控 KHY_COMMIT_TIMING / fail-soft 绝不抛），由
 * `scripts/lib/leafContractGuard.js` 机器强制。
 *
 * git 的读（`git diff --cached`）与写（`git commit`）全在
 * `src/cli/handlers/commit.js`，本文件只吃**已经采好的数据**并给结论。
 * 这样做的直接好处：同一批暂存文件在任何机器、任何时刻都得到同一个结论，
 * 且测试不需要造 git 仓库。
 *
 * ## 与 `scripts/ci/check-commit-timing.js` 的关系（别混淆，二者分工明确）
 *
 * | | `$g check-commit-timing.js` | 本文件（+ handler） |
 * |---|---|---|
 * | 时机 | **提交前**的守卫检查（门档 commit） | AI/人**决定要不要提交**时 |
 * | 角色 | 判「这次提交合不合判据」，只记录（S1） | 判「现在该不该提交」，可**直接执行** |
 * | 方向 | 否决型（列出问题） | 决策型（给结论 + 下一步动作） |
 * | 强度 | 恒 exit 0（S1 观察者） | 不适用（是决策不是门禁） |
 *
 * ⚠ **判据是同一套**（T1–T5）—— 本文件与守卫共用同一批判据定义，
 *   但**不 require 守卫**：守卫在 `scripts/ci/` 下（跨层），且它是 CLI 不是库
 *   （`check:layout` 的 `cross-layer-require` 会记账）。故判据在这里以纯函数重述，
 *   并由 `scripts/tests/check-commit-timing.test.js` 的对照用例保证两边不漂移。
 *
 * ## 核心结论只有三种（`decide()` 的返回值）
 *
 * - `commit-now`   —— 判据全绿：**AI 可直接提交**，不必逐次问人
 * - `ask-first`    —— 触发安全护栏：**必须先问人**（含删除 / 改动过大 / 敏感路径）
 * - `do-not-commit`—— 判据不满足：**别提交**，并说清缺哪一条
 *
 * @module cli/commitTiming
 */

/**
 * env 门控（默认**开**）。
 *
 * 与既有纯叶子同构：`KHY_*` 默认开，只有显式关闭值才关。
 * ⚠ 不要改成「未设置即关闭」—— 本仓既有 hook/叶子都不带 env 门控，
 *   「被写进调用路径」本身就是同意；要求显式开启会得到一条永不开火的死机制。
 */
const ENV_FLAG = 'KHY_COMMIT_TIMING';

const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 默认开；只有显式关闭值才关。 */
function isEnabled(env = process.env) {
  const v = String((env && env[ENV_FLAG]) || '').toLowerCase().trim();
  return !_OFF.has(v);
}

/** 顶层板块（对应 [DESIGN-LAY-005] 的 L0~L6）：判「一个逻辑意图」用。 */
const TOP_BLOCKS = [
  'kernel', 'platform', 'services', 'apps', 'software',
  'extensions', 'tools', 'docs', 'scripts', 'packaging', 'deploy', 'electron',
];

const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.py',
  '.c', '.h', '.asm', '.dart', '.go', '.rs',
]);

const DOC_EXTS = new Set(['.md', '.html', '.txt', '.json', '.yaml', '.yml', '.css', '.svg']);

/** 游离产物（与 pre-commit 第 1 项口径一致）。 */
const STRAY_RE = /(^|\/)(tmp-|tmp_|\.tmp$)|\.tmp$|(^|\/)probe[-_]|(^|\/)_probe|\.bak$|\.orig$/;

/** 本机态 / 不该入库的目录：出现即极可能是 `git add -A` 卷进来的。 */
const LOCAL_STATE_DIRS = ['.khy/', '.khyos/', '.khyquant/', 'khy-Trajectory/', '.zcode/tmp/'];

/**
 * 安全护栏：触发即改为「先问人」。
 *
 * ⚠ `fileCount` 的 20 与 `$g check-change-safety.js` 的 `ERROR_CHANGED_FILE_COUNT = 20`
 *   同值 —— 那已是本仓既有的「这次改动太大了」判据，不新造阈值。
 */
const ASK_FILE_COUNT = 20;

/** 敏感路径：命中即「先问人」（推送到远端前必须人看一眼）。 */
const SENSITIVE_PATHS = [
  '.github/', '.githooks/', 'deploy/', 'Dockerfile', 'fly.',
  'package.json', 'pyproject.toml', 'pnpm-workspace.yaml',
];

/** 逻辑意图的分片：这些顶层目录**跟随**代码走，单独出现不计入意图数。 */
const FOLLOWERS = new Set(['docs', 'scripts']);

// ────────────────────────────────────────────────────────────────────────────
// 纯函数工具
// ────────────────────────────────────────────────────────────────────────────

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function topBlock(file) {
  const seg = normPath(file).split('/')[0] || '';
  if (!seg || seg.startsWith('.')) return '';
  return seg;
}

function extOf(file) {
  const base = normPath(file).split('/').pop() || '';
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
  return STRAY_RE.test(normPath(file));
}

function isLocalState(file) {
  const n = normPath(file);
  return LOCAL_STATE_DIRS.some((d) => n.startsWith(d) || n.includes(`/${d}`));
}

function isSensitive(file) {
  const n = normPath(file);
  return SENSITIVE_PATHS.some((s) => n === s || n.startsWith(s) || n.includes(`/${s}`));
}

// ────────────────────────────────────────────────────────────────────────────
// 判据 T1–T5（与 $g check-commit-timing.js 同源，纯函数）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 评估一个改动集。**纯函数**：同输入必得同输出。
 *
 * @param {Array<{status:string,path:string,mtimeMs?:number}>} changes
 * @param {{verifyPending?:boolean,taskStartedAt?:number,intent?:string}} [ctx]
 * @returns {{violations:Array<{criterion:string,id:string,file:string,message:string,level:string}>}}
 */
function assess(changes, ctx = {}) {
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.path) : [];
  const violations = [];
  const add = (criterion, id, file, message, level) =>
    violations.push({ criterion, id, file, message, level: level || 'blocking' });

  if (!list.length) return { violations: [] };

  const codeFiles = list.filter((c) => isCode(c.path) && c.status !== 'D');
  const docOnly = list.every((c) => isDoc(c.path));

  // ── T1 单元闭合 ─────────────────────────────────────────────────
  const codeBlocks = new Set(codeFiles.map((c) => topBlock(c.path)).filter(Boolean));
  const intentBlocks = new Set(
    list.map((c) => topBlock(c.path)).filter((b) => b && !FOLLOWERS.has(b))
  );
  if (codeBlocks.size >= 3 || intentBlocks.size >= 3) {
    const n = Math.max(codeBlocks.size, intentBlocks.size);
    add(
      'T1', 'unit-multi-intent', list[0].path,
      `改动集跨 ${n} 个顶层板块 —— 一个提交应只有一个逻辑意图。`
    );
  }

  // ── T2 可运行 ───────────────────────────────────────────────────
  if (codeFiles.length && !docOnly && !ctx.verifyPending) {
    add(
      'T2', 'unit-unverified', codeFiles[0].path,
      `改了 ${codeFiles.length} 个代码文件但没有验证证据（.khy/feedback/<task-id>/verify.txt）。`
    );
  }

  // ── T3 仓库自洽 ─────────────────────────────────────────────────
  const localState = list.filter((c) => isLocalState(c.path));
  if (localState.length) {
    add(
      'T3', 'unit-sweeps-foreign-changes', localState[0].path,
      `暂存集含 ${localState.length} 个本机态文件 —— 疑似 git add -A 误收。`
    );
  } else if (Number.isFinite(ctx.taskStartedAt)) {
    const foreign = list.filter((c) => Number.isFinite(c.mtimeMs) && c.mtimeMs < ctx.taskStartedAt);
    if (foreign.length >= 5 && foreign.length >= list.length * 0.5) {
      add(
        'T3', 'unit-sweeps-foreign-changes', foreign[0].path,
        `暂存集里 ${foreign.length}/${list.length} 个文件早于本会话开工时间 —— 疑似卷入并发方改动。`
      );
    }
  }

  // ── T4 无游离产物 ───────────────────────────────────────────────
  const strays = list.filter((c) => isStray(c.path));
  if (strays.length) {
    add('T4', 'unit-stray-artifacts', strays[0].path, `暂存集含 ${strays.length} 个游离产物。`);
  }

  // ── T5 可回滚（建议级：不阻断，只提示）─────────────────────────
  if (list.length > ASK_FILE_COUNT) {
    add(
      'T5', 'unit-not-rollbackable', list[0].path,
      `改动集含 ${list.length} 个文件（> ${ASK_FILE_COUNT}）—— 难以单独 revert。`,
      'advisory'
    );
  }

  return { violations };
}

/**
 * 给结论。**这是本模块的公开主入口。**
 *
 * 三种结论，优先级 `do-not-commit` > `ask-first` > `commit-now`：
 * 「判据不满足」比「该问人」更根本 —— 先把它修好再谈问不问。
 *
 * @param {Array} changes 改动集
 * @param {{verifyPending?:boolean,taskStartedAt?:number,intent?:string}} [ctx]
 * @returns {{
 *   decision:string, reason:string, violations:Array,
 *   blockers:Array, advisory:Array, suggestions:string[]
 * }}
 */
function decide(changes, ctx = {}) {
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.path) : [];
  const { violations } = assess(list, ctx);
  const blockers = violations.filter((v) => v.level === 'blocking');
  const advisory = violations.filter((v) => v.level !== 'blocking');

  const result = { decision: '', reason: '', violations, blockers, advisory, suggestions: [] };

  // 无改动：不是「可以提交」，是「没东西可提交」。
  if (!list.length) {
    result.decision = 'do-not-commit';
    result.reason = '暂存区为空 —— 先 git add 你真正改动的路径（不要用 git add -A）。';
    return result;
  }

  // ── 优先级 1：判据不满足 ────────────────────────────────────────
  if (blockers.length) {
    result.decision = 'do-not-commit';
    result.reason = `未满足 ${blockers.length} 条判据：${blockers.map((b) => b.criterion).join('/')}。修好再来，别把半成品固化进历史。`;
    result.suggestions = blockers.map((b) => `${b.criterion} ${b.id}：${b.message}`);
    return result;
  }

  // ── 优先级 2：安全护栏 —— 值得问人 ──────────────────────────────
  const deletions = list.filter((c) => c.status === 'D');
  const sensitive = list.filter((c) => isSensitive(c.path));
  const blocks = new Set(list.map((c) => topBlock(c.path)).filter(Boolean));
  const intentBlocks = new Set([...blocks].filter((b) => !FOLLOWERS.has(b)));

  if (deletions.length) {
    result.decision = 'ask-first';
    result.reason = `含 ${deletions.length} 个删除 —— 删除不可逆，转 RUNTIME-009（先出 scrub-plan.md + rollback.txt）。`;
    return result;
  }
  if (list.length > ASK_FILE_COUNT) {
    result.decision = 'ask-first';
    result.reason = `改动集含 ${list.length} 个文件（> ${ASK_FILE_COUNT}）—— 请人确认这次是否该作为一个提交。`;
    return result;
  }
  if (intentBlocks.size >= 3) {
    result.decision = 'ask-first';
    result.reason = `跨 ${intentBlocks.size} 个顶层板块 —— 疑似多个意图混在一起，请人确认或拆分。`;
    return result;
  }
  if (sensitive.length) {
    result.decision = 'ask-first';
    result.reason = `触及敏感路径（${sensitive[0].path}）—— 请人看一眼再提交。`;
    return result;
  }

  // ── 优先级 3：全绿 → 直接提交 ───────────────────────────────────
  result.decision = 'commit-now';
  result.reason = `判据全绿（${list.length} 个文件），可以直接提交。`;
  result.suggestions = advisory.map((a) => `${a.criterion}（建议）：${a.message}`);
  return result;
}

/**
 * 生成建议的 commit message 主体（`<type>(<scope>): <描述>` 的 type 与 scope）。
 *
 * ⚠ 只给**建议**，最终描述由调用方（AI 或人）写 —— 本函数不猜业务语义，
 *   只从改动形状推 type 与 scope。这与 `[DESIGN-GIT-002]` §2.4
 *   「中文 + 动词前置 + 一句话说完」不冲突：那是对**描述**的要求，不是对 type 的要求。
 *
 * @param {Array} changes
 * @returns {{type:string, scope:string, reason:string}}
 */
function suggestMessage(changes) {
  const list = Array.isArray(changes) ? changes.filter((c) => c && c.path) : [];
  if (!list.length) return { type: '', scope: '', reason: '暂存区为空。' };

  const statuses = new Set(list.map((c) => c.status));
  const blocks = [...new Set(list.map((c) => topBlock(c.path)).filter(Boolean))];
  const scope = blocks.length === 1 ? blocks[0] : '';

  if (statuses.has('D')) return { type: 'refactor', scope, reason: '含删除 → refactor 或 revert。' };
  if (statuses.has('A') && !statuses.has('M')) {
    return { type: 'feat', scope, reason: '纯新增 → feat。' };
  }
  if (list.every((c) => isDoc(c.path))) return { type: 'docs', scope: 'docs', reason: '纯文档 → docs。' };
  if (list.some((c) => /(^|\/)tests?(\/|$)|\.test\.|\.spec\./.test(normPath(c.path)))) {
    return { type: 'test', scope, reason: '含测试文件 → test（若同时改了被测代码，按主意图选 feat/fix）。' };
  }
  return { type: 'fix', scope, reason: '默认 fix；若本次是加功能请改 feat，是重构请改 refactor。' };
}

module.exports = {
  ENV_FLAG,
  isEnabled,
  decide,
  assess,
  suggestMessage,
  // 纯函数工具，供测试与 handler 复用
  topBlock,
  extOf,
  isCode,
  isDoc,
  isStray,
  isLocalState,
  isSensitive,
  ASK_FILE_COUNT,
  SENSITIVE_PATHS,
  TOP_BLOCKS,
};
