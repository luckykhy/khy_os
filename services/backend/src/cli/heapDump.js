'use strict';

/**
 * heapDump.js — 纯叶子(zero-IO,确定性):`/heapdump` 命令背后的全部纯逻辑。
 *
 * 对齐 Claude Code `/heapdump`(src/utils/heapDumpService.ts):落一份 V8 堆快照
 * (`.heapsnapshot`)用于 Chrome DevTools 内存分析,并**同时**落一份内存诊断 JSON
 * (`MemoryDiagnostics`)—— 因为堆快照只含 V8 堆,原生内存(mallocedMemory /
 * detachedContexts / RSS)不在快照里,诊断 JSON 才能区分泄漏在 V8 堆还是原生内存。
 *
 * **背后逻辑**(dump id 生成、诊断对象组装、结果/错误措辞)全在这里,确定性、
 * 零 IO、零业务 require —— 所有外部量(now / sessionId / process.memoryUsage() /
 * v8.getHeapStatistics() / getHeapSpaceStatistics() / uptime)都由薄壳
 * `handlers/heapdump.js` 注入。真正写快照(`v8.writeHeapSnapshot`)与写诊断 JSON
 * (`fs.writeFileSync`)是副作用,留在薄壳。
 *
 * 门控 KHY_HEAPDUMP 默认开;关(0/false/off/no)→ 命令不接管(薄壳返回 false 字节回退)。
 */

const path = require('path');

function isEnabled(env) {
  const raw = env && env.KHY_HEAPDUMP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 把 epoch 毫秒转成文件名安全的时间戳片段(确定性,不读时钟)。
 * 例:1719700000000 → "2024-06-29T22-26-40-000Z"(冒号/点换 `-`,Windows 文件名安全)。
 */
function _timestampSlug(now) {
  const n = Number(now);
  const ms = Number.isFinite(n) && n >= 0 ? n : 0;
  // 注意:不调用 argless new Date();显式以注入的 epoch 构造,纯函数。
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/**
 * 生成本次 dump 的基名(不含扩展名)。sessionId 缺失时退化为 'manual'。
 */
function buildDumpId(now, sessionId) {
  const slug = _timestampSlug(now);
  const sid = String(sessionId == null ? '' : sessionId).trim();
  const shortSid = sid ? sid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) : '';
  return shortSid ? `heap-${slug}-${shortSid}` : `heap-${slug}`;
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toFiniteOr0;

/**
 * 组装内存诊断对象(对齐 CC MemoryDiagnostics 的字段子集,手动触发故
 * trigger:'manual' / dumpNumber:0)。所有数值经 _num 守卫缺失/非数 → 0。
 *
 * @param {object} p
 * @param {number} p.now          epoch ms(注入,不读时钟)
 * @param {string} p.sessionId
 * @param {number} p.uptimeSeconds process.uptime()
 * @param {object} p.memoryUsage  process.memoryUsage()
 * @param {object} p.heapStats    v8.getHeapStatistics()
 * @param {Array}  [p.heapSpaces] v8.getHeapSpaceStatistics()
 */
function buildDiagnostics(p = {}) {
  const mem = p.memoryUsage || {};
  const hs = p.heapStats || {};
  const spaces = Array.isArray(p.heapSpaces) ? p.heapSpaces : [];
  return {
    timestamp: new Date(_num(p.now)).toISOString(),
    sessionId: String(p.sessionId == null ? '' : p.sessionId),
    trigger: 'manual',
    dumpNumber: 0,
    uptimeSeconds: _num(p.uptimeSeconds),
    memoryUsage: {
      heapUsed: _num(mem.heapUsed),
      heapTotal: _num(mem.heapTotal),
      external: _num(mem.external),
      arrayBuffers: _num(mem.arrayBuffers),
      rss: _num(mem.rss),
    },
    v8HeapStats: {
      heapSizeLimit: _num(hs.heap_size_limit),
      mallocedMemory: _num(hs.malloced_memory),
      peakMallocedMemory: _num(hs.peak_malloced_memory),
      detachedContexts: _num(hs.number_of_detached_contexts),
      nativeContexts: _num(hs.number_of_native_contexts),
    },
    v8HeapSpaces: spaces.map((s) => ({
      name: String((s && s.space_name) || ''),
      size: _num(s && s.space_size),
      used: _num(s && s.space_used_size),
      available: _num(s && s.space_available_size),
    })),
  };
}

function _mb(bytes) {
  return (_num(bytes) / (1024 * 1024)).toFixed(1);
}

/**
 * 成功措辞:堆快照路径 + 诊断 JSON 路径 + 关键指标摘要 + DevTools 使用提示。
 * 对齐 CC「heapPath\ndiagPath」并补本地可读说明。
 */
function formatResult(r = {}) {
  const heapPath = String(r.heapPath || '');
  const diagPath = String(r.diagPath || '');
  const diag = r.diagnostics || {};
  const mem = diag.memoryUsage || {};
  const lines = [
    '已生成 V8 堆快照:',
    '  快照(.heapsnapshot):' + heapPath,
    '  诊断(.json)        :' + diagPath,
  ];
  if (mem.heapUsed != null) {
    lines.push(
      '  摘要:heapUsed ' + _mb(mem.heapUsed) + ' MB · rss ' + _mb(mem.rss) +
      ' MB · external ' + _mb(mem.external) + ' MB'
    );
  }
  lines.push(
    '提示:在 Chrome DevTools → Memory → Load profile 里打开 ' +
    path.basename(heapPath) + ' 分析对象保留树;诊断 JSON 含原生内存指标(快照不含)。'
  );
  return lines.join('\n');
}

function formatError(message) {
  return '生成堆快照失败:' + String(message == null ? 'unknown error' : message);
}

module.exports = {
  isEnabled,
  buildDumpId,
  buildDiagnostics,
  formatResult,
  formatError,
  _timestampSlug,
  _num,
};
