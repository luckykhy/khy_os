'use strict';

/**
 * diffCapture.js — 文件修改类工具的「改动前后」证据采集。
 *
 * 外部质检判定有效轮的三条件之一是「非空的代码 diff」。工具结果里如果只写
 * 「已写入 src/App.vue」，脚本无从判断是否真的改了东西 —— 所以文件修改类工具
 * 必须在结果里带 before/after 或 unified diff，这是唯一可核查的证据。
 *
 * 用法（成对调用，中间夹真实写盘）：
 *   const snap = captureBefore(file);
 *   ...工具写盘...
 *   const evidence = captureAfter(snap);      // → {path, before, after, diff, added, removed, empty}
 *   recorder.recordToolResult({ toolUseId, name: 'Write', result, evidence });
 *
 * unified diff 复用 cli/diffRenderer 的 computeStructuredDiffHunks（已有单测的
 * 行级 LCS），此处只把 hunk 渲染成标准 `@@` 文本；该模块不可用时退到「纯计数 +
 * 全文留存」，证据强度不减（before/after 原文仍在）。
 *
 * 契约：绝不抛。任何读盘失败都表达成 evidence 上的显式字段，不静默成「无改动」。
 *
 * @module services/auditTrajectory/diffCapture
 */

const crypto = require('crypto');
const fs = require('fs');

/** 二进制/超大文件不做行级 diff，只留哈希与字节数（仍是可核查的非空改动证据）。 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function _sha(buf) {
  try {
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function _looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * 读一个文件的快照（不存在也是合法快照 —— 新建文件的 before 就是「不存在」）。
 * @param {string} filePath
 * @returns {{path:string, exists:boolean, text:(string|null), sha:string, bytes:number, binary:boolean, readError?:string}}
 */
function captureBefore(filePath) {
  const p = String(filePath || '');
  const snap = { path: p, exists: false, text: null, sha: '', bytes: 0, binary: false };
  if (!p) {
    snap.readError = 'captureBefore 未收到文件路径';
    return snap;
  }
  try {
    if (!fs.existsSync(p)) {
      return snap;
    }
    const buf = fs.readFileSync(p);
    snap.exists = true;
    snap.bytes = buf.length;
    snap.sha = _sha(buf);
    snap.binary = _looksBinary(buf) || buf.length > MAX_TEXT_BYTES;
    snap.text = snap.binary ? null : buf.toString('utf-8');
  } catch (err) {
    snap.readError = (err && err.message) || String(err);
  }
  return snap;
}

/**
 * 与 captureBefore 配对，产出可入轨迹的改动证据。
 * @param {object} before captureBefore 的返回值
 * @param {object} [opts] { context: 上下文行数, includeContent: 是否内联 before/after 全文（默认 true）}
 * @returns {object} evidence
 */
function captureAfter(before, opts = {}) {
  const p = (before && before.path) || '';
  const after = captureBefore(p);
  const includeContent = opts.includeContent !== false;

  const ev = {
    path: p,
    changeKind: _changeKind(before, after),
    beforeSha: (before && before.sha) || '',
    afterSha: after.sha,
    beforeBytes: (before && before.bytes) || 0,
    afterBytes: after.bytes,
  };

  if (before && before.readError) {
    ev.beforeReadError = before.readError;
  }
  if (after.readError) {
    ev.afterReadError = after.readError;
  }

  const bText = before && typeof before.text === 'string' ? before.text : '';
  const aText = typeof after.text === 'string' ? after.text : '';
  const textual = !(before && before.binary) && !after.binary;

  if (!textual) {
    // 二进制/超大：行级 diff 无意义，但哈希不同就是确凿的非空改动。
    ev.binary = true;
    ev.added = 0;
    ev.removed = 0;
    ev.empty = ev.beforeSha === ev.afterSha && ev.beforeBytes === ev.afterBytes;
    ev.diff = ev.empty ? '' : `Binary file ${p} changed (${ev.beforeBytes} -> ${ev.afterBytes} bytes)`;
    return ev;
  }

  const d = unifiedDiff(bText, aText, p, { context: opts.context });
  ev.added = d.added;
  ev.removed = d.removed;
  ev.diff = d.text;
  ev.empty = d.added === 0 && d.removed === 0;
  if (includeContent) {
    ev.before = bText;
    ev.after = aText;
  }
  return ev;
}

