'use strict';

/**
 * registry.js — 外部 agent 工具注册表:声明式 SSOT,**零厂商专属逻辑**。
 *
 * 表里每家只有三样东西:id、给用户看的中文标签、适配器模块名。「支持哪几类资产、
 * 能不能写、资产根目录在哪」全部由适配器自己的 capabilities()/detect() 声明——注册表
 * 一个字都不知道。故新增一家工具 = 新增一个 adapters/<id>.js + 本表加一行,
 * 编排层与工具层无需改动(验收标准 2 由 agentAssets.registry 测试锁死)。
 *
 * 与 agentLauncherRegistry 的分工:那张表管「怎么启动外部 agent」,本表管
 * 「外部 agent 的资产在哪、怎么读写」。两张表刻意不合并——启动器按 gateway adapter
 * 组织(一家可能有多个 launcher),资产按工具的磁盘布局组织(一家一份布局)。
 *
 * 本模块不自称纯叶子:resolveAdapter 会惰性 require 适配器模块(适配器要碰磁盘)。
 * 表本身与所有查询函数是确定性的、可脱离磁盘单测的。
 */

const { isEnabled } = require('./assetModel');

/**
 * 声明式注册表。字段:
 *   id     — 工具标识(小写,CLI/工具层参数用它)
 *   label  — 面向用户的中文名
 *   module — 适配器模块名(相对 adapters/)
 */
const AGENT_ASSET_SOURCES = Object.freeze([
  Object.freeze({ id: 'khy-os', label: 'khy-os 本地资产库', module: 'khyOs' }),
  Object.freeze({ id: 'opencode', label: 'opencode', module: 'opencode' }),
  Object.freeze({ id: 'claude-code', label: 'Claude Code', module: 'claudeCode' }),
  Object.freeze({ id: 'harness', label: '通用 agent harness', module: 'harness' }),
  Object.freeze({ id: 'deepseek-harness', label: 'DeepSeek Harness', module: 'deepseekHarness' }),
  Object.freeze({ id: 'openclaw', label: 'OpenClaw', module: 'openclaw' }),
]);

const _adapterCache = new Map();

/**
 * 注册的工具 id 列表。门关 → 返空数组(编排层据此明确拒绝)。
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
function listSourceIds(env) {
  if (!isEnabled(env)) {
    return [];
  }
  return AGENT_ASSET_SOURCES.map((s) => s.id);
}

/**
 * 查表项(不加载适配器)。
 * @param {string} id
 * @returns {{ id: string, label: string, module: string }|null}
 */
function getSource(id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  if (!key) {
    return null;
  }
  return AGENT_ASSET_SOURCES.find((s) => s.id === key) || null;
}

/**
 * 解析并缓存适配器实例。绝不抛:模块缺失/语法错 → { ok:false, error }。
 * @param {string} id
 * @param {Record<string,string>} [env]
 * @returns {{ ok: true, adapter: object, source: object } | { ok: false, error: string }}
 */
function resolveAdapter(id, env) {
  if (!isEnabled(env)) {
    return { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)' };
  }
  const source = getSource(id);
  if (!source) {
    return {
      ok: false,
      error: `未注册的外部 agent 工具:${id || '(空)'}（已注册:${AGENT_ASSET_SOURCES.map((s) => s.id).join(' / ')}）`,
    };
  }
  if (_adapterCache.has(source.id)) {
    return { ok: true, adapter: _adapterCache.get(source.id), source };
  }
  try {
    const adapter = require(`./adapters/${source.module}`);
    _adapterCache.set(source.id, adapter);
    return { ok: true, adapter, source };
  } catch (e) {
    return { ok: false, error: `适配器加载失败(${source.id}):${(e && e.message) || e}` };
  }
}

/**
 * 全部已注册工具的能力清单 + 探测结果。任何一家探测失败都不影响其余家
 * (本机没装该工具是常态,不是错误)。
 *
 * @param {Record<string,string>} [env]
 * @returns {{ ok: boolean, sources: Array<object>, error?: string }}
 */
function describeSources(env) {
  if (!isEnabled(env)) {
    return {
      ok: false,
      sources: [],
      error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)',
    };
  }
  const sources = [];
  for (const entry of AGENT_ASSET_SOURCES) {
    const resolved = resolveAdapter(entry.id, env);
    if (!resolved.ok) {
      sources.push({
        id: entry.id,
        label: entry.label,
        detected: false,
        error: resolved.error,
        capabilities: null,
      });
      continue;
    }
    let detection = { ok: false, error: '适配器未实现 detect()' };
    let capabilities = null;
    try {
      detection = resolved.adapter.detect(env) || detection;
    } catch (e) {
      detection = { ok: false, error: `detect 异常:${(e && e.message) || e}` };
    }
    try {
      capabilities = resolved.adapter.capabilities(env) || null;
    } catch (e) {
      capabilities = { error: `capabilities 异常:${(e && e.message) || e}` };
    }
    sources.push({
      id: entry.id,
      label: entry.label,
      detected: detection.ok === true,
      root: detection.ok ? detection.root : '',
      checked: Array.isArray(detection.checked) ? detection.checked : [],
      error: detection.ok ? '' : detection.error || '',
      capabilities,
    });
  }
  return { ok: true, sources };
}

/** 测试钩子:清掉适配器缓存(单测里换 env 重新探测用)。 */
function _resetAdapterCache() {
  _adapterCache.clear();
}

module.exports = {
  AGENT_ASSET_SOURCES,
  listSourceIds,
  getSource,
  resolveAdapter,
  describeSources,
  _resetAdapterCache,
};
