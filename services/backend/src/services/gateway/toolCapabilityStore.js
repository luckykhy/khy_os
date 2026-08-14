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
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return path.join(getBaseDataDir('.'), 'tool_capability.json');
}

let _cache = null; // { version, entries: { [normModel]: { verdict, source, measuredAt, latencyMs } } }

/**
 * 把历史上带适配器前缀写入的键(`api:agnes:agnes-2.5-flash`)迁移到规范键(裸模型名)。
 *
 * 为什么需要:主动探测曾按路由 id 写库、被动学习按裸名写库,于是同一个模型留下两条键
 * 不同、裁决相反的记录,两道闸各读一条 → 模型同时收到「有原生工具」与「你没有原生
 * 工具」两套指令(见 capabilityModelKey.js 头部)。键规范化之后旧键会变成读不到的孤儿,
 * 这里在加载时就地合并,让已有的缓存文件自愈,而不是让用户去手删 JSON。
 *
 * 撞键时的取舍:**'native' 压过 'text'** —— 观察到过一次真实的原生 tool_calls 是正面
 * 证据,而 'text' 只是「这一次没看到」,是证据的缺席。同为 native 或同为 text 时取
 * measuredAt 更新的那条。
 * @param {object} entries
 * @returns {{entries: object, changed: boolean}}
 */
function _migrateKeys(entries) {
  const out = {};
  let changed = false;
  for (const [rawKey, entry] of Object.entries(entries || {})) {
    let key = rawKey;
    try {
      key = probe.normalizeModel(rawKey) || rawKey;
    } catch {
      key = rawKey;
    }
    if (key !== rawKey) {
      changed = true;
    }
    const prev = out[key];
    if (!prev) {
      out[key] = entry;
      continue;
    }
    changed = true;
    out[key] = _preferEntry(prev, entry);
  }
  return { entries: out, changed };
}

/** 二选一:native 胜 text;同档取更新的那条。 */
function _preferEntry(a, b) {
  const av = a && a.verdict;
  const bv = b && b.verdict;
  if (av === 'native' && bv !== 'native') {
    return a;
  }
  if (bv === 'native' && av !== 'native') {
    return b;
  }
  const at = Number(a && a.measuredAt) || 0;
  const bt = Number(b && b.measuredAt) || 0;
  return bt > at ? b : a;
}

function _load() {
  if (_cache) {
    return _cache;
  }
  try {
    const raw = fs.readFileSync(_file(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      const migrated = _migrateKeys(parsed.entries);
      _cache = { version: SCHEMA_VERSION, entries: migrated.entries };
      // 迁移结果落盘一次,避免每次启动都重算(写失败也无妨——内存里已是规范键)。
      if (migrated.changed) {
        _save(_cache);
      }
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
  } catch {
    /* best effort — 热路径绝不因磁盘失败而抛 */
  }
}

/**
 * 读取某模型的实测裁决。未测/记录非法/已过 TTL → null(决策层据此回落到名字启发)。
 * @param {string} model
 * @returns {'native'|'text'|null}
 */
function getVerdict(model) {
  try {
    const key = probe.normalizeModel(model);
    if (!key) {
      return null;
    }
    const entry = _load().entries[key];
    if (!entry) {
      return null;
    }
    if (probe.shouldReprobe(entry)) {
      return null;
    } // 过期视为未测
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
    if (!key) {
      return null;
    }
    const entry = _load().entries[key];
    if (!entry) {
      return null;
    }
    if (probe.shouldReprobe(entry)) {
      return null;
    }
    return { model: key, ...entry };
  } catch {
    return null;
  }
}

/**
 * 写入实测裁决。verdict 必须是 'native'|'text'('unknown' 不记录,留待重测)。
 *
 * **不静默降级**:已有一条新鲜的 'native' 记录时,一次 'text' 观测**不会**覆盖它 ——
 * 「见过一次真实的原生 tool_calls」是正面证据,「这次没见到」只是证据的缺席(探测用的
 * 极简单工具 + 极短 maxTokens 与真实一轮差别很大,假阴性完全正常)。降级必须显式:
 * CLI 主动重测传 force,或用户经 KHY_TEXT_ONLY_TOOL_MODELS 钉死。
 * 这条不变量原本只写在被动学习那侧的注释里(aiGatewayGenerateMethod.js:771「只晋升不
 * 降级」),但存储层并不强制,于是一次探测就能把它推翻 —— 现在由存储层保证。
 * @param {string} model
 * @param {'native'|'text'} verdict
 * @param {{source?:string, latencyMs?:number, force?:boolean}} [meta]
 * @returns {boolean} 是否写入
 */
function recordVerdict(model, verdict, meta = {}) {
  try {
    const key = probe.normalizeModel(model);
    if (!key) {
      return false;
    }
    if (verdict !== 'native' && verdict !== 'text') {
      return false;
    }
    const state = _load();
    const prev = state.entries[key];
    if (
      verdict === 'text' &&
      !(meta && meta.force) &&
      prev &&
      prev.verdict === 'native' &&
      !probe.shouldReprobe(prev)
    ) {
      return false; // 拒绝把「确证支持」降级成「这次没看到」
    }
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
      if (!probe.shouldReprobe(v)) {
        out.push({ model: k, ...v });
      }
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
      if (v && v.verdict === 'native' && !probe.shouldReprobe(v)) {
        out.push({ model: k, ...v });
      }
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