function _changeKind(before, after) {
  const had = !!(before && before.exists);
  if (!had && after.exists) {
    return 'created';
  }
  if (had && !after.exists) {
    return 'deleted';
  }
  if (!had && !after.exists) {
    return 'absent';
  }
  return 'modified';
}

/**
 * 生成 unified diff 文本 + 增删行数。
 * @param {string} oldText
 * @param {string} newText
 * @param {string} [label] 文件路径（写进 ---/+++ 头）
 * @param {object} [opts] { context }
 * @returns {{text:string, added:number, removed:number, degraded?:boolean}}
 */
function unifiedDiff(oldText, newText, label = '', opts = {}) {
  const a = String(oldText === undefined || oldText === null ? '' : oldText);
  const b = String(newText === undefined || newText === null ? '' : newText);
  if (a === b) {
    return { text: '', added: 0, removed: 0 };
  }

  let hunks = null;
  let added = 0;
  let removed = 0;
  try {
    const { computeStructuredDiffHunks } = require('../../cli/diffRenderer');
    const r = computeStructuredDiffHunks(a, b, { context: Number.isInteger(opts.context) ? opts.context : 3 });
    hunks = r.hunks;
    added = r.added;
    removed = r.removed;
  } catch {
    hunks = null;
  }

  if (!Array.isArray(hunks) || hunks.length === 0) {
    // 降级：不做 hunk 定位，只如实报告整体增删（证据仍非空，且 before/after 全文在 evidence 里）。
    const al = a === '' ? [] : a.split('\n');
    const bl = b === '' ? [] : b.split('\n');
    return {
      text: `--- a/${label}\n+++ b/${label}\n@@ 全文替换 @@\n${al.map((l) => `-${l}`).join('\n')}\n${bl.map((l) => `+${l}`).join('\n')}`,
      added: bl.length,
      removed: al.length,
      degraded: true,
    };
  }

  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const h of hunks) {
    const rows = h.rows || [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const r of rows) {
      if (r.kind === 'ctx') {
        oldCount++;
        newCount++;
      } else if (r.kind === 'del') {
        oldCount++;
      } else {
        newCount++;
      }
      if (!oldStart && r.num) {
        oldStart = r.num;
        newStart = r.num;
      }
    }
    out.push(`@@ -${oldStart || 1},${oldCount} +${newStart || 1},${newCount} @@`);
    for (const r of rows) {
      const sign = r.kind === 'del' ? '-' : r.kind === 'add' ? '+' : ' ';
      out.push(`${sign}${r.text === undefined ? '' : r.text}`);
    }
  }
  return { text: out.join('\n'), added, removed };
}

/**
 * 批量版：一次记录多文件改动（如一次 Edit 扫了三个文件）。
 * @param {Array<object>} befores captureBefore 的返回值数组
 * @param {object} [opts]
 * @returns {Array<object>} evidence 数组（含 empty=true 的项，如实保留）
 */
function captureAfterAll(befores, opts = {}) {
  return (Array.isArray(befores) ? befores : []).map((b) => captureAfter(b, opts));
}

/** 判定一组 evidence 是否构成「非空 diff」（外部质检三条件之一）。 */
function hasNonEmptyDiff(evidence) {
  const list = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  return list.some((e) => e && e.empty === false && (e.added > 0 || e.removed > 0 || e.binary === true));
}

module.exports = {
  captureBefore,
  captureAfter,
  captureAfterAll,
  unifiedDiff,
  hasNonEmptyDiff,
  MAX_TEXT_BYTES,
};
