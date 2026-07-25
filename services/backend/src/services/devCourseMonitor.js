'use strict';

/**
 * devCourseMonitor.js — 开发过程「在途纠偏」：用户用 Khyos 开发时，主动监听开发轨迹，
 * 在跑偏酿成大错前及早提示修正航向，避免任务做完才发现方向错、被迫大改。
 *
 * 背景(goal 2026-06-25):
 *   bugSentinel 盯的是「运行时内部状态」(被吞错误 / 不变量违反 / 滑窗越阈值) —— 那是
 *   khy 自身的健康。本模块盯的是另一层:**用户开发任务的轨迹**。模型在多轮工具循环里
 *   边改边跑,容易出现几类「方向性」隐患,而它们往往要等任务收尾才暴露、届时返工成本最大:
 *
 *     A) 测试回归(regression)        —— 之前绿的测试现在红了 / 失败数变多:在红的地基上
 *                                       继续堆改动,越走越偏。最强的「停一下」信号。
 *     B) 未验证churn(unverified)     —— 连改多文件多处却一直没跑过测试/构建:无反馈地
 *                                       狂奔,错误累积到最后一次性爆发 = 典型「完成后大改」。
 *     C) 反复改同一文件(thrash)      —— 同一文件被反复改动多次:方案多半有问题,该退一步。
 *     D) 连续失败(failure-streak)    —— 连续多轮工具调用失败:盲目重试,该换思路或澄清需求。
 *
 *   这些都是**保守**判定:阈值取得偏高,健康的短任务零误报。命中后只产出一段
 *   `[SYSTEM: 航向提示 ...]` 作为**上下文参考**(可采用 / 改写 / 忽略),绝不强制、绝不打断,
 *   与既有的「结果反思提示」同一非侵入哲学。
 *
 * 纯叶子:零 IO、确定性、状态由调用方(loop)持有的普通对象承载,便于单测。
 *
 * env:
 *   KHY_DEV_COURSE_MONITOR = off|on   (默认 on;off 关闭监听与注入)
 *   KHY_DEV_COURSE_CHURN_EDITS        未验证编辑数阈值(默认 8)
 *   KHY_DEV_COURSE_CHURN_FILES        未验证涉及文件数阈值(默认 3)
 *   KHY_DEV_COURSE_THRASH             单文件反复改动阈值(默认 4)
 *   KHY_DEV_COURSE_STREAK             连续失败轮次阈值(默认 3)
 *
 * 用法(loop 接缝):
 *   const st = createState();
 *   // 每轮工具结果后:
 *   recordIteration(st, { toolResults, testFindings }, env);
 *   const a = assess(st, env);
 *   if (a.drift) inject(a.directive);     // 注入 [SYSTEM: 航向提示 …]
 *   // 收尾:
 *   if (hasCorrections(st)) result.courseCorrections = summarize(st);
 */

const DEFAULT_CHURN_EDITS = 8;
const DEFAULT_CHURN_FILES = 3;
const DEFAULT_THRASH = 4;
const DEFAULT_STREAK = 3;

// 编辑类工具(归一化名)：写文件 / 改文件 / 多处编辑 / 打补丁。
const _EDIT_RE = /^(write|writefile|edit|editfile|createfile|multiedit|applypatch|patch|scaffoldfiles)$/;

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/normalizeToolName');

function isEnabled(env = process.env) {
  const v = env && env.KHY_DEV_COURSE_MONITOR;
  return v !== 'off' && v !== '0' && v !== 'false';
}

function _intEnv(env, key, def, min) {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= (min == null ? 1 : min) ? Math.floor(v) : def;
}
function _thresholds(env = process.env) {
  return {
    churnEdits: _intEnv(env, 'KHY_DEV_COURSE_CHURN_EDITS', DEFAULT_CHURN_EDITS, 2),
    churnFiles: _intEnv(env, 'KHY_DEV_COURSE_CHURN_FILES', DEFAULT_CHURN_FILES, 1),
    thrash: _intEnv(env, 'KHY_DEV_COURSE_THRASH', DEFAULT_THRASH, 2),
    streak: _intEnv(env, 'KHY_DEV_COURSE_STREAK', DEFAULT_STREAK, 2),
  };
}

