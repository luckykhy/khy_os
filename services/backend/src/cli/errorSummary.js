'use strict';

// 收敛到 utils/collapseWhitespaceLoose 单一真源(逐字节委托,调用点不变)
const _normalizeSpace = require('../utils/collapseWhitespaceLoose');

function _toLines(raw = '') {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => _normalizeSpace(line))
    .filter(Boolean);
}

function _truncate(text = '', maxLen = 160) {
  const normalized = _normalizeSpace(text);
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLen - 1))}…`;
}

function _extractNumberedItems(text = '') {
  const normalized = _normalizeSpace(text);
  if (!normalized) return [];
  const matches = [];
  const re = /(\d+)[).、]\s*([^]+?)(?=\s+\d+[).、]\s*|$)/g;
  let m;
  while ((m = re.exec(normalized))) {
    const body = _normalizeSpace(m[2] || '');
    if (!body) continue;
    matches.push(`${m[1]}) ${body}`);
  }
  return matches;
}

function _extractSectionLines(lines, headerRe) {
  const idx = lines.findIndex((line) => headerRe.test(line));
  if (idx < 0) return [];
  const out = [];
  const first = lines[idx].replace(headerRe, '').trim();
  if (first) out.push(first);
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[\u4e00-\u9fa5A-Za-z][^:：]{0,20}[:：]\s*$/.test(line)) break;
    if (/^(?:建议下一步|真实失败原因|失败原因)[:：]/.test(line)) break;
    if (/^[-•]\s*/.test(line) || /^\d+[).、]\s*/.test(line)) {
      out.push(line.replace(/^[-•]\s*/, '').trim());
      continue;
    }
    if (out.length > 0) {
      out.push(line);
      continue;
    }
    if (/^[\u4e00-\u9fa5A-Za-z]/.test(line)) {
      out.push(line);
    }
  }
  return out;
}

function _extractPrimaryReason(raw = '', lines = []) {
  const normalized = _normalizeSpace(raw);
  const patterns = [
    /已选择模型通道[^。\n]{0,140}(?:[:：]\s*[^。\n]{1,200})?/,
    /AI 网关异常[:：]?\s*[^。\n]{1,220}/,
    /请求已取消[:：]?\s*[^。\n]{1,220}/,
    /失败原因[:：]?\s*[^。\n]{1,220}/,
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m[0]) return _normalizeSpace(m[0]);
  }
  for (const line of lines) {
    if (/^(?:真实失败原因|建议下一步)[:：]?/.test(line)) continue;
    if (/^[-•]\s*/.test(line)) continue;
    if (/^\d+[).、]\s*/.test(line)) continue;
    return _normalizeSpace(line);
  }
  return '';
}

function _extractFailureItems(raw = '', lines = []) {
  const sectionLines = _extractSectionLines(lines, /^真实失败原因[:：]\s*/);
  const bulletItems = sectionLines
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
  if (bulletItems.length > 0) return bulletItems;

  const normalized = _normalizeSpace(raw);
  const idx = normalized.indexOf('真实失败原因');
  if (idx < 0) return [];
  const tail = normalized.slice(idx);
  const segment = tail.split(/建议下一步[:：]/)[0];
  const byDash = segment.split(/\s+-\s+/).map((s) => _normalizeSpace(s)).filter(Boolean);
  return byDash
    .filter((item) => !/^真实失败原因[:：]?/.test(item))
    .map((item) => item.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
}

function _extractSuggestionItems(raw = '', lines = []) {
  const sectionLines = _extractSectionLines(lines, /^建议下一步[:：]\s*/);
  const normalizedSection = _normalizeSpace(sectionLines.join(' '));
  let items = _extractNumberedItems(normalizedSection);
  if (items.length > 0) return items;

  const normalized = _normalizeSpace(raw);
  const idx = normalized.indexOf('建议下一步');
  if (idx < 0) return [];
  const tail = normalized.slice(idx).replace(/^建议下一步[:：]?\s*/, '');
  items = _extractNumberedItems(tail);
  if (items.length > 0) return items;

  if (tail) return [_truncate(tail, 120)];
  return [];
}

function compactAiErrorReply(raw = '', options = {}) {
  const text = String(raw || '').trim();
  const lines = _toLines(text);
  const primary = _extractPrimaryReason(text, lines);
  const failures = _extractFailureItems(text, lines);
  const suggestions = _extractSuggestionItems(text, lines);
  const hasStructuredDetails = failures.length > 0 || suggestions.length > 0 || /真实失败原因|建议下一步/.test(text);
  const maxSummaryLen = Math.max(60, parseInt(String(options.maxSummaryLen || 160), 10) || 160);
  const maxSuggest = Math.max(1, parseInt(String(options.maxSuggestionLines || 2), 10) || 2);
  const maxFailurePreview = Math.max(1, parseInt(String(options.maxFailurePreview || 1), 10) || 1);

  const summarySource = primary || lines[0] || text || 'AI 请求失败';
  const summary = _truncate(summarySource, maxSummaryLen);
  const suggestionPreview = suggestions.slice(0, maxSuggest);
  const failurePreview = failures.slice(0, maxFailurePreview);

  return {
    summary,
    hasStructuredDetails,
    failureItems: failures,
    suggestionItems: suggestions,
    suggestionPreview,
    failurePreview,
    hiddenFailureCount: Math.max(0, failures.length - failurePreview.length),
    hiddenSuggestionCount: Math.max(0, suggestions.length - suggestionPreview.length),
    raw: text,
  };
}

function compactGatewayStatusText(raw = '', options = {}) {
  const text = _normalizeSpace(raw);
  if (!text) return '';
  const maxLen = Math.max(80, parseInt(String(options.maxLen || 180), 10) || 180);
  const compacted = compactAiErrorReply(text, {
    maxSummaryLen: maxLen,
    maxSuggestionLines: 1,
    maxFailurePreview: 1,
  });

  if (!compacted.hasStructuredDetails) return _truncate(text, maxLen);

  const segs = [`失败摘要: ${compacted.summary}`];
  if (compacted.suggestionPreview.length > 0) {
    segs.push(`建议: ${compacted.suggestionPreview.join('；')}`);
  }
  return _truncate(segs.join(' · '), maxLen);
}

module.exports = {
  compactAiErrorReply,
  compactGatewayStatusText,
};
