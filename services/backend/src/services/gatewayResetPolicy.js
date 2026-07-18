'use strict';

/**
 * gatewayResetPolicy.js — 纯叶子:网关配置「是否需要重置 + 出厂默认值」的单一真源。
 *
 * 背景(真缺口):khy 更新后或用户手动改坏网关配置(.env 里的 GATEWAY_PREFERRED_ADAPTER/
 * RELAY_API_ENDPOINT 等)时,没有统一的「判断是否需要重置」决策逻辑,也没有明确的
 * 出厂默认值定义。`config.js` 有 `_readCurrentModelConfig` 读取配置,但从不判断
 * 配置是否损坏/应否重置。本叶子把重置判定与出厂默认值收成单一真源:
 *   - shouldResetGateway(opts)  —— 判断是否需要重置(配置损坏/必需字段缺失/adapter 非法);
 *   - getFactoryDefaults()      —— 出厂默认网关配置;
 *   - isEnabled()               —— 门控:KHY_GATEWAY_RESET 默认开。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控,绝不碰 fs/网络/子进程/git/流;
 *   envMap 由壳注入)、确定性、绝不抛(fail-soft,任何坏输入返回安全空值)、
 *   env 门控 `KHY_GATEWAY_RESET` 默认开。门控关 → shouldResetGateway 返回
 *   {shouldReset: false, reason: ''}(让薄壳字节回退到「不重置」)。
 *
 * 全局门控惯例:khy 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_GATEWAY_RESET 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_GATEWAY_RESET;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStrSafe;

// 合法的 adapter 值(复用 config.js 的 PROVIDER_TO_ADAPTER 映射)
const VALID_ADAPTERS = Object.freeze([
  'relay_api',
  'auto',
  'ollama',
  'localllm',
  'claude',
  'codex',
  'kiro',
  'cursor',
  'trae',
  'windsurf',
  'api',
  'relay',
]);

/**
 * 出厂默认网关配置。
 * @returns {object}
 */
function getFactoryDefaults() {
  return {
    GATEWAY_PREFERRED_ADAPTER: 'relay_api',
    RELAY_API_ENDPOINT: '',
    RELAY_API_KEY: '',
    RELAY_API_MODEL: '',
    RELAY_API_COMPATIBILITY: 'openai',
  };
}

/**
 * 判断是否需要重置网关配置。
 *
 * @param {object} opts
 * @param {object} [opts.envMap] - 环境变量映射(键值对)
 * @param {boolean} [opts.configCorrupted] - 配置文件是否已损坏
 * @param {number} [opts.version] - 配置版本(预留,当前未使用)
 * @param {object} [opts.env] - 环境变量(用于门控)
 * @returns {{shouldReset: boolean, reason: string}}
 *
 * 触发条件:
 *   - config-corrupted: 配置文件已损坏
 *   - required-fields-missing: 必需字段缺失(GATEWAY_PREFERRED_ADAPTER 或 relay 三件套全空)
 *   - invalid-adapter: adapter 值非法(不在 VALID_ADAPTERS 中)
 *
 * fail-soft:坏输入/门控关 → {shouldReset: false, reason: ''}
 */
function shouldResetGateway(opts = {}) {
  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return { shouldReset: false, reason: '' };

    // 坏输入:envMap 缺失或非对象 → fail-soft 返回不重置
    if (!opts || typeof opts !== 'object' || !opts.envMap) {
      return { shouldReset: false, reason: '' };
    }

    const envMap = opts.envMap;
    if (typeof envMap !== 'object' || Array.isArray(envMap)) {
      return { shouldReset: false, reason: '' };
    }

    const configCorrupted = !!(opts && opts.configCorrupted);

    // 条件1:配置文件已损坏
    if (configCorrupted) {
      return {
        shouldReset: true,
        reason: 'config-corrupted',
      };
    }

    // 提取关键字段
    const adapter = _str(envMap.GATEWAY_PREFERRED_ADAPTER).trim().toLowerCase();
    const relayEndpoint = _str(envMap.RELAY_API_ENDPOINT).trim();
    const relayApiKey = _str(envMap.RELAY_API_KEY).trim();
    const relayModel = _str(envMap.RELAY_API_MODEL).trim();

    // 条件2:adapter 非法
    if (adapter && !VALID_ADAPTERS.includes(adapter)) {
      return {
        shouldReset: true,
        reason: 'invalid-adapter',
      };
    }

    // 条件3:必需字段缺失
    // - 如果 adapter 为空,且 relay 三件套也全空,则视为未配置
    if (!adapter && !relayEndpoint && !relayApiKey && !relayModel) {
      return {
        shouldReset: true,
        reason: 'required-fields-missing',
      };
    }

    // 配置正常
    return {
      shouldReset: false,
      reason: '',
    };
  } catch {
    return { shouldReset: false, reason: '' };
  }
}

module.exports = {
  isEnabled,
  getFactoryDefaults,
  shouldResetGateway,
  VALID_ADAPTERS,
};