/** 新建一份开发轨迹状态(每个任务/loop 一份)。 */
function createState() {
  return {
    iteration: 0,
    edits: 0,                  // 累计编辑操作数
    editsByFile: new Map(),    // file -> 编辑次数
    editsSinceVerify: 0,       // 距上次「验证(跑测试)」以来的编辑数
    filesSinceVerify: new Set(),
    verifiedCount: 0,          // 任务内验证(测试运行)总次数
    failureStreak: 0,          // 连续「本轮有工具失败」的轮数
    testBaseline: new Map(),   // framework -> { everGreen, lastGreen, lastFailed, bestFailedRed }
    announced: new Set(),      // 已浮出的 signal key(同一 episode 去重;条件解除后重新武装)
    corrections: [],           // 已浮出过的纠偏(供 summarize)
  };
}

function _extractPath(params) {
  if (!params || typeof params !== 'object') return null;
  const p = params.path || params.file_path || params.filePath || params.filename || params.file || params.target;
  return typeof p === 'string' && p ? p : null;
}

/**
 * 折叠一轮工具结果与测试发现进轨迹状态。纯累积、绝不抛。
 * @param {object} state              createState() 产物
 * @param {object} input
 * @param {Array}  input.toolResults  本轮工具结果 [{ tool, params, result, ... }]
 * @param {Array}  input.testFindings 本轮解析出的测试发现(keyFindings.detectTestOutcome 产物)
 */
function recordIteration(state, input = {}, env = process.env) {
  if (!state) return;
  try {
    state.iteration += 1;
    const toolResults = Array.isArray(input.toolResults) ? input.toolResults : [];
    const testFindings = Array.isArray(input.testFindings) ? input.testFindings : [];

    let hadFailure = false;
    for (const tr of toolResults) {
      if (!tr) continue;
      const name = _norm(tr.tool);
      if (tr.result && tr.result.success === false) hadFailure = true;
      if (_EDIT_RE.test(name)) {
        state.edits += 1;
        state.editsSinceVerify += 1;
        const f = _extractPath(tr.params) || `<${name}>`;
        state.editsByFile.set(f, (state.editsByFile.get(f) || 0) + 1);
        state.filesSinceVerify.add(f);
      }
    }
    // 连续失败轮:本轮任一工具失败则 +1,否则归零(反映「连着几轮都不顺」)。
    state.failureStreak = hadFailure ? state.failureStreak + 1 : 0;

    // 测试运行 = 一次「验证检查点」:重置未验证 churn 计数,并更新回归基线。
    for (const t of testFindings) {
      if (!t || t.kind !== 'test') continue;
      state.verifiedCount += 1;
      state.editsSinceVerify = 0;
      state.filesSinceVerify.clear();

      const fw = t.framework || 'test';
      const failed = Number.isFinite(t.failed) ? t.failed : (t.green ? 0 : 1);
      const green = t.green === true || failed === 0;
      let b = state.testBaseline.get(fw);
      if (!b) { b = { everGreen: false, lastGreen: null, lastFailed: null, bestFailedRed: null }; state.testBaseline.set(fw, b); }
      b.lastGreen = green;
      b.lastFailed = failed;
      if (green) b.everGreen = true;
      else b.bestFailedRed = b.bestFailedRed == null ? failed : Math.min(b.bestFailedRed, failed);
      // 保存最近一次失败用例样本,供提示文本引用。
      if (!green && Array.isArray(t.failures) && t.failures.length) b._sample = t.failures.slice(0, 2).join(', ');
      else if (green) b._sample = '';
    }
  } catch { /* 监听器纯累积,绝不反噬 loop */ }
}

/**
 * 评估当前轨迹是否跑偏。返回**本次新出现**(未浮出过)的纠偏信号 + 合成的航向提示。
 * 同一条件持续不重复打扰(episode 去重);条件解除后重新武装,再次出现可再提示。
 * @returns {{ drift:boolean, signals:Array, directive:string|null }}
 */
