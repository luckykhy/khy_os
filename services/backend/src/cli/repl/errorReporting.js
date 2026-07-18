/**
 * AI-error reporting + folded-status bookkeeping for the REPL.
 *
 * Extracted verbatim from cli/repl.js (startRepl closure group) as part of the
 * behavior-preserving god-file split. This cluster owns mutable state
 * (_lastAiError* merge-window fields, _foldedStatusRecords ring, and the
 * _expandToggleState toggle). That state is referenced ONLY through this
 * cluster's functions — verified by grep before extraction — so, exactly like
 * repl/terminalTitle.js, it stays here as module-private singletons. startRepl
 * runs once per process, so a module singleton has the same lifetime the
 * file-level `let`s had inside startRepl; the require cache makes every caller
 * share one instance.
 *
 * Public surface (called from elsewhere in startRepl):
 *   _recordFoldedStatus, _printFoldedStatusDetails, _handleExpandShortcut,
 *   _flushMergedErrorHintLine, _printLastAiError, _renderAiErrorCompact.
 * The remaining functions are cluster-internal helpers.
 *
 * Local lazy chalk()/fmt() accessors mirror repl/startup.js: the second
 * require cache holds the same singletons Node already memoizes, so behavior
 * is unchanged.
 */
const { foldOutput } = require('../toolDisplayPolicy');
const { compactAiErrorReply } = require('../errorSummary');

let _chalk, _formatters;
const chalk = () => {
  if (_chalk) return _chalk;
  const chalkModule = require('chalk');
  _chalk = chalkModule.default || chalkModule;
  return _chalk;
};
const fmt = () => (_formatters ??= require('../formatters'));

const c = chalk();
const { printError, printErrorPanel, printInfo } = fmt();

