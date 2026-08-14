'use strict';

/**
 * flowPriorityDirective.js
 *
 * Pure function that renders a Chinese guard directive (≤300 tokens) telling
 * the agent to prefer deterministic flow replay (RPA.run) over free-form
 * execution for operational tasks, to take over on replay failure, and to
 * persist healed/new flows via RPA.save with machine-checkable contracts.
 *
 * `candidates` is the array returned by flowRegistry.find(); each item is a
 * FLAT object: { name, slug, score, intent, tags, params, successRate,
 * platformMismatch }. For forward compatibility with list()-shaped items the
 * reader also falls back to `_meta.intent` / `_meta.version`; any missing
 * field renders as「未知」(fail-soft). Zero I/O, no randomness, no clock.
 */

const MAX_CANDIDATES = 5;

// Defensive length cap (~450 chars ≈ the ≤300-token design budget). Normal
// output stays far below this; only pathological candidate names trigger it.
const MAX_DIRECTIVE_CHARS = 450;

/**
 * Read a candidate field with flat-first then _meta fallback.
 * @param {object} c
 * @param {string} key
 * @returns {*}
 */
function _pick(c, key) {
  if (c && c[key] !== undefined && c[key] !== null && c[key] !== '') {
    return c[key];
  }
  const meta = c && c._meta && typeof c._meta === 'object' ? c._meta : null;
  if (meta && meta[key] !== undefined && meta[key] !== null && meta[key] !== '') {
    return meta[key];
  }
  return null;
}

/**
 * Format a success rate as a percent string, or「未知」.
 * @param {*} rate
 * @returns {string}
 */
function _fmtRate(rate) {
  const n = Number(rate);
  if (rate === null || rate === undefined || !isFinite(n)) {
    return '未知';
  }
  return `${Math.round(n * 100)}%`;
}

/**
 * Render one candidate line:「流程名 | intent | 成功率 | 版本」.
 * @param {object} c
 * @param {number} idx
 * @returns {string}
 */
function _candidateLine(c, idx) {
  const name = _pick(c, 'name') || '未知';
  const intent = _pick(c, 'intent') || '未知';
  const version = _pick(c, 'version');
  const versionText = version === null ? '未知' : `v${version}`;
  const rateText = _fmtRate(_pick(c, 'successRate'));
  return `${idx + 1}. ${name}｜意图:${intent}｜成功率:${rateText}｜版本:${versionText}`;
}

/**
 * Build the flow-priority guard directive text.
 * Invalid input → '' (never throws).
 * @param {{candidates: Array<object>}} args
 * @returns {string}
 */
function buildFlowPriorityDirective(args) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return '';
    }
    const { candidates } = args;
    if (!Array.isArray(candidates)) {
      return '';
    }

    const lines = ['## 流程优先执行协议'];

    // Section 1: flow-first decision.
    const valid = candidates.filter((c) => c && typeof c === 'object');
    if (valid.length > 0) {
      lines.push('【流程优先】检索到以下已沉淀流程候选:');
      valid.slice(0, MAX_CANDIDATES).forEach((c, i) => {
        lines.push(_candidateLine(c, i));
      });
      lines.push('操作类任务必须先用 RPA.run 重放最匹配的流程,重放失败再由你接管。');
    } else {
      lines.push(
        '【流程优先】当前无匹配的已沉淀流程。请逐步执行本次任务,完成后必须调用 RPA.save 将执行过程沉淀为流程(附 intent/tags/contract),供下次确定性重放。'
      );
    }

    // Section 2: failure takeover & self-healing.
    lines.push(
      '【失败接管与自愈】若 RPA.run 重放失败,读取返回体中的 failedStep/failedTool/resumeVars/recentLog,' +
        '从失败步骤起用常规工具接管并完成剩余意图;成功后调用 RPA.save 把修复后的完整图存为新版本,并传 healedFrom=失败节点。'
    );

    // Section 3: contract requirement.
    lines.push(
      '【契约沉淀】每次 RPA.save 时尽量附带 contract 字段,写明可机器校验的成功断言(如文件存在、页面元素出现、输出包含指定内容)。'
    );

    return _capLength(lines.join('\n'));
  } catch {
    return '';
  }
}

/**
 * Truncate an over-long directive to MAX_DIRECTIVE_CHARS with a Chinese note.
 * Normal-sized text passes through unchanged.
 * @param {string} text
 * @returns {string}
 */
function _capLength(text) {
  if (text.length <= MAX_DIRECTIVE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_DIRECTIVE_CHARS)}\n（为控制系统提示长度已截断）`;
}

module.exports = { buildFlowPriorityDirective };
