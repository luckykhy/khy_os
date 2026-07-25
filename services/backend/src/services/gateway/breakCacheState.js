'use strict';

/**
 * breakCacheState.js — `/break-cache` 的薄壳:marker/flag/事件日志的文件读写,
 * 以及网关消费侧调用的 `consumeCacheBreakNonce`。所有纯逻辑(scope/nonce/聚合/措辞)
 * 委托纯叶子 `cli/breakCache.js`,本壳只做副作用 + 注入 now/rand。
 *
 * 文件落在 `getDataDir('break-cache')`(项目数据根下,跨进程可发现):
 *   - `next-request-no-cache`  一次性 marker(存在=下一次调用击穿后消费)
 *   - `break-cache-always`     持久 flag(存在=每次调用都击穿)
 *   - `break-cache-events.jsonl` 追加型事件日志(并发写不丢增量)
 *
 * 门控 KHY_BREAK_CACHE 默认开;关 → consumeCacheBreakNonce 恒返回 ''(网关侧字节回退,
 * 绝不注入 nonce),命令侧也不接管。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const leaf = require('../../cli/breakCache');

function _dir() {
  try {
    return require('../../utils/dataHome').getDataDir('break-cache');
  } catch {
    return require('os').tmpdir();
  }
}

function getPaths() {
  const dir = _dir();
  return {
    marker: path.join(dir, 'next-request-no-cache'),
    always: path.join(dir, 'break-cache-always'),
    stats: path.join(dir, 'break-cache-events.jsonl'),
  };
}

// 收敛到 utils/existsSyncSafe 单一真源(逐字节委托,调用点不变)
const _existsSafe = require('../../utils/existsSyncSafe');

function readStats() {
  const { stats } = getPaths();
  let raw = '';
  try { raw = fs.readFileSync(stats, 'utf8'); } catch { raw = ''; }
  return leaf.aggregateStats(raw);
}

function appendEvent(kind) {
  const { stats } = getPaths();
  try {
    fs.appendFileSync(stats, leaf.buildEvent(Date.now(), kind), 'utf8');
  } catch { /* best-effort: stats are diagnostic, never block the command */ }
}

function scheduleOnce() {
  const { marker } = getPaths();
  try { fs.writeFileSync(marker, new Date(Date.now()).toISOString(), 'utf8'); } catch { /* ignore */ }
  appendEvent('once');
  return { marker, stats: readStats() };
}

function enableAlways() {
  const { always } = getPaths();
  try { fs.writeFileSync(always, new Date(Date.now()).toISOString(), 'utf8'); } catch { /* ignore */ }
  appendEvent('always_on');
  return { always };
}

function disable() {
  const { marker, always } = getPaths();
  let cleared = false;
  if (_existsSafe(marker)) { try { fs.unlinkSync(marker); cleared = true; } catch { /* ignore */ } }
  if (_existsSafe(always)) { try { fs.unlinkSync(always); cleared = true; } catch { /* ignore */ } }
  appendEvent('always_off');
  return cleared;
}

function clearOnce() {
  const { marker } = getPaths();
  if (_existsSafe(marker)) {
    try { fs.unlinkSync(marker); return { hadMarker: true, marker }; } catch { /* ignore */ }
  }
  return { hadMarker: false, marker };
}

function status() {
  const { marker, always } = getPaths();
  return {
    stats: readStats(),
    onceActive: _existsSafe(marker),
    alwaysActive: _existsSafe(always),
  };
}

/**
 * 网关消费侧:在组装系统提示前调用。门控关 → ''(字节回退,绝不注入)。
 * 否则:若一次性 marker 存在 → 生成 nonce 注释并**消费**(删除 marker);
 *       否则若持久 flag 存在 → 生成 nonce 注释(不删 flag,持续生效);
 *       都不存在 → ''。
 *
 * 返回要前置到系统提示最前面的字符串(空串=不改任何东西)。
 */
function consumeCacheBreakNonce(env) {
  if (!leaf.isEnabled(env || process.env)) return '';
  const { marker, always } = getPaths();
  const onceActive = _existsSafe(marker);
  const alwaysActive = !onceActive && _existsSafe(always);
  if (!onceActive && !alwaysActive) return '';
  const rand = crypto.randomBytes(8).toString('hex');
  const nonce = leaf.buildNonceComment(Date.now(), rand);
  if (onceActive) {
    try { fs.unlinkSync(marker); } catch { /* already gone */ }
  }
  return nonce;
}

module.exports = {
  getPaths,
  readStats,
  scheduleOnce,
  enableAlways,
  disable,
  clearOnce,
  status,
  consumeCacheBreakNonce,
};
