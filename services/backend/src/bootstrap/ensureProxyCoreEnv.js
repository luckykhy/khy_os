'use strict';

/**
 * ensureProxyCoreEnv() — 「装完即用」的 KHY_PROXY_CORE 自动播种(single source of truth)。
 *
 * 背景(用户诉求 2026-07-11「pip/npm 安装后环境变量自动配置」):选中 raw 协议节点
 * (vmess/vless/trojan/ss/ssr)时,前端弹「未能启用该节点 —— 代理内核出站未启用。设置环境变量
 * KHY_PROXY_CORE=1 开启后重试」。这道门(proxyCoreManager 的 opt-in 门 KHY_PROXY_CORE)默认关,
 * 要求用户手动改 shell profile —— 对小白/单机用户不可接受。
 *
 * 本模块在 khy 启动时**一次性**把 `KHY_PROXY_CORE=1` 播种进**升级安全**的用户级 overlay
 * `~/.khy/.env`(与 bootstrap/init.js:49 加载 overlay 的路径同一处;该 overlay 位于 site-packages
 * 之外,`pip install -U` / npm 升级永不覆盖 —— 配一次,以后每次升级都在)。播种后 init 的
 * `require('dotenv').config({ path: ~/.khy/.env, override:false })` 会把它读进 process.env,
 * 于是 proxyCoreManager.isEnabled 判为开,截图那道门自动过掉。
 *
 * 尊重用户显式意图(幂等 + 绝不覆盖):
 *   - 若 `KHY_PROXY_CORE` 已被用户**显式**设过(真实 shell env / 规范 .env / overlay 里任一存在,
 *     **含 `=0`**)→ 本模块什么都不做(用户关掉它就该保持关)。
 *   - 只有当三处都**没有**这个 key 时,才播种 `=1`(首次自动配置)。
 *   - 播种一次后,overlay 里就有了这行 → 下次启动读到「已显式」→ 不再重复写(幂等)。
 *
 * 门控 KHY_PROXY_CORE_AUTOSEED(default-on,仅 0/false/off/no 关):关 → ensureProxyCoreEnv 直接
 * 返回 { action:'skipped', reason:'autoseed-disabled' },不读盘不写盘 → 逐字节回退(用户想要老的
 * 「手动设 env」行为,关这个 meta 门即可)。父门控经 flagRegistry 集中判定,fail-soft 回退本地 CANON。
 *
 * 抄 bootstrap/ensureAuthSecret.js 的自播种范式(检测→读文件→写 overlay→更新 process.env),
 * 所有 IO 经 _deps 注入,测试喂 fake homedir/fs/writer 即可全离线证绿。绝不抛:任何失败 fail-soft。
 *
 * @module bootstrap/ensureProxyCoreEnv
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FLAG = 'KHY_PROXY_CORE';
const META_FLAG = 'KHY_PROXY_CORE_AUTOSEED';
const _AUTOSEED_OFF = new Set(['0', 'false', 'off', 'no']);

// 可注入依赖(测试喂 fake;生产用真实模块)。
const _deps = {
  fs,
  homedir: () => os.homedir(),
  // 写 overlay 的单一真源:复用 gatewayEnvFile.writeEnvMap(patchEnvContent 幂等合并 + 更新
  // process.env)。测试可覆盖为 fake,避免真写盘。
  writeEnvMap: (envMap, options) => require('../services/gatewayEnvFile').writeEnvMap(envMap, options),
};

/** 测试注入钩子:浅合并覆盖依赖,返回还原函数。 */
function _setDeps(overrides = {}) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = _deps[k];
    _deps[k] = overrides[k];
  }
  return function restore() {
    for (const k of Object.keys(prev)) _deps[k] = prev[k];
  };
}

