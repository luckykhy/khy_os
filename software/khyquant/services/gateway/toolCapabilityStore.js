'use strict';

/**
 * toolCapabilityStore.js — 「按模型实测出的工具调用能力」单一真源的持久缓存。
 *
 * 实测(toolCallingProbe + aiGateway.verifyToolCalling)产出的 'native'/'text' 裁决落在这里,
 * 供决策层 modelToolingCapability 的 measured 入参消费,从而**实测胜过按名字硬编码的启发**。
 *
 * 设计(镜像 modelCuration 的持久化范式):
 *   - 落 <baseHome>/tool_capability.json(getBaseDataDir,即 ~/.khyos;env KHY_TOOL_CAP_FILE 覆盖)。
 *   - 原子写 temp→rename,绝不留半截文件;读/写全 best-effort,绝不抛(网关热路径不能被磁盘拖垮)。
 *   - 内存 _cache 惰性加载,首次读盘后常驻;_resetCache 供测试。
 *   - TTL 由 toolCallingProbe.shouldReprobe 判定(单一真源),过期即视为「未测」返回 null。
 *
 * 键 = 规范化 model id(toolCallingProbe.normalizeModel)。刻意只按模型名,与既有启发式同维度,
 * 绕开「callOpenAI 处 poolKey/endpoint 身份丢失」的穿线难题——每个消费点与探测点都拿得到 model 串。
 *
 * 注:本模块做文件 IO,**不是纯叶子**(同 modelCuration);决策/解释/TTL 等纯逻辑在
 * toolCallingProbe.js。两者职责分离。
 */

const fs = require('fs');
const path = require('path');
const { getBaseDataDir } = require('../../utils/dataHome');
const probe = require('./toolCallingProbe');

const SCHEMA_VERSION = 1;

function _file() {
  const override = process.env.KHY_TOOL_CAP_FILE;
  if (override && String(override).trim()) return String(override).trim();
  return path.join(getBaseDataDir('.'), 'tool_capability.json');
}

let _cache = null; // { version, entries: { [normModel]: { verdict, source, measuredAt, latencyMs } } }

function _load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(_file(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      _cache = { version: SCHEMA_VERSION, entries: parsed.entries };
    } else {
      _cache = { version: SCHEMA_VERSION, entries: {} };
    }
  } catch {
    _cache = { version: SCHEMA_VERSION, entries: {} };
  }
  return _cache;
}

function _save(state) {
  _cache = state;
  const file = _file();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch { /* best effort — 热路径绝不因磁盘失败而抛 */ }
}

/**
 * 读取某模型的实测裁决。未测/记录非法/已过 TTL → null(决策层据此回落到名字启发)。
 * @param {string} model
 * @returns {'native'|'text'|null}
 */
function getVerdict(model) {
  try {
    const key = probe.normalizeModel(model);
    if (!key) return null;
    const entry = _load().entries[key];
    if (!entry) return null;
    if (probe.shouldReprobe(entry)) return null; // 过期视为未测
    return entry.verdict === 'native' || entry.verdict === 'text' ? entry.verdict : null;
  } catch {
    return null;
  }
}

/**
 * 读取完整记录(含 source/measuredAt/latencyMs),无/过期 → null。供 CLI/重测判定使用。
 * @param {string} model
 * @returns {object|null}
 */
function getRecord(model) {
  try {
    const key = probe.normalizeModel(model);
    if (!key) return null;
    const entry = _load().entries[key];
    if (!entry) return null;
    if (probe.shouldReprobe(entry)) return null;
    return { model: key, ...entry };
  } catch {
    return null;
  }
}

/**
 * 写入实测裁决。verdict 必须是 'native'|'text'('unknown' 不记录,留待重测)。
 * @param {string} model
 * @param {'native'|'text'} verdict
 * @param {{source?:string, latencyMs?:number}} [meta]
 * @returns {boolean} 是否写入
 */
function recordVerdict(model, verdict, meta = {}) {
  try {
    const key = probe.normalizeModel(model);
    if (!key) return false;
    if (verdict !== 'native' && verdict !== 'text') return false;
    const state = _load();
    state.entries[key] = {
      verdict,
      source: meta && meta.source ? String(meta.source) : 'probe',
      measuredAt: Date.now(),
      latencyMs: meta && Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
    };
    _save(state);
    return true;
  } catch {
    return false;
  }
}

/** 列出全部新鲜记录(过期的剔除),供 CLI 展示。 */
function listFresh() {
  try {
    const entries = _load().entries;
    const out = [];
    for (const [k, v] of Object.entries(entries)) {
      if (!probe.shouldReprobe(v)) out.push({ model: k, ...v });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 「判断通过的纳入数组」——返回**确证能调工具(verdict==='native')且新鲜**的模型数组。
 * 这是持久存储面向使用方/CLI 的「通过数组」投影:确证通过即 sticky 常驻,绝不重测浪费。
 * 主存储用按模型 id 的 map(O(1) 供剥离/教学门逐模型查),本函数给出其数组视图。
 * @returns {Array<{model:string, verdict:'native', source?:string, measuredAt?:number, latencyMs?:number}>}
 */
function listPassing() {
  try {
    const entries = _load().entries;
    const out = [];
    for (const [k, v] of Object.entries(entries)) {
      if (v && v.verdict === 'native' && !probe.shouldReprobe(v)) out.push({ model: k, ...v });
    }
    return out;
  } catch {
    return [];
  }
}

/** 测试用:清内存缓存。 */
function _resetCache() {
  _cache = null;
}

module.exports = {
  SCHEMA_VERSION,
  getVerdict,
  getRecord,
  recordVerdict,
  listFresh,
  listPassing,
  _file,
  _resetCache,
};
