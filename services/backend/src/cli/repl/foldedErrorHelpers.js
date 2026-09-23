'use strict';

/**
 * Pure, side-effect-free helpers behind cli/repl/errorReporting.js.
 *
 * Split out as a behavior-preserving leaf: these six items read only their
 * arguments (or process.env) and never touch the cluster's mutable singletons
 * (_foldedStatusRecords / _lastAiError* / _mergedErrorHintOpen) or chalk/fmt.
 * errorReporting.js re-requires them so its own public surface stays
 * byte-identical; they remain file-private to everything else in the tree.
 */

const _MAX_FOLDED_STATUS_RECORDS = (() => {
  const raw = Number.parseInt(
    String(process.env.KHY_STATUS_FOLDED_MAX_RECORDS || '200').trim(),
    10
  );
  if (!Number.isFinite(raw)) {
    return 200;
  }
  return Math.max(40, Math.min(2000, raw));
})();

function _normalizeFoldedStatusKey(reason = '', phase = '', text = '') {
  const r = String(reason || '')
    .trim()
    .toLowerCase();
  const p = String(phase || '')
    .trim()
    .toLowerCase();
  const t = String(text || '')
    .toLowerCase()
    .replace(/\d+(\.\d+)?s\b/gi, 'Xs')
    .replace(/\b\d+ms\b/gi, 'Xms')
    .replace(/\s+/g, ' ')
    .trim();
  return `${r}|${p}|${t}`;
}

function _formatFoldedReasonLabel(reason = '') {
  const r = String(reason || '')
    .trim()
    .toLowerCase();
  if (r === 'init-brief') {
    return '初始化噪声';
  }
  if (r === 'start-window') {
    return '启动静默';
  }
  if (r === 'low-value-repeat') {
    return '低价值重复';
  }
  if (r === 'exact-dedup') {
    return '完全重复';
  }
  if (r === 'tool-progress-brief') {
    return '工具成功节流';
  }
  if (r === 'brief-metrics') {
    return '指标噪声';
  }
  if (r === 'brief-adapter') {
    return '通道切换噪声';
  }
  if (r === 'brief-generic') {
    return '通用状态噪声';
  }
  return reason || '已抑制';
}

function _isVerboseErrorEnabled() {
  const raw = String(process.env.KHY_ERROR_VERBOSE || 'false')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

function _getErrorMergeWindowMs() {
  const raw = String(process.env.KHY_ERROR_MERGE_WINDOW_MS || '30000').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 30000;
  }
  return Math.max(3000, Math.min(180000, parsed));
}

function _buildAiErrorFingerprint(compacted, text = '') {
  const parts = [];
  const summary = String(compacted?.summary || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (summary) {
    parts.push(summary);
  }
  const failurePreview = Array.isArray(compacted?.failurePreview) ? compacted.failurePreview : [];
  const suggestionPreview = Array.isArray(compacted?.suggestionPreview)
    ? compacted.suggestionPreview
    : [];
  if (failurePreview.length > 0) {
    parts.push(
      String(failurePreview[0] || '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  if (suggestionPreview.length > 0) {
    parts.push(
      String(suggestionPreview[0] || '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  if (parts.length === 0) {
    parts.push(
      String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
    );
  }
  return parts.filter(Boolean).join(' | ').slice(0, 320);
}

module.exports = {
  _MAX_FOLDED_STATUS_RECORDS,
  _normalizeFoldedStatusKey,
  _formatFoldedReasonLabel,
  _isVerboseErrorEnabled,
  _getErrorMergeWindowMs,
  _buildAiErrorFingerprint,
};