/**
 * meta 门是否开。优先走 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isAutoseedEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled(META_FLAG, e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e[META_FLAG];
  return !(v !== undefined && _AUTOSEED_OFF.has(String(v).trim().toLowerCase()));
}

/** ~/.khy/.env overlay 的绝对路径(与 init.js:58 同一处)。 */
function _overlayPath() {
  return path.join(_deps.homedir(), '.khy', '.env');
}

/**
 * 某文件里是否**显式**含 `KHY_PROXY_CORE=` 行(任意值,含空值)。读不到/无此行 → false。
 * @param {string} file
 * @returns {boolean}
 */
function _fileHasFlag(file) {
  let content;
  try {
    content = _deps.fs.readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  // 行首(容忍前导空白)出现 `KHY_PROXY_CORE=` 即视为显式设置(不看值,=0 也算显式)。
  return new RegExp(`^\\s*${FLAG}\\s*=`, 'm').test(String(content || ''));
}

/**
 * 确保 KHY_PROXY_CORE 在升级安全的 overlay 里被自动播种(仅当用户从未显式设过)。
 *
 * @param {{ log?: (msg:string)=>void, env?: object, canonicalEnvPath?: string }} [opts]
 *   - log: 单次播种事件的透明回调(可选)。
 *   - env: 注入 env(测试用),默认 process.env。
 *   - canonicalEnvPath: 规范 .env 路径(测试用);默认取 process.env.KHY_ENV_FILE(有则查它)。
 * @returns {{ action:'seeded'|'skipped', reason:string, path?:string }}
 */
function ensureProxyCoreEnv(opts = {}) {
  const emit = typeof opts.log === 'function' ? opts.log : () => {};
  const env = opts.env || process.env || {};

  // 0) meta 门关 → 逐字节回退(不读盘不写盘)。
  if (!isAutoseedEnabled(env)) {
    return { action: 'skipped', reason: 'autoseed-disabled' };
  }

  try {
    // 1) 真实 shell env 里已显式设过(含 =0)→ 尊重用户,不动。
    if (env[FLAG] !== undefined && String(env[FLAG]).trim() !== '') {
      return { action: 'skipped', reason: 'explicit-in-process-env' };
    }

    // 2) 规范 .env(KHY_ENV_FILE 或 backend/.env)里已显式设过 → 尊重,不动。
    const canonical = opts.canonicalEnvPath
      || (env.KHY_ENV_FILE ? String(env.KHY_ENV_FILE) : '');
    if (canonical && _fileHasFlag(canonical)) {
      return { action: 'skipped', reason: 'explicit-in-canonical-env' };
    }

    // 3) overlay 里已显式设过(上一次已播种,或用户手写)→ 幂等,不重复写。
    const overlayPath = _overlayPath();
    if (_fileHasFlag(overlayPath)) {
      return { action: 'skipped', reason: 'already-seeded' };
    }

    // 4) 三处都没有 → 首次自动播种到升级安全的 overlay。
    _deps.writeEnvMap({ [FLAG]: '1' }, { envPath: overlayPath });
    // writeEnvMap 已顺带 process.env[FLAG]='1',但注入 env 未必是 process.env,补设保证本进程即时生效。
    try { if (env && typeof env === 'object') env[FLAG] = '1'; } catch { /* ignore */ }
    emit(`已自动开启代理内核出站(${FLAG}=1)并写入 ${overlayPath}(升级安全,pip/npm 升级不覆盖;`
      + `如需关闭,设 ${FLAG}=0 或 ${META_FLAG}=0)`);
    return { action: 'seeded', reason: 'first-time', path: overlayPath };
  } catch (err) {
    // fail-soft:播种失败绝不阻断启动(只读 fs 等);用户仍可手动设 env。
    emit(`代理内核出站自动配置失败(${err && err.message});可手动设 ${FLAG}=1`);
    return { action: 'skipped', reason: 'error' };
  }
}

module.exports = {
  ensureProxyCoreEnv,
  isAutoseedEnabled,
  FLAG,
  META_FLAG,
  _overlayPath,
  _fileHasFlag,
  _setDeps,
};
