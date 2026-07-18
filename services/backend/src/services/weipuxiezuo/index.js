'use strict';

/**
 * weipuxiezuo/index.js — 维普 AIGC 降重引擎门面（编排 detector → scorer → constraints）。
 *
 * 这是「把方法论变成代码」的对外单一入口。一次 analyze(text, {mode}) 即得：
 *   - findings   带位置的 16 模式命中清单（修复任务，取代「教模型认模式」的提示词）
 *   - scores     三维确定性评分（AIGC / 学术 / 引用化用）
 *   - gate       模式相关的硬约束闸（代码判合格，非模型自评）
 *   - brief      结构化改写简报（按优先级排序的逐条 fix，喂回模型重写）
 *   - report     ASCII 三维评分框（对应 skill 文档 Step 4 的人类可读输出）
 *
 * 关键设计：scorer 需要原文做语体扫描，这里在调用前把 text 挂到 detection 上（单点修复
 * detector 不携带 text 的缺口），下游纯函数保持无副作用。
 */

const detector = require('./detector');
const scorer = require('./scorer');
const constraints = require('./constraints');
const rules = require('./rules');

const VALID_MODES = new Set(['fragment', 'chapter', 'full']);

/**
 * 完整分析。
 * @param {string} text
 * @param {object} [opts]
 * @param {'fragment'|'chapter'|'full'} [opts.mode='fragment']
 * @returns {{ mode, detection, scores, gate, brief, report }}
 */
function analyze(text, opts = {}) {
  const mode = VALID_MODES.has(opts.mode) ? opts.mode : 'fragment';
  const src = String(text || '');

  const detection = detector.detect(src);
  detection.text = src; // 供 scorer 做语体（中性/口语）扫描，单点补齐
  const scores = scorer.score(detection);
  const gate = constraints.check(detection, { mode });
  const brief = buildRewriteBrief(detection, scores, gate);
  const report = renderScoreReport({ mode, detection, scores, gate });

  return { mode, detection, scores, gate, brief, report };
}

/**
 * 结构化改写简报：把命中按优先级（high→mid→low）排成可执行的逐条任务。
 * 每条 = {priority, pattern, count, locations, fix, replacements?}，模型据此重写，
 * 而不是读一段散文规则。
 */
function buildRewriteBrief(detection, scores, gate) {
  const order = { [rules.PRIORITY.HIGH]: 0, [rules.PRIORITY.MID]: 1, [rules.PRIORITY.LOW]: 2 };
  const tasks = detection.findings
    .slice()
    .sort((a, b) => (order[a.priority] - order[b.priority]) || (a.id - b.id))
    .map((f) => ({
      priority: f.priority,
      patternId: f.id,
      pattern: f.name,
      count: f.count,
      // 每模式最多列前 5 处定位（段号 + 触发词），避免简报过长。
      locations: f.matches.slice(0, 5).map((m) => ({
        paragraph: m.paragraph,
        index: m.index,
        text: m.text,
        atEnd: m.atEnd,
      })),
      fix: f.fix,
      replacements: _replacementsFor(f),
    }));

  // 硬约束未过项（非 advisory）单列，明确「必须修到通过」。
  const blocking = gate.items
    .filter((it) => !it.pass && !it.advisory)
    .map((it) => ({ key: it.key, label: it.label, limit: it.limit, actual: it.actual }));

  return {
    summary: {
      aigc: scores.aigc.score,
      aigcPass: scores.aigc.pass,
      academic: scores.academic.score,
      academicPass: scores.academic.pass,
      gatePass: gate.pass,
      totalFindings: detection.findings.reduce((a, f) => a + f.count, 0),
    },
    blocking,
    tasks,
  };
}

function _replacementsFor(finding) {
  if (finding.id !== 11) return undefined; // 仅 AI 高频词给换词表
  const out = {};
  for (const m of finding.matches) {
    const r = rules.REPLACEMENTS[m.text];
    if (r !== undefined) out[m.text] = r;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * ASCII 三维评分框（对应 skill 文档 Step 4）。纯字符串，无颜色码，终端/Web 通用。
 */
function renderScoreReport({ mode, detection, scores, gate }) {
  const { aigc, academic, citation } = scores;
  const cv = detection.stats.rhythm.cv || 0;
  const bar = (val, max, pass) => {
    const filled = Math.round((Math.min(val, max) / max) * 20);
    return (pass ? '█' : '▓').repeat(filled) + '·'.repeat(20 - filled);
  };
  const ok = (b) => (b ? '✓ 合格' : '✗ 不合格');

  const lines = [];
  lines.push('┌─ 维普写作 · 三维检测报告 ──────────────────────────┐');
  lines.push(`│ 模式: ${_pad(mode, 10)}  段落: ${_pad(detection.stats.paragraphCount, 4)}  句子: ${_pad(detection.stats.sentenceCount, 4)}        │`);
  lines.push('├────────────────────────────────────────────────────┤');
  lines.push(`│ AIGC痕迹  ${_pad(aigc.score, 3)}/100  [${bar(aigc.score, 100, aigc.pass)}] ${ok(aigc.pass)} │`);
  lines.push(`│ 学术质量  ${_pad(academic.score, 3)}/100  [${bar(academic.score, 100, academic.pass)}] ${ok(academic.pass)} │`);
  lines.push(`│ 句长突发性 CV=${cv.toFixed(3)}  (人类≈0.50 / AI≈0.28)            │`);
  lines.push(`│ 引用: 显式 ${_pad(citation.explicit, 3)}  化用 ${_pad(citation.huayongMarkers, 3)}  化用密度 ${_pad((citation.huayongPct * 100).toFixed(0) + '%', 5)}     │`);
  lines.push('├─ 硬约束闸 ──────────────────────────────────────────┤');
  for (const it of gate.items) {
    const mark = it.advisory ? '·' : (it.pass ? '✓' : '✗');
    lines.push(`│ ${mark} ${_pad(it.label, 18)} 限 ${_pad(it.limit, 8)} 实 ${_pad(String(it.actual), 6)}${it.advisory ? ' (参考)' : ''}`.padEnd(53) + '│');
  }
  lines.push('├────────────────────────────────────────────────────┤');
  const overall = aigc.pass && academic.pass && gate.pass;
  lines.push(`│ 总判定: ${overall ? '✓ 通过（可交付）' : '✗ 未通过（需按简报重写）'}`.padEnd(53) + '│');
  lines.push('└────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

function _pad(v, width) {
  const s = String(v);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

module.exports = {
  analyze,
  buildRewriteBrief,
  renderScoreReport,
  VALID_MODES,
  // 透传子模块，便于直接单测/复用。
  detector,
  scorer,
  constraints,
  rules,
};
