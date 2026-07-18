'use strict';

/**
 * docSuggestDraft.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 文档新鲜度系统 Layer 4(AI 辅助改文档内容)的纯 prompt 构造器。
 *
 * 定位(最低优先 · 需模型 · 门控默认关):确定性层(1/2/3)只能提醒/重生成/填标记值,
 * 无法改写自由正文。Layer 4 用模型对「高置信过时嫌疑」生成**改稿草稿建议**,供人工复核。
 *
 * 红线(不可动摇):
 *   ① **绝不自动落地** —— 本叶子只**构造提示词**,不调模型、不写文件。模型调用与呈现由
 *      handler 的 --ai 分支惰性走网关完成,产物永远是**建议**,人工决定是否采纳。
 *   ② 确定性层(docPathIndex / docProductPlan / docMarkerSync / runner 的默认路径)
 *      **绝不 import 本文件**,保证 pre-commit / CI 的确定性、离线、零模型。
 *
 * 门控 KHY_DOCS_AI_SUGGEST(**默认关**;仅 {1,true,on,yes} 开)。
 */

function docSuggestEnabled(env = process.env) {
  const v = String((env && env.KHY_DOCS_AI_SUGGEST) || '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
}

/**
 * 为一个过时嫌疑构造模型改稿提示词(纯字符串,不调模型)。
 * @param {{doc?:string, docSection?:string, sourceDiff?:string, matchedSources?:string[]}} input
 * @returns {string}
 */
function buildSuggestionPrompt(input = {}) {
  const doc = String(input.doc || '(未指定文档)');
  const sources = Array.isArray(input.matchedSources) && input.matchedSources.length
    ? input.matchedSources.join(', ')
    : '(未提供)';
  const section = String(input.docSection || '').trim();
  const diff = String(input.sourceDiff || '').trim();

  const parts = [];
  parts.push('你是文档维护助手。以下源码文件发生了改动,可能使某篇文档过时。');
  parts.push('你的任务:**只输出改稿建议**(具体到「把 X 改成 Y」),绝不直接改文件,绝不虚构未在 diff 中出现的事实。');
  parts.push('');
  parts.push(`文档: ${doc}`);
  parts.push(`改动的源码: ${sources}`);
  if (section) {
    parts.push('');
    parts.push('文档相关片段:');
    parts.push('"""');
    parts.push(section.slice(0, 4000));
    parts.push('"""');
  }
  if (diff) {
    parts.push('');
    parts.push('源码变更 diff(节选):');
    parts.push('```diff');
    parts.push(diff.slice(0, 4000));
    parts.push('```');
  }
  parts.push('');
  parts.push('输出格式(逐条):');
  parts.push('- 位置: <文档中大致位置/小节>');
  parts.push('- 现状: <当前描述,若已过时>');
  parts.push('- 建议: <应改为的描述>');
  parts.push('- 依据: <对应 diff 里的哪处变更>');
  parts.push('');
  parts.push('若无需修改,只回复「无需修改」。');
  return parts.join('\n');
}

module.exports = {
  docSuggestEnabled,
  buildSuggestionPrompt,
};
