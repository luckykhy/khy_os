'use strict';

/**
 * dualTrack/index.js — DualTrackRuntime（任务三 · 双轨热插拔运行时门面 · DESIGN-ARCH-033）。
 *
 * 把「模型自适应 + 双轨热插拔」收敛为一个调度器可调用的编排面，**不侵入**核心工具循环：
 *
 *   1. assemble()           —— 官方核心轨为基座：注册内置动作 → 密封核心 → 扫描装载用户
 *                              扩展轨（合并策略：运行时拼装，用户覆写 > 官方默认 > 默认兜底）。
 *   2. parse(raw)           —— 宽松解析模型响应（红线1/2/3：未知字段捕获、永不抛错）。
 *   3. resolveAction(action)—— 注册表解析 + 安全降级状态机（未知 → 占位符 + 人工确认）。
 *   4. dispatch(action,exec)—— 按状态执行：PROCEED 跑 handler；MANUAL_CONFIRM 交还控制权、
 *                              返回占位符，**绝不**自主执行、**绝不**静默丢弃。
 *   5. authorizedModelWrite —— 模型 DIY 经授权写入用户扩展轨（沙箱边界）。
 *   6. planUpdate / applyUpdate / checkBreaking —— 官方更新防破坏协议（红线4）。
 *   7. coreIntact()         —— 实证覆写后官方核心轨未被污染（红线5）。
 *
 * 全副作用注入（fs / requireImpl / path / logger），每会话构造一个实例。
 */

const nodePath = require('path');
const { ActionRegistry } = require('./actionRegistry');
const { parseModelResponse } = require('./lenientResponseParser');
const { decideFlow, STATES } = require('./degradeStateMachine');
const { loadUserTrack, USER_TRACK_PROTECTED_NAMES } = require('./extensionLoader');
const { writeUserExtension } = require('./extensionWriter');
const { planOfficialUpdate, detectBreakingChange, applyOfficialUpdate } = require('./updateGuard');
const { CORE_ACTIONS, CORE_ENTRY_POINTS } = require('./core/coreActions');

class DualTrackRuntime {
  /**
   * @param {{
   *   coreRoot?:string, userTrackRoot?:string,
   *   coreActions?:Object, logger?:Object,
   *   fs?:Object, requireImpl?:Function, pathImpl?:Object
   * }} opts
   */
  constructor(opts = {}) {
    this.pathImpl = opts.pathImpl || nodePath;
    // 官方核心轨 = 本子系统目录（受保护源码）；用户扩展轨默认仓库根 user_patch/。
    this.coreRoot = opts.coreRoot || __dirname;
    this.userTrackRoot = opts.userTrackRoot
      || this.pathImpl.resolve(__dirname, '../../../../../user_patch');
    this.coreActions = opts.coreActions || CORE_ACTIONS;
    this.entryPoints = CORE_ENTRY_POINTS;
    this.logger = opts.logger;
    this.fs = opts.fs || require('fs');
    this.requireImpl = opts.requireImpl || require;

    this.registry = new ActionRegistry();
    this._coreSnapshot = null;
    this.loadReport = null;
    this.assembled = false;
  }

  /** 运行时拼装：官方核心为基座，再叠加用户扩展轨。 */
  assemble() {
    for (const [type, handler] of Object.entries(this.coreActions)) {
      this.registry.registerCore(type, handler);
    }
    this.registry.seal();                       // 核心密封：此后不可改写官方核心
    this._coreSnapshot = this.registry.coreSnapshot();
    this.loadReport = loadUserTrack({
      userTrackRoot: this.userTrackRoot,
      registry: this.registry,
      fs: this.fs,
      requireImpl: this.requireImpl,
      pathImpl: this.pathImpl,
      logger: this.logger,
    });
    this.assembled = true;
    return this;
  }

  /** 宽松解析模型响应（红线1/2/3）。 */
  parse(raw) {
    return parseModelResponse(raw, { logger: this.logger });
  }

  /** 解析单个动作 → {resolution, flow}。flow 即降级状态机决策。 */
  resolveAction(action) {
    const resolution = this.registry.resolve(action && action.type);
    const flow = decideFlow(resolution, action);
    return { resolution, flow };
  }

  /**
   * 派发一个动作。PROCEED → 执行 handler（或注入的 executor）；MANUAL_CONFIRM → 返回占位符
   * 并交还控制权，绝不自主执行、绝不静默丢弃。永不抛错（红线3）。
   *
   * @param {Object} action
   * @param {{executor?:Function, ctx?:Object}} run
   */
  dispatch(action, run = {}) {
    const { flow } = this.resolveAction(action);
    if (flow.state === STATES.PROCEED) {
      try {
        const exec = run.executor || flow.handler;
        const result = exec(action, run.ctx);
        return { state: flow.state, control: 'auto', ok: true, result, origin: flow.origin };
      } catch (e) {
        // 执行器抛错也不崩运行时：转人工确认兜底（红线3）。
        return {
          state: STATES.MANUAL_CONFIRM,
          control: 'human',
          ok: false,
          error: { message: e.message, code: e.code || 'EXECUTOR_ERROR' },
          placeholder: decideFlow(null, action).placeholder,
        };
      }
    }
    // MANUAL_CONFIRM
    return {
      state: flow.state,
      control: 'human',
      ok: false,
      placeholder: flow.placeholder,
      message: flow.message,
    };
  }

  /** 模型 DIY：经授权写入用户扩展轨（沙箱边界，红线5）。 */
  authorizedModelWrite({ relPath, content, authorized }) {
    return writeUserExtension({
      userTrackRoot: this.userTrackRoot,
      relPath, content, authorized,
      fs: this.fs, pathImpl: this.pathImpl,
    });
  }

  /** 规划官方更新（红线4 fail-closed）。 */
  planUpdate(incomingFiles) {
    return planOfficialUpdate({
      coreRoot: this.coreRoot,
      protectedRoots: [this.userTrackRoot],
      incomingFiles,
      pathImpl: this.pathImpl,
    });
  }

  /** 施工官方更新（仅安全时落核心轨）。 */
  applyUpdate(plan) {
    return applyOfficialUpdate({ plan, fs: this.fs, pathImpl: this.pathImpl });
  }

  /** 兼容性契约检查：新核心是否移除用户轨依赖的接入点（红线4 严禁静默作废）。 */
  checkBreaking(newEntryPoints) {
    return detectBreakingChange({ oldEntryPoints: this.entryPoints, newEntryPoints });
  }

  /** 实证官方核心轨自覆写以来未被污染（红线5）。 */
  coreIntact() {
    try { return this.registry.assertCoreIntact(this._coreSnapshot); }
    catch (_) { return false; }
  }
}

module.exports = {
  DualTrackRuntime,
  STATES,
  USER_TRACK_PROTECTED_NAMES,
  // 直通子模块，便于精细复用与测试。
  parseModelResponse,
  decideFlow,
};
