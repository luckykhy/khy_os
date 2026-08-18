'use strict';

/**
 * @pattern Factory Method, Singleton
 *
 * adapterRegistry.js — IM 渠道适配器的动态注册表:**按 env 开关启用,未启用的渠道零加载**。
 *
 * 开关:`KHY_IM_ADAPTERS=feishu,telegram`(逗号/空格/分号均可,大小写不敏感)。
 *   - 未设置 / 空 → 一个渠道都不启用(**opt-in**:IM 通道会向外建长连接并持有凭据,
 *     绝不能因为「装了就默认连」而在用户不知情时把消息推到第三方网关)。
 *   - `all` / `*`  → 启用全部已注册渠道(本机联调用)。
 *   - 未注册的名字 → 收进 `unknown` 并在日志里点名 + 列出可用渠道,**不**静默丢弃。
 * 主门控 `KHY_IM_ADAPTER_FRAMEWORK`(默认开,仅显式 0/false/off/no 关)可一键回退到
 * 「框架不介入」的状态,已登记进 services/flagRegistry.js。
 *
 * 零加载怎么做到的:注册项里存的是 `create` **thunk**,`require('./feishuAdapter')` 写在
 * thunk **体内**。所以没被 env 选中的渠道,它的模块文件从头到尾不会被 require——不加载
 * `ws`、不读配置文件、不占内存。这条性质由 tests/imAdapterRegistry.test.js 直接断言
 * (检查 require.cache 里没有该模块的 key),否则「顺手」把 require 提到文件顶部就会让
 * 零加载悄悄失效。
 *
 * 契约:非纯(读 env、懒 require、构造适配器)。`createAdapters` 对**单个渠道构造失败**
 * fail-soft(收进 failed[] 继续构造其余渠道)——飞书凭据没填不该顺带把 Telegram 也搞掉。
 */

const ENV_VAR = 'KHY_IM_ADAPTERS';
const FRAMEWORK_FLAG = 'KHY_IM_ADAPTER_FRAMEWORK';
const ENABLE_ALL_TOKENS = new Set(['all', '*', 'auto']);

/**
 * 内置渠道表。**只登记真正实现了的渠道**:登记一个空壳(load:null)只会把
 * 「未实现」伪装成「配置错误」,排查时更贵。新渠道到位时在这里加一行即可。
 * @type {Map<string, {displayName:string, create:function}>}
 */
const _registry = new Map();

function _defineBuiltins() {
  _registry.set('feishu', {
    displayName: '飞书网关',
    create: (opts) => require('./feishuAdapter').createFeishuAdapter(opts),
  });
}
_defineBuiltins();

/** 已构造的适配器单例(每渠道一个;宿主进程内共享同一条长连接)。 */
const _instances = new Map();

/**
 * 注册一个渠道(第三方/测试用)。同名覆盖并返回被覆盖的旧项,便于测试还原。
 * @param {string} name 渠道短名
 * @param {{displayName?:string, create:function}} entry create(opts) → adapter 实例
 * @returns {object|null} 被覆盖的旧注册项
 */
function register(name, entry) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) {
    throw new Error('adapterRegistry.register(name, entry): name 为空');
  }
  if (!entry || typeof entry.create !== 'function') {
    throw new TypeError(`adapterRegistry.register('${key}'): entry.create 必须是 (opts)=>adapter 的函数`);
  }
  const prev = _registry.get(key) || null;
  _registry.set(key, { displayName: entry.displayName || key, create: entry.create });
  return prev;
}

/** 注销一个渠道(并断开其已构造实例)。 */
function unregister(name) {
  const key = String(name || '').trim().toLowerCase();
  const inst = _instances.get(key);
  if (inst && typeof inst.disconnect === 'function') {
    Promise.resolve(inst.disconnect('unregister')).catch(() => {});
  }
  _instances.delete(key);
  return _registry.delete(key);
}

/**
 * 已注册渠道清单(名字升序,确定性)。
 * @returns {Array<{name:string, displayName:string, instantiated:boolean}>}
 */
function listRegistered() {
  return [..._registry.keys()].sort().map((name) => ({
    name,
    displayName: _registry.get(name).displayName,
    instantiated: _instances.has(name),
  }));
}

