'use strict';

/**
 * adaptiveConfig.js — 配置自调优 + FastMode 状态机
 *
 * 借鉴:
 * - Claude Code fastMode.ts: active→cooldown→active 双态 + 智能终端检测
 * - DeepSeek-TUI config.rs: 环境信号优先级 (env > config > auto-detect)
 *
 * 核心能力:
 * 1. FastMode 状态机: active ↔ cooldown (rate_limit/overloaded 触发冷却)
 * 2. 智能终端检测: TERM_PROGRAM/SSH_CLIENT/ConHost/Windows Terminal
 * 3. 环境信号优先级: env > user-config > auto-detect
 * 4. getEffectiveConfig(): 统一配置入口，合并三层优先级
 *
 * @module adaptiveConfig
 */

const os = require('os');

// ── FastMode 状态机 ──

/** @enum {string} */
const FAST_MODE_STATE = Object.freeze({
  ACTIVE: 'active',
  COOLDOWN: 'cooldown',
});

/**
 * FastMode 管理器 — rate_limit/overloaded 时自动降级。
 *
 * 在 active 状态使用高级参数 (max_tokens 加倍, temperature 降低);
 * cooldown 状态恢复保守参数，冷却期满自动恢复 active。
 */
class FastModeManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.cooldownMs=120000] - 冷却时长 (ms)
   * @param {number} [opts.maxConsecutiveErrors=3] - 连续错误达到此数触发冷却
   * @param {number} [opts.decayMs=60000] - 错误计数衰减间隔
   */
  constructor(opts = {}) {
    this._state = FAST_MODE_STATE.ACTIVE;
    this._cooldownMs = opts.cooldownMs || 120_000;
    this._maxConsecutiveErrors = opts.maxConsecutiveErrors || 3;
    this._decayMs = opts.decayMs || 60_000;
    this._consecutiveErrors = 0;
    this._lastErrorTs = 0;
    this._cooldownExpiresAt = 0;
    this._stateChangeCallbacks = [];
    this._cooldownTimer = null;
  }

  /** @returns {string} 当前状态 */
  get state() {
    // 惰性检查冷却是否过期
    if (this._state === FAST_MODE_STATE.COOLDOWN && Date.now() >= this._cooldownExpiresAt) {
      this._transitionTo(FAST_MODE_STATE.ACTIVE);
    }
    return this._state;
  }

  /** @returns {boolean} 是否处于 active 状态 */
  get isActive() { return this.state === FAST_MODE_STATE.ACTIVE; }

  /** @returns {number} 冷却剩余毫秒 (0 = 未在冷却) */
  get cooldownRemainingMs() {
    if (this._state !== FAST_MODE_STATE.COOLDOWN) return 0;
    return Math.max(0, this._cooldownExpiresAt - Date.now());
  }

  /**
   * 记录一次错误 (rate_limit / overloaded)。
   * 连续错误达到阈值时触发冷却。
   *
   * @param {string} errorType - 'rate_limit' | 'overloaded' | 其他
   * @returns {boolean} 是否触发了冷却
   */
  recordError(errorType) {
    // 只关心 rate_limit 和 overloaded
    if (errorType !== 'rate_limit' && errorType !== 'overloaded') return false;

    const now = Date.now();

    // 衰减: 距上次错误超过 decayMs → 重置计数
    if (now - this._lastErrorTs > this._decayMs) {
      this._consecutiveErrors = 0;
    }
    this._lastErrorTs = now;
    this._consecutiveErrors++;

    if (this._consecutiveErrors >= this._maxConsecutiveErrors && this._state === FAST_MODE_STATE.ACTIVE) {
      this._enterCooldown();
      return true;
    }
    return false;
  }

  /** 记录一次成功 → 重置错误计数 */
  recordSuccess() {
    this._consecutiveErrors = 0;
  }

  /** 强制进入冷却 */
  forceCooldown(durationMs) {
    this._cooldownMs = durationMs || this._cooldownMs;
    this._enterCooldown();
  }

  /** 强制恢复 active */
  forceActive() {
    this._consecutiveErrors = 0;
    this._transitionTo(FAST_MODE_STATE.ACTIVE);
  }

  /**
   * 注册状态变更回调
   * @param {function} cb - (newState, oldState) => void
   */
  onStateChange(cb) {
    this._stateChangeCallbacks.push(cb);
  }

  /** 返回诊断快照 */
  snapshot() {
    return {
      state: this.state,
      consecutiveErrors: this._consecutiveErrors,
      cooldownRemainingMs: this.cooldownRemainingMs,
      cooldownMs: this._cooldownMs,
    };
  }

  /** 关闭定时器 */
  shutdown() {
    if (this._cooldownTimer) {
      clearTimeout(this._cooldownTimer);
      this._cooldownTimer = null;
    }
  }

  /** @private */
  _enterCooldown() {
    this._cooldownExpiresAt = Date.now() + this._cooldownMs;
    this._transitionTo(FAST_MODE_STATE.COOLDOWN);

    // 安全定时器: 冷却到期自动恢复 (避免惰性检查未触发)
    if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
    this._cooldownTimer = setTimeout(() => {
      this._cooldownTimer = null;
      if (this._state === FAST_MODE_STATE.COOLDOWN) {
        this._transitionTo(FAST_MODE_STATE.ACTIVE);
      }
    }, this._cooldownMs + 100);
    if (this._cooldownTimer.unref) this._cooldownTimer.unref();
  }

  /** @private */
  _transitionTo(newState) {
    if (this._state === newState) return;
    const old = this._state;
    this._state = newState;
    for (const cb of this._stateChangeCallbacks) {
      try { cb(newState, old); } catch { /* non-fatal */ }
    }
  }
}

