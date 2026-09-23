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
 * 另一类记录:`route:` 前缀的**通道级**记录(某条通道收不收 tools 字段),与模型级记录同文件
 * 分区存放。两者语义、证据来源、传播规则都不同,绝不能互相写串 —— 详见 recordRouteRejects。
 *
 * 注:本模块做文件 IO,**不是纯叶子**(同 modelCuration);决策/解释/TTL 等纯逻辑在
 * toolCallingProbe.js。两者职责分离。
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../../utils/dataHome');

const probe = require('./toolCallingProbe');

const SCHEMA_VERSION = 1;

/**
 * 通道级记录的键前缀。与模型级记录共用同一个文件,用前缀分区 —— 因为两者是不同的东西:
 *   - 无前缀键 = **模型**能不能原生调工具(带 adapter 前缀的历史键由 _migrateKeys 折叠);
 *   - `route:` 键 = 某条**通道**收不收 tools 字段(端点属性,不是模型属性)。
 * 分开的理由见 recordRouteRejects。
 */
const ROUTE_KEY_PREFIX = 'route:';

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
    // 通道级记录(:route:)不参与模型键规范化。它是 `route:<adapter>::<host>::<model>` 的
    // 复合键,拿 capabilityModelKey 去过它就是在改一个不属于模型命名空间的名字。
    if (rawKey.startsWith(ROUTE_KEY_PREFIX)) {
      out[rawKey] = entry;
      continue;
    }
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
 *
 * 不做来源过滤 —— 语义见 getVerdictFor。
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
 * 按**来源**读取实测裁决 —— 非对称继承(P4 余项):
 *
 *   - `native`(**正面**证据)**全局共享**:见过一次真实的原生 tool_calls,说明这个模型有这个
 *     能力;换条适配器大概率也还在。乐观继承,不设门槛。
 *   - `text`(**负面**证据)**只在测出它的那条适配器上生效**:「这条通道上它没走原生」不能被
 *     推广成「这模型在任何通道都不会原生」。悲观不扩散 —— 反了就会重演 BUG-014 的形态
 *     (一条通道的结论替另一条通道做决定)。
 *
 * 任一侧来源未知 → 按**适用**处理(保持既有行为,向后兼容:历史记录没有 adapter 字段)。
 * 判「未知」比判「不适用」安全:不适用会让模型在该通道**丢掉**原生工具,而未知只是维持现状。
 * @param {string} model
 * @param {{adapter?: string}} [opts]
 * @returns {'native'|'text'|null}
 */