function assess(state, env = process.env) {
  if (!state || !isEnabled(env)) return { drift: false, signals: [], directive: null };
  let candidates = [];
  try {
    const T = _thresholds(env);

    // A) 测试回归:之前绿过现在红 / 红状态下失败数比最好时更多。
    for (const [fw, b] of state.testBaseline.entries()) {
      const red = b.lastGreen === false;
      const worsened = red && b.bestFailedRed != null && b.lastFailed > b.bestFailedRed;
      if (red && (b.everGreen || worsened)) {
        const why = b.everGreen ? '之前通过的' : '失败数变多的';
        const sample = b._sample ? `(${b._sample})` : '';
        candidates.push({
          key: `regression:${fw}`,
          type: 'regression',
          severity: 'high',
          detail: `${why} ${fw} 现有 ${b.lastFailed} 项失败${sample},建议先修复回归、别在红的地基上继续堆改动`,
        });
      }
    }

    // B) 未验证 churn:改了一堆却没跑过测试 —— 典型「完成后大改」前兆。
    if (state.editsSinceVerify >= T.churnEdits && state.filesSinceVerify.size >= T.churnFiles) {
      candidates.push({
        key: 'churn',
        type: 'unverified-churn',
        severity: 'medium',
        detail: `已改动 ${state.filesSinceVerify.size} 个文件共 ${state.editsSinceVerify} 处、尚未跑过测试/构建,建议先设一个检查点验证再继续,避免错误累积到收尾才一次性爆发`,
      });
    }

    // C) 反复改同一文件:方案可能有问题。
    for (const [file, n] of state.editsByFile.entries()) {
      if (n >= T.thrash) {
        candidates.push({
          key: `thrash:${file}`,
          type: 'thrash',
          severity: 'medium',
          detail: `${file} 已被反复改动 ${n} 次,可能当前方案需要退一步重新审视`,
        });
      }
    }

    // D) 连续失败:盲目重试,该换思路或澄清。
    if (state.failureStreak >= T.streak) {
      candidates.push({
        key: 'streak',
        type: 'failure-streak',
        severity: 'medium',
        detail: `连续 ${state.failureStreak} 轮工具调用失败,建议换一种思路或向用户澄清需求,而非继续重试`,
      });
    }
  } catch { return { drift: false, signals: [], directive: null }; }

  // episode 去重 + 重新武装:解除的条件从 announced 移除,新条件才浮出。
  const activeKeys = new Set(candidates.map(c => c.key));
  for (const k of [...state.announced]) {
    if (!activeKeys.has(k)) state.announced.delete(k);
  }
  const fresh = candidates.filter(c => !state.announced.has(c.key));
  for (const c of fresh) state.announced.add(c.key);

  if (!fresh.length) return { drift: false, signals: [], directive: null };

  // 强信号优先排序(回归在前)。
  fresh.sort((a, b) => (a.severity === 'high' ? -1 : 1) - (b.severity === 'high' ? -1 : 1));
  const directive = buildCourseCorrectionHint(fresh);
  for (const c of fresh) state.corrections.push({ type: c.type, severity: c.severity, detail: c.detail, at: state.iteration });
  return { drift: true, signals: fresh, directive };
}

/** 把纠偏信号合成一段「上下文参考」式提示(可采用 / 改写 / 忽略)。 */
function buildCourseCorrectionHint(signals) {
  if (!Array.isArray(signals) || !signals.length) return null;
  const lines = signals.map((s, i) => `${i + 1}. ${s.detail}`);
  return `[SYSTEM: 航向提示(开发过程在途监听 · 仅供参考,可采用/改写/忽略):\n${lines.join('\n')}\n—— 若方向无误可忽略此提示并继续;若确有偏差,建议现在小步纠正,避免任务收尾后大改。]`;
}

/** 是否已浮出过任何纠偏(供 loop 返回契约判定)。 */
function hasCorrections(state) {
  return !!(state && state.corrections && state.corrections.length);
}

/** 收尾摘要:挂到 loop 返回契约,供 UI/程序消费。 */
function summarize(state) {
  if (!state) return null;
  const byType = {};
  for (const c of state.corrections) byType[c.type] = (byType[c.type] || 0) + 1;
  return {
    iterations: state.iteration,
    edits: state.edits,
    filesTouched: state.editsByFile.size,
    verified: state.verifiedCount,
    corrections: state.corrections.slice(-10),
    byType,
  };
}

module.exports = {
  isEnabled,
  createState,
  recordIteration,
  assess,
  buildCourseCorrectionHint,
  hasCorrections,
  summarize,
  _DEFAULTS: { DEFAULT_CHURN_EDITS, DEFAULT_CHURN_FILES, DEFAULT_THRASH, DEFAULT_STREAK },
};