// ── 智能终端检测 ──

/**
 * 检测当前终端类型和能力。
 * 借鉴 Claude Code 的终端检测逻辑。
 *
 * @returns {{ name: string, supportsColor: boolean, supportsUnicode: boolean, isRemote: boolean, isTTY: boolean }}
 */
function detectTerminal() {
  const env = process.env;
  const isTTY = !!(process.stdout && process.stdout.isTTY);
  const isRemote = !!(env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION);

  // 终端名称检测
  let name = 'unknown';
  if (env.TERM_PROGRAM) {
    name = env.TERM_PROGRAM.toLowerCase();
  } else if (env.WT_SESSION) {
    name = 'windows-terminal';
  } else if (process.platform === 'win32') {
    name = env.ANSICON ? 'ansicon' : 'conhost';
  } else if (env.TERM) {
    name = env.TERM;
  }

  // 能力检测
  const supportsColor = isTTY && (
    env.FORCE_COLOR !== '0'
    && (env.FORCE_COLOR
      || env.COLORTERM === 'truecolor'
      || env.COLORTERM === '256color'
      || env.TERM_PROGRAM === 'iTerm.app'
      || env.WT_SESSION
      || /256color|truecolor|xterm|screen|tmux/i.test(env.TERM || ''))
  );

  const supportsUnicode = !isRemote && (
    process.platform !== 'win32'
    || !!env.WT_SESSION
    || /utf-?8/i.test(env.LANG || env.LC_ALL || '')
  );

  return { name, supportsColor: !!supportsColor, supportsUnicode, isRemote, isTTY };
}

// ── 环境信号优先级: env > user-config > auto-detect ──

/** @type {object} 默认配置 */
const DEFAULTS = Object.freeze({
  // Floor only — model tier, user config, and KHY_MAX_TOKENS all override this.
  // Aligned with queryEngine CAPPED_DEFAULT_MAX_TOKENS (8000) so the fallback
  // does not under-cut the recovery cap and force avoidable truncation rounds.
  maxTokens: 8192,
  temperature: 0.7,
  topP: 1.0,
  streamChunkSize: 64,
  timeoutMs: 120_000,
  fastMode: true,
  displayUnicode: null, // null = auto-detect
  displayColor: null,   // null = auto-detect
});

/**
 * 合并三层配置优先级。
 *
 * @param {object} [userConfig={}] - 用户配置 (来自 systemSettingService)
 * @param {object} [envOverrides={}] - 环境变量覆盖 (来自 process.env)
 * @returns {object} 合并后的有效配置
 */
function getEffectiveConfig(userConfig = {}, envOverrides = {}) {
  const env = process.env;
  const terminal = detectTerminal();

  // Layer 1: 默认值
  const config = { ...DEFAULTS };

  // Layer 2: 用户配置
  for (const [key, val] of Object.entries(userConfig)) {
    if (val !== undefined && val !== null) config[key] = val;
  }

  // Layer 3: 环境变量 (最高优先级)
  if (env.KHY_MAX_TOKENS) config.maxTokens = parseInt(env.KHY_MAX_TOKENS, 10) || config.maxTokens;
  if (env.KHY_TEMPERATURE) config.temperature = parseFloat(env.KHY_TEMPERATURE) || config.temperature;
  if (env.KHY_TIMEOUT_MS) config.timeoutMs = parseInt(env.KHY_TIMEOUT_MS, 10) || config.timeoutMs;
  if (env.KHY_FAST_MODE !== undefined) config.fastMode = env.KHY_FAST_MODE !== '0' && env.KHY_FAST_MODE !== 'false';
  if (env.KHY_STREAM_CHUNK_SIZE) config.streamChunkSize = parseInt(env.KHY_STREAM_CHUNK_SIZE, 10) || config.streamChunkSize;

  // 显式环境覆盖
  for (const [key, val] of Object.entries(envOverrides)) {
    if (val !== undefined && val !== null) config[key] = val;
  }

  // auto-detect 填充
  if (config.displayUnicode === null) config.displayUnicode = terminal.supportsUnicode;
  if (config.displayColor === null) config.displayColor = terminal.supportsColor;

  // 附加终端信息
  config._terminal = terminal;

  return config;
}

/**
 * 根据 FastMode 状态调整请求参数。
 *
 * active 模式: max_tokens 按配置, temperature 按配置
 * cooldown 模式: max_tokens 减半, temperature 提高 0.1 (保守降速)
 *
 * @param {object} params - 原始请求参数
 * @param {FastModeManager} fastModeManager - FastMode 管理器
 * @returns {object} 调整后的参数 (新对象)
 */
function applyFastModeAdjustments(params, fastModeManager) {
  if (!fastModeManager || fastModeManager.isActive) return params;

  // cooldown: 保守参数
  return {
    ...params,
    max_tokens: params.max_tokens ? Math.max(1024, Math.floor(params.max_tokens * 0.5)) : undefined,
    temperature: params.temperature != null ? Math.min(1.0, params.temperature + 0.1) : undefined,
    _fastModeCooldown: true,
  };
}

// ── Singleton ──

let _fastMode = null;

/** 获取全局 FastMode 管理器单例 */
function getFastModeManager() {
  if (!_fastMode) _fastMode = new FastModeManager();
  return _fastMode;
}

/** 重置 (测试用) */
function _resetForTest() {
  if (_fastMode) _fastMode.shutdown();
  _fastMode = null;
}

module.exports = {
  FAST_MODE_STATE,
  FastModeManager,
  detectTerminal,
  getEffectiveConfig,
  applyFastModeAdjustments,
  getFastModeManager,
  DEFAULTS,
  _resetForTest,
};