function getVerdictFor(model, opts = {}) {
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
    const verdict = entry.verdict;
    if (verdict === 'native') {
      return 'native';
    }
    if (verdict !== 'text') {
      return null;
    }
    const recorded = String(entry.adapter || '')
      .trim()
      .toLowerCase();
    const queried = String((opts && opts.adapter) || '')
      .trim()
      .toLowerCase();
    if (!recorded || !queried) {
      return 'text';
    } // 来源未知 → 适用
    return recorded === queried ? 'text' : null;
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
 *
 * **provenance(P4)**:meta.adapter 记下这次裁决是在哪条适配器上测出来的。用途见
 * getVerdictFor —— 负向裁决不跨适配器扩散,正向裁决跨。
 * @param {string} model
 * @param {'native'|'text'} verdict
 * @param {{source?:string, latencyMs?:number, force?:boolean, adapter?:string}} [meta]
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
    const adapter = meta && meta.adapter ? String(meta.adapter).trim().toLowerCase() : '';
    state.entries[key] = {
      verdict,
      source: meta && meta.source ? String(meta.source) : 'probe',
      measuredAt: Date.now(),
      latencyMs: meta && Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
      // 空白/缺失 → null(不是空串):「没记来源」必须与「来源叫 ''」区分开。
      adapter: adapter || null,
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

// ── 通道级记录:某条通道收不收 tools 字段 ────────────────────────────────────
//
// 为什么单独一组 API 而不是复用 getVerdict/recordVerdict:
//   1. **语义不同**。模型级答「这个模型会不会原生调工具」;通道级答「这个端点收不收
//      tools 字段」。前者的证据来自模型输出,后者的证据来自 HTTP 状态码。
//   2. **传播规则不同**。负面模型裁决(`text`)现在要求正面证据且有界 TTL;通道裁决来自
//      一次真实的「带 tools 被拒、去掉 tools 成功」,是可复现的端点性质,但同样必须有界
//      (端点会升级),所以用同一个 ttlMs。
//   3. 绝不能混写:把通道拒绝按模型键落库,就是 BUG-014 里「一条严格端点的拒绝变成该
//      模型的永久属性、在其他通道上也被剥离」的成因。前缀分区让这两件事在存储层就不可能混淆。

/** 通道记录的键;routeId 为空 → ''(调用方放弃读写)。 */
function _routeEntryKey(routeId) {
  const id = String(routeId == null ? '' : routeId)
    .trim()
    .toLowerCase();
  return id ? ROUTE_KEY_PREFIX + id : '';
}

/**
 * 记住「这条通道收不了带 tools 的请求」。
 *
 * 调用点必须是**有对照的证据**:同一个请求带 tools 被拒(HTTP 400)、去掉 tools 之后
 * 成功了。仅仅「看到 400 且当时带着 tools」不够 —— 400 可能因为别的字段,那是归因错误。
 *
 * 有界 TTL(同 text 档的 ttlMs):端点支持情况会变(上游升级、换 key、换区域),通道裁决
 * 必须能自己过期重试,绝不变成永久封锁。
 * @param {string} routeId capabilityModelKey.routeKey() 的产物
 * @param {{source?: string, latencyMs?: number}} [meta]
 * @returns {boolean} 是否写入
 */
function recordRouteRejects(routeId, meta = {}) {
  try {
    const key = _routeEntryKey(routeId);
    if (!key) {
      return false;
    }
    const state = _load();
    state.entries[key] = {
      verdict: 'route-rejects-tools',
      source: meta && meta.source ? String(meta.source) : 'http-400',
      measuredAt: Date.now(),
      latencyMs: meta && Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
    };
    _save(state);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这条通道是否**新鲜地**被记为「拒收 tools」。
 *
 * 刻意不复用 probe.shouldReprobe:它的口径是「模型级三态(native/text)的 TTL 判定」,
 * 遇到未知 verdict 一律返回 true(=该重测)。通道记录用它会被当成永远过期 → 记忆失效。
 * 这里按同一个 ttlMs 独立判龄。
 * @param {string} routeId
 * @returns {boolean}
 */
function routeRejectsTools(routeId) {
  try {
    const key = _routeEntryKey(routeId);
    if (!key) {
      return false;
    }
    const entry = _load().entries[key];
    if (!entry || entry.verdict !== 'route-rejects-tools') {
      return false;
    }
    const measuredAt = Number(entry.measuredAt);
    if (!Number.isFinite(measuredAt)) {
      return true;
    } // 记录非法 → 视为有效(保守:宁可少发一次 tools)
    return Date.now() - measuredAt <= probe.ttlMs();
  } catch {
    return false;
  }
}

/** 列出新鲜(未过期)的通道拒收记录,供 CLI 展示与排障。 */
function listRouteRejections() {
  try {
    const entries = _load().entries;
    const out = [];
    for (const [k, v] of Object.entries(entries)) {
      if (!k.startsWith(ROUTE_KEY_PREFIX) || !v || v.verdict !== 'route-rejects-tools') {
        continue;
      }
      const measuredAt = Number(v.measuredAt);
      if (Number.isFinite(measuredAt) && Date.now() - measuredAt > probe.ttlMs()) {
        continue;
      }
      out.push({ route: k.slice(ROUTE_KEY_PREFIX.length), ...v });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 便捷写入口:由通道的物理身份直接记忆拒收,键的构造交给 capabilityModelKey.routeKey
 * (单一真源)。适配器侧只需把手上有的东西报上来,不做任何键运算 —— 两处调用点各写一遍
 * 键拼接就是下一个漂移点。
 * @param {{adapter?: string, provider?: string, endpoint?: string, baseUrl?: string, model?: string, source?: string, latencyMs?: number}} [opts]
 * @returns {boolean}
 */
function recordRouteRejectsFrom(opts = {}) {
  try {
    const { routeKey } = require('./capabilityModelKey');
    const id = routeKey(opts);
    if (!id) {
      return false;
    }
    return recordRouteRejects(id, { source: opts.source, latencyMs: opts.latencyMs });
  } catch {
    return false;
  }
}

/**
 * 便捷读入口:剥离门在发请求前问「这条通道是不是已经被记为拒收 tools」。
 * fail-soft:键算不出或存储不可用 → false(=照常发 tools,与「未知」同档)。
 * @param {{adapter?: string, provider?: string, endpoint?: string, baseUrl?: string, model?: string}} [opts]
 * @returns {boolean}
 */
function routeRejectsToolsFor(opts = {}) {
  try {
    const { routeKey } = require('./capabilityModelKey');
    return routeRejectsTools(routeKey(opts));
  } catch {
    return false;
  }
}

module.exports = {
  SCHEMA_VERSION,
  ROUTE_KEY_PREFIX,
  getVerdict,
  getVerdictFor,
  getRecord,
  recordVerdict,
  recordRouteRejects,
  routeRejectsTools,
  recordRouteRejectsFrom,
  routeRejectsToolsFor,
  listFresh,
  listPassing,
  listRouteRejections,
  _file,
  _resetCache,
};
