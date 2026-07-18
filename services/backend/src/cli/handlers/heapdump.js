'use strict';

/**
 * heapdump.js — `/heapdump` 命令薄壳:落一份 V8 堆快照 + 内存诊断 JSON。
 * 对齐 Claude Code `/heapdump`(utils/heapDumpService.ts)。
 *
 * **背后逻辑**(dump id、诊断对象组装、措辞)全在纯叶子 `cli/heapDump.js`;
 * 本壳只做副作用:门控、采集 V8/进程内存量(注入给叶子)、用
 * `v8.writeHeapSnapshot` 写快照、`fs.writeFileSync` 写诊断 JSON、打印回执。
 *
 * 写入目录 = `getDataDir('heapdump')`(项目数据根下,跨调用可发现)。
 *
 * 门控 KHY_HEAPDUMP 默认开;关 → 命令不接管(返回 false 字节回退)。
 */

const { printInfo, printError, printSuccess } = require('../formatters');
const leaf = require('../heapDump');

async function handleHeapdump(_subCommand, _args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('heapdump 命令未启用(KHY_HEAPDUMP=off)。');
    return false;
  }

  let v8;
  let fs;
  let pathMod;
  try {
    v8 = require('v8');
    fs = require('fs');
    pathMod = require('path');
  } catch (e) {
    printError(leaf.formatError(e && e.message ? e.message : String(e)));
    return true;
  }

  let dir;
  try {
    dir = require('../../utils/dataHome').getDataDir('heapdump');
  } catch {
    dir = require('os').tmpdir();
  }

  let sessionId = '';
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId() || '';
  } catch { /* best-effort; manual dump tolerates no session */ }

  const now = Date.now();
  const dumpId = leaf.buildDumpId(now, sessionId);
  const heapPath = pathMod.join(dir, dumpId + '.heapsnapshot');
  const diagPath = pathMod.join(dir, dumpId + '.json');

  printInfo('正在生成 V8 堆快照(大堆可能耗时数秒,期间会短暂暂停)…');

  // 1) 堆快照(可能较大;writeHeapSnapshot 同步直写到磁盘,避免占用额外内存)。
  try {
    v8.writeHeapSnapshot(heapPath);
  } catch (e) {
    printError(leaf.formatError(e && e.message ? e.message : String(e)));
    return true;
  }

  // 2) 内存诊断 JSON —— 采集量注入纯叶子组装,确定性。
  let diagnostics = null;
  try {
    diagnostics = leaf.buildDiagnostics({
      now,
      sessionId,
      uptimeSeconds: typeof process.uptime === 'function' ? process.uptime() : 0,
      memoryUsage: process.memoryUsage ? process.memoryUsage() : {},
      heapStats: typeof v8.getHeapStatistics === 'function' ? v8.getHeapStatistics() : {},
      heapSpaces: typeof v8.getHeapSpaceStatistics === 'function' ? v8.getHeapSpaceStatistics() : [],
    });
    fs.writeFileSync(diagPath, JSON.stringify(diagnostics, null, 2));
  } catch (e) {
    // 快照已落盘是主要产物;诊断 JSON 失败如实告知但不当作整体失败。
    printError('诊断 JSON 写入失败(堆快照已生成):' + (e && e.message ? e.message : String(e)));
    printSuccess('已生成 V8 堆快照:' + heapPath);
    return true;
  }

  printSuccess(leaf.formatResult({ heapPath, diagPath, diagnostics }));
  return true;
}

module.exports = { handleHeapdump };
