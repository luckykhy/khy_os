'use strict';

/**
 * webToolsService.js — `/web-tools` 的 IO 层：采集 khy 联网搜索后端与动态引擎的
 * 当前状态，返回结构化数据。**非纯叶子**（探测后端 + 读盘 search_engines.json）。
 *
 * 采集三处（全部已存在于本仓，本 service 只读不写）：
 *   1) 主搜索后端可用性 → webSearchService.isAvailable() / isHtmlParsingAvailable()
 *   2) 动态引擎清单     → searchSourceDiscovery.loadDynamicEngines({env, configText})
 *                        （configText = 数据家 search_engines.json 原文）
 *   3) 配置文件路径     → dataHome.getAppDataDir('search_engines.json')
 *
 * 诚实边界：
 *   - **只读**：从不写 search_engines.json / settings，只浮现现状 + 编辑指引。
 *   - fail-soft：任一探测失败降级为保守默认（不可用 / 空引擎），绝不抛。
 *   - 门控由上层 handler / 叶子负责；本 service 只做采集。
 */

// 与 webSearchService._readEngineConfigText 同源的解析器家族快照（用于「可复用解析器」展示）。
// 保守：若无法从 discovery 模块取到就用这份内置回退。
const FALLBACK_PARSERS = ['baidu', 'bing', 'duckduckgo', 'sogou', 'so360', 'generic'];

function _readConfigText() {
  // 路径解析与读盘分离：即便文件缺失/不可读，也要保留解析出的路径供「编辑指引」展示。
  let p = '';
  try {
    // eslint-disable-next-line global-require
    const { getAppDataDir } = require('../utils/dataHome');
    p = getAppDataDir('search_engines.json') || '';
  } catch {
    p = '';
  }
  let text = '';
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // 仅读常规文件——防 EISDIR（该路径在某些机器上可能是残留目录）等边界。
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
      text = fs.readFileSync(p, 'utf8');
    }
  } catch {
    text = '';
  }
  return { path: p, text };
}

function _backendAvailable() {
  try {
    // eslint-disable-next-line global-require
    const svc = require('./webSearchService');
    return typeof svc.isAvailable === 'function' ? !!svc.isAvailable() : false;
  } catch {
    return false;
  }
}

function _htmlParsingAvailable() {
  try {
    // eslint-disable-next-line global-require
    const svc = require('./webSearchService');
    return typeof svc.isHtmlParsingAvailable === 'function' ? !!svc.isHtmlParsingAvailable() : false;
  } catch {
    return false;
  }
}

function _loadEngines(env, configText) {
  try {
    // eslint-disable-next-line global-require
    const disc = require('./search/searchSourceDiscovery');
    if (typeof disc.loadDynamicEngines !== 'function') return [];
    const list = disc.loadDynamicEngines({ env, configText });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function _discoveryEnabled(env) {
  // 委托给 searchSourceDiscovery.isEnabled（SSOT）——与 loadDynamicEngines 用同一闸，
  // 语义为默认开（仅 0/false/off 关）。绝不在此重实现闸，否则会与真实加载行为背离。
  try {
    // eslint-disable-next-line global-require
    const disc = require('./search/searchSourceDiscovery');
    if (typeof disc.isEnabled === 'function') return !!disc.isEnabled(env);
    // 回退：镜像 _envOn 默认开语义。
    const v = String((env && env.KHY_SEARCH_SOURCE_DISCOVERY) || '').trim().toLowerCase();
    return !['0', 'false', 'off'].includes(v);
  } catch {
    return false;
  }
}

/**
 * 采集联网搜索后端 / 动态引擎现状。
 * @param {Object} [options]
 * @param {Object} [options.env]  env（缺省 process.env）
 * @returns {Promise<Object>} {success, backend, fetch, discovery, engines, knownParsers, configPath, envEngineDeclared}
 */
async function gatherWebToolsStatus(options = {}) {
  const env = options.env || process.env || {};

  const { path: configPath, text: configText } = _readConfigText();
  const engines = _loadEngines(env, configText);

  return {
    success: true,
    backend: { name: 'Kiro MCP', available: _backendAvailable() },
    fetch: { htmlParsing: _htmlParsingAvailable() },
    discovery: { enabled: _discoveryEnabled(env), flag: 'KHY_SEARCH_SOURCE_DISCOVERY' },
    engines,
    knownParsers: FALLBACK_PARSERS,
    configPath,
    envEngineDeclared: !!(env && String(env.KHY_SEARCH_EXTRA_ENGINES || '').trim()),
  };
}

module.exports = { gatherWebToolsStatus };