/** 主门控:默认开,仅显式 0/false/off/no 关。注册表不可用 → 保守放行(默认开)。 */
function isFrameworkEnabled(env = process.env) {
  try {
    const registry = require('../../services/flagRegistry');
    if (registry && typeof registry.isFlagEnabled === 'function') {
      return registry.isFlagEnabled(FRAMEWORK_FLAG, env || process.env);
    }
  } catch {
    /* 落下面的本地兜底 */
  }
  const raw = (env || process.env)[FRAMEWORK_FLAG];
  if (raw === undefined || raw === null) {
    return true;
  }
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

/**
 * 解析 `KHY_IM_ADAPTERS`。
 * @param {object} [env]
 * @returns {{enabled:string[], unknown:string[], raw:string, frameworkEnabled:boolean}}
 */
function parseEnabled(env = process.env) {
  const e = env || process.env;
  const raw = String(e[ENV_VAR] == null ? '' : e[ENV_VAR]).trim();
  const frameworkEnabled = isFrameworkEnabled(e);
  if (!frameworkEnabled || !raw) {
    return { enabled: [], unknown: [], raw, frameworkEnabled };
  }
  const tokens = raw
    .split(/[,;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.some((t) => ENABLE_ALL_TOKENS.has(t))) {
    return { enabled: [..._registry.keys()].sort(), unknown: [], raw, frameworkEnabled };
  }
  const enabled = [];
  const unknown = [];
  for (const t of tokens) {
    if (_registry.has(t)) {
      if (!enabled.includes(t)) {
        enabled.push(t);
      }
    } else if (!unknown.includes(t)) {
      unknown.push(t);
    }
  }
  return { enabled, unknown, raw, frameworkEnabled };
}

function _log(logger, level, message) {
  try {
    const target = logger || require('../../utils/logger');
    const fn = target[level] || target.info;
    if (typeof fn === 'function') {
      fn.call(target, message, { component: 'imAdapterRegistry' });
    }
  } catch {
    /* 日志绝不阻断注册流程 */
  }
}

/**
 * 取(或惰性构造)一个渠道的适配器单例。**只有到这里才会 require 渠道模块**。
 * @param {string} name
 * @param {object} [options] 透传给渠道构造器(env / logger / timing / …)
 * @returns {object} adapter 实例
 */
function getAdapter(name, options = {}) {
  const key = String(name || '').trim().toLowerCase();
  const entry = _registry.get(key);
  if (!entry) {
    const available = [..._registry.keys()].sort().join(', ') || '(无)';
    throw new Error(`未注册的 IM 渠道 '${key}';当前已注册:${available}`);
  }
  const cached = _instances.get(key);
  if (cached) {
    return cached;
  }
  const adapter = entry.create({ displayName: entry.displayName, ...options, channel: key });
  _instances.set(key, adapter);
  return adapter;
}

/**
 * 按 env 构造所有已启用渠道的适配器。未启用的渠道**完全不被 require**。
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {object} [options.logger]
 * @returns {{adapters:object[], enabled:string[], unknown:string[], failed:Array<{channel:string,error:string}>, frameworkEnabled:boolean}}
 */
function createAdapters(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || null;
  const { enabled, unknown, raw, frameworkEnabled } = parseEnabled(env);

  if (!frameworkEnabled) {
    _log(logger, 'info', `IM Adapter 框架已由 ${FRAMEWORK_FLAG} 关闭,本次启用 0 个渠道`);
    return { adapters: [], enabled: [], unknown: [], failed: [], frameworkEnabled };
  }
  if (unknown.length) {
    const available = [..._registry.keys()].sort().join(', ') || '(无)';
    _log(
      logger,
      'warn',
      `${ENV_VAR} 中有 ${unknown.length} 个未注册渠道:${unknown.join(', ')};当前已注册:${available}(这些名字被忽略)`
    );
  }
  if (!enabled.length) {
    _log(
      logger,
      'info',
      `${ENV_VAR}=${raw || '(未设置)'} → 本次启用 0 个 IM 渠道(未启用的渠道模块零加载)`
    );
    return { adapters: [], enabled, unknown, failed: [], frameworkEnabled };
  }

  const adapters = [];
  const failed = [];
  for (const name of enabled) {
    try {
      adapters.push(getAdapter(name, { env, logger }));
    } catch (err) {
      const message = (err && err.message) || String(err);
      failed.push({ channel: name, error: message });
      _log(logger, 'warn', `IM 渠道 ${name} 构造失败,已跳过(其余渠道继续):${message}`);
    }
  }
  _log(
    logger,
    'info',
    `IM Adapter 已启用 ${adapters.length}/${enabled.length} 个渠道:${enabled.join(', ')}` +
      `${failed.length ? `(失败 ${failed.length} 个:${failed.map((f) => f.channel).join(', ')})` : ''}`
  );
  return { adapters, enabled, unknown, failed, frameworkEnabled };
}

/**
 * 构造并连接所有已启用渠道。**单个渠道连接失败不影响其余渠道**:失败的那个会自己在
 * 后台按指数退避重连(见 baseImAdapter),这里只如实汇报首轮结果。
 * @param {object} [options] 同 createAdapters
 * @returns {Promise<{adapters:object[], connected:string[], pending:Array<{channel:string,error:string}>}>}
 */
async function connectAll(options = {}) {
  const { adapters, enabled, unknown, failed } = createAdapters(options);
  const connected = [];
  const pending = [...failed.map((f) => ({ channel: f.channel, error: f.error }))];
  await Promise.all(
    adapters.map(async (adapter) => {
      try {
        await adapter.connect();
        connected.push(adapter.channel);
      } catch (err) {
        pending.push({ channel: adapter.channel, error: (err && err.message) || String(err) });
      }
    })
  );
  return { adapters, enabled, unknown, connected: connected.sort(), pending };
}

/** 断开全部已构造实例(幂等)。 */
async function disconnectAll(reason = 'shutdown') {
  const insts = [..._instances.values()];
  _instances.clear();
  await Promise.all(
    insts.map(async (inst) => {
      try {
        if (inst && typeof inst.disconnect === 'function') {
          await inst.disconnect(reason);
        }
      } catch {
        /* 关停路径 fail-soft */
      }
    })
  );
  return insts.length;
}

/** 全部已构造实例的状态快照(给 `khy` 诊断用)。 */
function describeAll() {
  return [..._instances.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, inst]) => (typeof inst.describeState === 'function' ? inst.describeState() : { state: 'unknown' }));
}

/** 测试钩子:清掉实例与自定义注册,恢复内置表。 */
function _resetForTests() {
  _instances.clear();
  _registry.clear();
  _defineBuiltins();
}

module.exports = {
  ENV_VAR,
  FRAMEWORK_FLAG,
  register,
  unregister,
  listRegistered,
  isFrameworkEnabled,
  parseEnabled,
  getAdapter,
  createAdapters,
  connectAll,
  disconnectAll,
  describeAll,
  _resetForTests,
};
