'use strict';

/**
 * breakCache.js — `/break-cache` 命令薄壳:调度/开启/关闭 Anthropic 前缀缓存击穿。
 * 对齐 Claude Code `/break-cache`。
 *
 * **背后逻辑**(scope 解析、措辞、统计聚合)全在纯叶子 `cli/breakCache.js`;
 * 文件副作用(marker/flag/事件日志)在薄壳 `services/gateway/breakCacheState.js`;
 * 真正的缓存击穿在网关消费侧 `claudeAdapter` 调用 `consumeCacheBreakNonce` 完成。
 *
 * 门控 KHY_BREAK_CACHE 默认开;关 → 命令不接管(返回 false 字节回退),
 * 且网关侧 consumeCacheBreakNonce 恒返回 ''(绝不注入 nonce)。
 */

const { printInfo, printSuccess } = require('../formatters');
const leaf = require('../breakCache');
const state = require('../../services/gateway/breakCacheState');

async function handleBreakCache(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('break-cache 命令未启用(KHY_BREAK_CACHE=off)。');
    return false;
  }

  const tokens = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  const scope = leaf.parseScope(tokens);

  switch (scope) {
    case 'status': {
      const { stats, onceActive, alwaysActive } = state.status();
      printInfo(leaf.formatStatus(stats, onceActive, alwaysActive));
      return true;
    }
    case 'off': {
      const cleared = state.disable();
      printSuccess(leaf.formatOff(cleared));
      return true;
    }
    case 'clear': {
      const { hadMarker, marker } = state.clearOnce();
      printSuccess(leaf.formatClear(hadMarker, marker));
      return true;
    }
    case 'always': {
      const { always } = state.enableAlways();
      printSuccess(leaf.formatAlways(always));
      return true;
    }
    case 'once': {
      const { marker, stats } = state.scheduleOnce();
      printSuccess(leaf.formatOnce(stats, marker));
      return true;
    }
    default:
      printInfo(leaf.USAGE_TEXT);
      return true;
  }
}

module.exports = { handleBreakCache };
