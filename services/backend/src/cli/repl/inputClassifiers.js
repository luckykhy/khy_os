/**
 * Input / text classification predicates.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. All functions are pure (no module state, no I/O).
 */

function hasToolCallTag(text = '') {
  const s = text || '';
  return /<tool_call>\s*[\s\S]*?<\/tool_call>/i.test(s)
    || /【\s*调用\s*[^】\n]{1,48}(?:[：:][^】]*)?】/.test(s);
}

function stripToolCallTags(text = '') {
  return (text || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/【\s*调用\s*[^】\n]{1,48}(?:[：:][^】]*)?】/g, '')
    .replace(/<execution_plan>[\s\S]*?<\/execution_plan>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldBypassPlanMode(input = '') {
  const raw = String(input || '');
  const lower = raw.toLowerCase();
  if (!lower) return false;
  if (/\bnoplan\b|\/noplan\b/.test(lower)) return true;

  const zhPattern = /不要(?:进入)?计划|无需(?:进入)?计划|不需要(?:进入)?计划|跳过计划|直接执行|直接开始执行/;
  const enPattern = /\b(no\s*plan|skip\s*plan|direct\s*execute|execute\s*directly)\b/i;
  return zhPattern.test(raw) || enPattern.test(raw);
}

function looksLikeUiEchoInput(input = '') {
  const s = String(input || '').trim();
  if (!s) return false;
  return /^>\s*状态:\s*/.test(s)
    || /^状态:\s*(就绪|正在生成响应|请求上游模型)/.test(s)
    || /^>\s*(向\s*AI\s*发送请求|进入计划模式|执行计划|计划模式)/.test(s)
    || /^[-─]{10,}$/.test(s);
}

function isArrowEscapeLine(input = '') {
  const raw = String(input || '');
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return trimmed === '\u001b[A'
    || trimmed === '\u001b[B'
    || trimmed === '\u001b[C'
    || trimmed === '\u001b[D'
    || /^\^\[\[[ABCD]$/.test(trimmed);
}

// Bare ESC keypress (no following CSI sequence): the readline 'line' event
// fires with a lone ESC byte. Distinguish it from arrow/escape CSI lines so the
// REPL can treat it as a cancel/clear rather than a submitted message.
function isEscOnlyInput(raw) {
  return raw === '\u001b';
}

module.exports = {
  hasToolCallTag,
  stripToolCallTags,
  shouldBypassPlanMode,
  looksLikeUiEchoInput,
  isArrowEscapeLine,
  isEscOnlyInput,
};
