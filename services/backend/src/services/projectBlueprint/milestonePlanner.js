'use strict';

/**
 * projectBlueprint/milestonePlanner.js — 把一个 archetype 的「整棵文件树」拆成
 * **有序里程碑**、并按上下文窗口切成**紧凑片**的纯函数层。
 *
 * 为什么这层是关键（[[project_short_context_engineering]] 的延伸）：弱模型/短窗口一次
 * 面对 19 个文件会无从下手、或把窗口塞爆。解法是「分而治之 + 按需取片」：
 *   · buildPlan   → 只给里程碑骨架(标题/目标/产物文件名/验收)，**不含任何文件正文**，
 *                   小到任何窗口都放得下，作为「目录」。
 *   · milestoneSlice → 模型做到第 N 阶段时，只取这一阶段的可执行细节(步骤/产物/验收/约定)，
 *                   再用 contextProfile.deriveToolResultCap 按窗口收紧体积，绝不超额。
 *
 * 纯函数、无副作用、不读磁盘（archetype 由 catalog 传入），便于不变量测试。
 */

const contextProfile = require('../contextProfile');

function _milestones(archetype) {
  return (archetype && Array.isArray(archetype.milestones)) ? archetype.milestones : [];
}

/**
 * 里程碑总览（紧凑「目录」，不含文件正文）。
 * @param {object} archetype
 * @returns {{ id:string, label:string, total:number, build:object, milestones:Array }}
 */
function buildPlan(archetype) {
  const ms = _milestones(archetype);
  return {
    id: archetype && archetype.id,
    label: (archetype && (archetype.label || archetype.id)) || null,
    templateName: archetype && archetype.templateName,
    stack: (archetype && archetype.stack) || null,
    build: (archetype && archetype.build) || null,
    verify: (archetype && archetype.verify) || [],
    total: ms.length,
    milestones: ms.map((m, i) => ({
      index: i,
      id: m.id,
      title: m.title,
      goal: m.goal || '',
      fileCount: (m.files || []).length,
      files: (m.files || []).slice(),
      acceptance: (m.acceptance || []).slice(),
    })),
  };
}

/** 把一个里程碑细节渲染成紧凑纯文本（用于体积测量与人类可读输出）。 */
function _renderSliceText(slice) {
  const lines = [];
  lines.push(`# 里程碑 ${slice.index + 1}/${slice.total}: ${slice.title}`);
  if (slice.goal) lines.push(`目标: ${slice.goal}`);
  if (slice.conventions && slice.conventions.length) {
    lines.push('约定:');
    for (const c of slice.conventions) lines.push(`  - ${c}`);
  }
  if (slice.steps && slice.steps.length) {
    lines.push('步骤:');
    slice.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (slice.files && slice.files.length) {
    lines.push('产物文件:');
    for (const f of slice.files) lines.push(`  - ${f}`);
  }
  if (slice.acceptance && slice.acceptance.length) {
    lines.push('验收:');
    for (const a of slice.acceptance) lines.push(`  - ${a}`);
  }
  if (slice.nextHint) lines.push(`下一步: ${slice.nextHint}`);
  return lines.join('\n');
}

/**
 * 取第 index 个里程碑的可执行切片，按上下文窗口收紧体积。
 *
 * 体积控制策略：先组完整切片，若渲染文本超过 deriveToolResultCap(window)，按「优先级从低到高」
 * 逐步瘦身——先砍 conventions、再压缩 steps 文本——直到落入预算；并标 truncated。
 * 任何窗口下「标题/目标/产物文件名/验收」恒保留（它们是模型干活的最小必要信息）。
 *
 * @param {object} archetype
 * @param {number} index
 * @param {object} [opts] - { contextWindow }
 * @returns {{ index:number, total:number, ..., text:string, charBudget:number, truncated:boolean }}
 */
function milestoneSlice(archetype, index, opts = {}) {
  const ms = _milestones(archetype);
  const total = ms.length;
  if (index < 0 || index >= total) {
    return { ok: false, error: `里程碑序号越界: ${index}（共 ${total} 个）`, total };
  }
  const m = ms[index];
  const contextWindow = Number(opts.contextWindow) || 0;
  const defaultChars = require('./catalog').thresholds.defaultSliceChars;
  const charBudget = contextProfile.deriveToolResultCap(contextWindow, defaultChars);

  // 完整切片
  let slice = {
    ok: true,
    index,
    total,
    id: m.id,
    title: m.title,
    goal: m.goal || '',
    conventions: (m.conventions || []).slice(),
    steps: (m.steps || []).slice(),
    files: (m.files || []).slice(),
    acceptance: (m.acceptance || []).slice(),
    nextHint: index + 1 < total
      ? `完成本阶段后取里程碑 ${index + 2}/${total}`
      : '这是最后一个里程碑，完成后跑 verify 收尾',
  };

  let text = _renderSliceText(slice);
  let truncated = false;

  // 瘦身阶梯：仅在超预算时启动，从最不影响「能否动手」的字段开始。
  if (text.length > charBudget && slice.conventions.length) {
    slice.conventions = [];
    truncated = true;
    text = _renderSliceText(slice);
  }
  if (text.length > charBudget && slice.steps.length) {
    // 压缩步骤：保留每条但截断到一行要点。
    slice.steps = slice.steps.map((s) => {
      const oneLine = String(s).split(/[。.;\n]/)[0];
      return oneLine.length < String(s).length ? oneLine + '…' : oneLine;
    });
    truncated = true;
    text = _renderSliceText(slice);
  }
  // 最后兜底：硬截断渲染文本（结构字段仍完整可用，文本仅作展示）。
  if (text.length > charBudget) {
    text = text.slice(0, Math.max(0, charBudget - 1)) + '…';
    truncated = true;
  }

  slice.text = text;
  slice.charBudget = charBudget;
  slice.truncated = truncated;
  return slice;
}

module.exports = {
  buildPlan,
  milestoneSlice,
  _renderSliceText,
};