let _lastAiErrorDetail = '';
let _lastAiErrorSummary = '';
let _lastAiErrorFingerprint = '';
let _lastAiErrorAt = 0;
let _lastAiErrorRepeat = 0;
let _mergedErrorHintOpen = false;
const _MAX_FOLDED_STATUS_RECORDS = (() => {
  const raw = Number.parseInt(String(process.env.KHY_STATUS_FOLDED_MAX_RECORDS || '200').trim(), 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.max(40, Math.min(2000, raw));
})();
let _foldedStatusRecords = [];

function _normalizeFoldedStatusKey(reason = '', phase = '', text = '') {
  const r = String(reason || '').trim().toLowerCase();
  const p = String(phase || '').trim().toLowerCase();
  const t = String(text || '')
    .toLowerCase()
    .replace(/\d+(\.\d+)?s\b/gi, 'Xs')
    .replace(/\b\d+ms\b/gi, 'Xms')
    .replace(/\s+/g, ' ')
    .trim();
  return `${r}|${p}|${t}`;
}

function _recordFoldedStatus(reason = '', phase = '', text = '') {
  const msg = String(text || '').replace(/\s+/g, ' ').trim();
  if (!msg) return;
  const now = Date.now();
  const key = _normalizeFoldedStatusKey(reason, phase, msg);
  const tail = _foldedStatusRecords.length > 0 ? _foldedStatusRecords[_foldedStatusRecords.length - 1] : null;
  if (tail && tail.key === key && (now - Number(tail.lastAt || 0)) < 30_000) {
    tail.count = Number(tail.count || 1) + 1;
    tail.lastAt = now;
    return;
  }
  _foldedStatusRecords.push({
    key,
    reason: String(reason || 'suppressed'),
    phase: String(phase || 'status'),
    text: msg.slice(0, 280),
    count: 1,
    firstAt: now,
    lastAt: now,
  });
  if (_foldedStatusRecords.length > _MAX_FOLDED_STATUS_RECORDS) {
    _foldedStatusRecords = _foldedStatusRecords.slice(-_MAX_FOLDED_STATUS_RECORDS);
  }
}

function _formatFoldedReasonLabel(reason = '') {
  const r = String(reason || '').trim().toLowerCase();
  if (r === 'init-brief') return '初始化噪声';
  if (r === 'start-window') return '启动静默';
  if (r === 'low-value-repeat') return '低价值重复';
  if (r === 'exact-dedup') return '完全重复';
  if (r === 'tool-progress-brief') return '工具成功节流';
  if (r === 'brief-metrics') return '指标噪声';
  if (r === 'brief-adapter') return '通道切换噪声';
  if (r === 'brief-generic') return '通用状态噪声';
  return reason || '已抑制';
}

function _buildFoldedStatusDetailText() {
  if (_foldedStatusRecords.length <= 0) return '';
  const reasonCount = new Map();
  for (const item of _foldedStatusRecords) {
    const key = _formatFoldedReasonLabel(item.reason || '');
    reasonCount.set(key, (reasonCount.get(key) || 0) + Number(item.count || 1));
  }
  const reasonParts = [...reasonCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`);
  const lines = [];
  lines.push(`折叠状态记录: ${_foldedStatusRecords.length}`);
  if (reasonParts.length > 0) lines.push(`原因汇总: ${reasonParts.join(' · ')}`);
  lines.push('---');
  for (const item of _foldedStatusRecords) {
    const t = new Date(item.lastAt || Date.now()).toTimeString().slice(0, 8);
    const phase = String(item.phase || 'status');
    const reason = _formatFoldedReasonLabel(item.reason || '');
    const repeat = Number(item.count || 1) > 1 ? ` ×${Number(item.count || 1)}` : '';
    lines.push(`[${t}] [${phase}] [${reason}] ${item.text}${repeat}`);
  }
  return lines.join('\n');
}

function _printFoldedStatusDetails() {
  if (_foldedStatusRecords.length <= 0) return false;
  const detail = _buildFoldedStatusDetailText();
  if (!detail) return false;
  try {
    const renderer = require('../aiRenderer');
    renderer.pushExpandableOutput({ tool: 'FoldedStatus', detail, paramStr: `records=${_foldedStatusRecords.length}` });
  } catch { /* non-critical */ }
  console.log('');
  printInfo(`折叠状态明细（共 ${_foldedStatusRecords.length} 条）`);
  console.log(c.dim('  ─────────────────────────────────────────'));
  const lines = detail.split('\n');
  const { lines: foldedLines } = foldOutput(lines, { maxLines: 120, foldHead: 70, foldTail: 40 });
  console.log(foldedLines.join('\n'));
  console.log('');
  return true;
}

// Toggle 状态：记录上次展开的内容指纹，再按 Ctrl+O 折叠回去
let _expandToggleState = { expanded: false, fingerprint: null };

function _printLastExpandableOutput() {
  try {
    const renderer = require('../aiRenderer');
    const last = renderer.getLastExpandableOutput();
    if (!last || !last.detail) return false;

    const fingerprint = `${last.tool}|${last.paramStr}|${last.detail.length}`;

    // Toggle: 如果上次已展开同一内容，这次折叠
    if (_expandToggleState.expanded && _expandToggleState.fingerprint === fingerprint) {
      _expandToggleState.expanded = false;
      _expandToggleState.fingerprint = null;
      console.log('');
      printInfo('已折叠输出');
      console.log('');
      return true;
    }

    // 展开
    console.log('');
    const title = `${last.tool || 'Output'}${last.paramStr ? ` (${last.paramStr})` : ''}`;
    printInfo(`展开输出: ${title}`);
    console.log(c.dim('  ─────────────────────────────────────────'));
    console.log(String(last.detail));
    console.log(c.dim('  ─────────────────────────────────────────'));
    printInfo('再按 Ctrl+O 折叠');
    console.log('');

    _expandToggleState.expanded = true;
    _expandToggleState.fingerprint = fingerprint;
    return true;
  } catch {
    return false;
  }
}

function _handleExpandShortcut() {
  _flushMergedErrorHintLine();
  // 如果当前是展开状态，优先处理 toggle 折叠
  if (_expandToggleState.expanded) {
    return _printLastExpandableOutput();
  }
  if (_printFoldedStatusDetails()) return true;
  if (_printLastExpandableOutput()) return true;
  printInfo('暂无可展开的折叠内容');
  return false;
}

function _isVerboseErrorEnabled() {
  const raw = String(process.env.KHY_ERROR_VERBOSE || 'false').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

function _getErrorMergeWindowMs() {
  const raw = String(process.env.KHY_ERROR_MERGE_WINDOW_MS || '30000').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30000;
  return Math.max(3000, Math.min(180000, parsed));
}

function _buildAiErrorFingerprint(compacted, text = '') {
  const parts = [];
  const summary = String(compacted?.summary || '').replace(/\s+/g, ' ').trim();
  if (summary) parts.push(summary);
  const failurePreview = Array.isArray(compacted?.failurePreview)
    ? compacted.failurePreview
    : [];
  const suggestionPreview = Array.isArray(compacted?.suggestionPreview)
    ? compacted.suggestionPreview
    : [];
  if (failurePreview.length > 0) parts.push(String(failurePreview[0] || '').replace(/\s+/g, ' ').trim());
  if (suggestionPreview.length > 0) parts.push(String(suggestionPreview[0] || '').replace(/\s+/g, ' ').trim());
  if (parts.length === 0) {
    parts.push(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  return parts.filter(Boolean).join(' | ').slice(0, 320);
}

function _flushMergedErrorHintLine() {
  if (!_mergedErrorHintOpen) return;
  try { process.stdout.write('\n'); } catch { /* ignore */ }
  _mergedErrorHintOpen = false;
}

function _renderMergedErrorHintLine(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  if (!process.stdout.isTTY) {
    printInfo(text);
    return false;
  }
  const line = c.dim(`  · ${text}`);
  try {
    if (_mergedErrorHintOpen) {
      process.stdout.write(`\r\x1b[K${line}`);
    } else {
      process.stdout.write(line);
      _mergedErrorHintOpen = true;
    }
    return true;
  } catch {
    _mergedErrorHintOpen = false;
    printInfo(text);
    return false;
  }
}

function _rememberAiError(raw = '', summary = '') {
  _lastAiErrorDetail = String(raw || '').trim();
  _lastAiErrorSummary = String(summary || '').trim();
}

function _printLastAiError() {
  _flushMergedErrorHintLine();
  if (!_lastAiErrorDetail) {
    printInfo('暂无可查看的失败详情');
    return;
  }
  console.log('');
  if (_lastAiErrorSummary) {
    printInfo(`最近失败摘要: ${_lastAiErrorSummary}`);
  }
  console.log(c.dim('  ─────────────────────────────────────────'));
  console.log(_lastAiErrorDetail);
  console.log('');
}

function _renderAiErrorCompact(raw = '') {
  const text = String(raw || '').trim();
  if (!text) {
    _flushMergedErrorHintLine();
    printError('AI 请求失败');
    _rememberAiError('AI 请求失败', 'AI 请求失败');
    return { merged: false, inline: false };
  }
  if (_isVerboseErrorEnabled()) {
    _flushMergedErrorHintLine();
    printError(text);
    _rememberAiError(text, text.split(/\r?\n/).find(Boolean) || 'AI 请求失败');
    return { merged: false, inline: false };
  }

  const compacted = compactAiErrorReply(text, {
    maxSummaryLen: 170,
    maxSuggestionLines: 2,
    maxFailurePreview: 1,
  });

  const summary = compacted.summary || 'AI 请求失败';
  const mergeWindowMs = _getErrorMergeWindowMs();
  const now = Date.now();
  const fingerprint = _buildAiErrorFingerprint(compacted, text);
  if (
    fingerprint
    && _lastAiErrorFingerprint
    && fingerprint === _lastAiErrorFingerprint
    && (now - _lastAiErrorAt) <= mergeWindowMs
  ) {
    _lastAiErrorAt = now;
    _lastAiErrorRepeat += 1;
    _rememberAiError(text, summary);
    const inline = _renderMergedErrorHintLine(`同类失败在 ${Math.round(mergeWindowMs / 1000)}s 内已重复 ${_lastAiErrorRepeat} 次，已合并显示；输入 /err 查看完整详情`);
    return { merged: true, inline };
  }
  _flushMergedErrorHintLine();
  _lastAiErrorFingerprint = fingerprint;
  _lastAiErrorAt = now;
  _lastAiErrorRepeat = 1;

  if (compacted.hasStructuredDetails) {
    printErrorPanel({
      title: 'AI Request Failed',
      message: summary,
      reason: compacted.failurePreview[0] || '',
      suggestions: compacted.suggestionItems,
    });
  } else {
    printError(summary);
    if (compacted.suggestionPreview.length > 0) {
      printInfo(`建议下一步: ${compacted.suggestionPreview.join('；')}`);
    }
  }
  const hiddenFailure = Number(compacted.hiddenFailureCount || 0);
  const hiddenSuggest = Number(compacted.hiddenSuggestionCount || 0);
  if (!compacted.hasStructuredDetails && (hiddenFailure > 0 || hiddenSuggest > 0 || text.length > 220)) {
    printInfo('详细失败原因已折叠，输入 /err 查看完整详情（或设置 KHY_ERROR_VERBOSE=1）');
  }
  _rememberAiError(text, summary);
  return { merged: false, inline: false };
}

module.exports = {
  _recordFoldedStatus,
  _printFoldedStatusDetails,
  _handleExpandShortcut,
  _flushMergedErrorHintLine,
  _printLastAiError,
  _renderAiErrorCompact,
};
