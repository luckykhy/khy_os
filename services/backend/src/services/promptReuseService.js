'use strict';

/**
 * promptReuseService.js — Agent 提示词复用机制·编排层（推荐 + 回收）。
 *
 * 规范见 docs/03_DESIGN_设计/[DESIGN-ARCH-018] Agent提示词复用机制.md。
 *
 * 这是 Agent 执行链路与 promptReuseStore 之间的薄适配层，提供两个动作：
 *   1) recommendForTask(taskText) —— 新任务进入时，检索历史有效提示词，
 *      格式化成一段可前置到用户消息的「复用建议」上下文块（自然语言 + 来源标注）。
 *   2) captureOutcome({...}) —— 任务收尾时，登记本次用法并回写效果（成功率/耗时/反馈）。
 *
 * 设计约束（核心诉求 + 防呆）：
 *   - 动态复用：推荐项完全来自历史真实运行沉淀的配方，非静态预设。
 *   - 效果导向：检索按「相似度 × 效果」排序，低相似度阈值过滤误推荐。
 *   - 轻量集成 / 只加不改：本层**不触碰** constants/prompts.js 系统提示词装配，
 *     仅产出一段附加上下文交给调用方自行选择是否前置；建议块以显式 [SYSTEM:...]
 *     包裹，绝不混入或改写既有提示词内容。
 *   - 健壮：env 门控 + 全程 try/catch，任何异常一律静默降级，绝不崩 Agent。
 *
 * 环境开关：
 *   - KHY_PROMPT_REUSE ∈ {0,false,off,no} → 整体停用（recommend 返回 null，capture no-op）。
 *     缺省启用；无历史数据时 recommend 自然返回 null，零噪音零副作用。
 *   - KHY_PROMPT_REUSE_THRESHOLD → 覆盖相似度阈值（默认 0.35）。
 *   - KHY_PROMPT_REUSE_TOPK → 推荐条数上限（默认 2）。
 *
 * 零外部依赖（仅本仓 promptReuseStore）。
 */

const store = require('./promptReuseStore');

const DEFAULT_TOPK = 2;

function _enabled() {
  const v = String(process.env.KHY_PROMPT_REUSE || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function _threshold() {
  const n = parseFloat(process.env.KHY_PROMPT_REUSE_THRESHOLD);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : store.DEFAULT_THRESHOLD;
}

function _topK() {
  const n = parseInt(process.env.KHY_PROMPT_REUSE_TOPK, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TOPK;
}

/**
 * 轻量功能/场景分类：基于关键词把任务归入有限类别，供存储分桶与展示。
 * 与 constants/prompts.js 的 intent 引擎**解耦**（平行实现，不引入重依赖），
 * 仅用于本机制内部归类，绝不参与系统提示词装配。
 * @param {string} taskText
 * @returns {string}
 */
function classifyCategory(taskText) {
  const t = String(taskText || '').toLowerCase();
  const has = (...kw) => kw.some(k => t.includes(k));
  if (has('test', '测试', 'jest', '单测', 'spec')) return 'testing';
  if (has('refactor', '重构', '优化', 'optimize', 'cleanup')) return 'refactor';
  if (has('fix', 'bug', '修复', '报错', 'error', '崩溃')) return 'bugfix';
  if (has('doc', '文档', 'readme', '注释', '说明')) return 'docs';
  if (has('deploy', '部署', 'ci', 'docker', 'build', '构建', '发布')) return 'devops';
  if (has('api', '接口', 'route', '路由', 'endpoint', 'http')) return 'api';
  if (has('ui', '前端', '页面', 'component', '组件', 'css', 'react', 'vue')) return 'frontend';
  if (has('数据', 'data', 'sql', 'db', 'database', '查询', 'query')) return 'data';
  if (has('实现', 'implement', '新增', 'feature', '功能', 'add ')) return 'feature';
  return 'general';
}

/**
 * 为新任务检索并格式化「提示词复用建议」上下文块。
 *
 * @param {string} taskText
 * @param {object} [opts]
 * @param {number} [opts.threshold] 覆盖相似度阈值
 * @param {number} [opts.limit]     覆盖推荐条数
 * @returns {{ block:string, candidates:object[] } | null}
 *          无可推荐项（或停用）时返回 null。block 为可前置到用户消息的字符串。
 */
function recommendForTask(taskText, opts = {}) {
  if (!_enabled()) return null;
  const text = String(taskText || '').trim();
  if (!text) return null;

  let candidates = [];
  try {
    candidates = store.retrieve(text, {
      threshold: Number.isFinite(opts.threshold) ? opts.threshold : _threshold(),
      limit: Number.isFinite(opts.limit) ? opts.limit : _topK(),
      minUses: 1,
    });
  } catch {
    return null; // 检索失败 → 静默降级
  }

  // 只保留确实带有可复用 promptText 的候选；纯统计无内容的不构成建议。
  const useful = candidates.filter(c => c.promptText && c.promptText.trim());
  if (useful.length === 0) return null;

  const lines = [
    '[SYSTEM: 提示词复用建议（来自历史相似任务的有效打法，仅供参考，可按需采纳或忽略）：',
  ];
  useful.forEach((c, i) => {
    const sr = c.stats.uses > 0
      ? Math.round((c.stats.successes / Math.max(1, c.stats.successes + c.stats.failures)) * 100)
      : 0;
    lines.push(
      `${i + 1}. 〔${c.category}〕相似度 ${(c.similarity * 100).toFixed(0)}%，` +
      `历史成功率约 ${sr}%（用 ${c.stats.uses} 次）：${_oneLine(c.promptText)}`,
    );
  });
  lines.push('以上为历史经验，不是强制指令；若与当前任务不符请直接忽略。]');

  return { block: lines.join('\n'), candidates: useful };
}

/**
 * 任务收尾时登记用法 + 回写效果。全 best-effort。
 *
 * @param {object} o
 * @param {string} o.taskText        触发任务文本
 * @param {boolean} o.success        是否成功（由调用方依交付/验证门给出）
 * @param {number} [o.durationMs]    耗时
 * @param {string} [o.promptText]    本次被验证有效的提示词/打法片段（有则沉淀为可复用物）
 * @param {number} [o.feedbackScore] 显式用户反馈，归一化 -1..1
 * @param {string} [o.category]      覆盖自动分类
 * @param {string} [o.traceId]       关联 trace
 * @returns {string|null} 配方 id；停用或失败返回 null
 */
function captureOutcome(o = {}) {
  if (!_enabled()) return null;
  const taskText = String(o.taskText || '').trim();
  if (!taskText) return null;
  try {
    const { id } = store.recordUsage({
      taskText,
      promptText: o.promptText || '',
      category: o.category || classifyCategory(taskText),
      traceId: o.traceId || null,
    });
    store.recordOutcome({
      id,
      success: o.success,
      durationMs: o.durationMs,
      feedbackScore: o.feedbackScore,
    });
    return id;
  } catch {
    return null; // 登记失败一律静默，绝不影响任务完成
  }
}

function _oneLine(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

module.exports = {
  recommendForTask,
  captureOutcome,
  classifyCategory,
  // 测试缝
  _enabled,
};
