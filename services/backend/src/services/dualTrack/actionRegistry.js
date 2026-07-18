'use strict';

/**
 * actionRegistry.js — 双轨动作注册表（任务三 · 合并策略 + 红线5 不污染核心）。
 *
 * 两条物理隔离的注册轨：
 *   - 官方核心轨（`_core`）：官方内置动作处理器。assemble 阶段注册后 **seal（密封）**，
 *     之后任何 registerCore 抛错；用户/模型 **绝不允许** 改写或删除其中任何条目。
 *   - 用户扩展轨（`_overrides`）：用户/模型 DIY 注册的覆写与新增动作执行器。注册覆写
 *     **只在影子层登记，绝不触碰 `_core`**（红线5：只能通过 Override 覆盖，不污染核心源）。
 *
 * 解析优先级：用户覆写 > 官方核心 > **默认分支兜底**（未知动作返回 isKnown=false，
 * 绝不抛错、绝不返回 undefined，由状态机据此转人工确认；红线3 假设终态防呆）。
 */

class CorePollutionError extends Error {
  constructor(message) { super(message); this.name = 'CorePollutionError'; this.code = 'CORE_POLLUTION'; }
}

class ActionRegistry {
  constructor() {
    this._core = new Map();        // 官方核心轨：type -> handler（密封后只读）
    this._overrides = new Map();   // 用户扩展轨：type -> { handler, source }
    this._sealed = false;
  }

  /**
   * 注册官方核心动作。仅 assemble 阶段、密封前可调。
   * 重复注册或密封后注册一律抛错——核心轨不可被悄悄改写。
   */
  registerCore(type, handler) {
    if (this._sealed) {
      throw new CorePollutionError(`核心轨已密封，严禁再注册/改写核心动作: ${type}`);
    }
    if (typeof type !== 'string' || !type) throw new Error('registerCore: type 必须为非空字符串');
    if (typeof handler !== 'function') throw new Error('registerCore: handler 必须为函数');
    if (this._core.has(type)) {
      throw new CorePollutionError(`核心动作重复注册: ${type}`);
    }
    this._core.set(type, handler);
    return this;
  }

  /** 密封核心轨。此后核心不可变；用户扩展轨开始装载。 */
  seal() { this._sealed = true; return this; }

  isSealed() { return this._sealed; }

  /**
   * 用户扩展轨注册覆写 / 新增执行器。
   * 红线5：只写影子层 `_overrides`，**绝不**修改或删除 `_core` 中的任何条目。
   * 允许覆盖官方默认（同名 type），但官方核心条目原样保留。
   */
  registerOverride(type, handler, opts = {}) {
    if (typeof type !== 'string' || !type) throw new Error('registerOverride: type 必须为非空字符串');
    if (typeof handler !== 'function') throw new Error('registerOverride: handler 必须为函数');
    this._overrides.set(type, { handler, source: opts.source || 'user_track' });
    return this;
  }

  /**
   * 解析一个动作类型。带默认分支兜底（红线3）：未知 → isKnown=false，永不抛错。
   * @returns {{ type, handler:(Function|null), origin:'override'|'core'|'unknown', isKnown:boolean, source:(string|null) }}
   */
  resolve(type) {
    if (this._overrides.has(type)) {
      const e = this._overrides.get(type);
      return { type, handler: e.handler, origin: 'override', isKnown: true, source: e.source };
    }
    if (this._core.has(type)) {
      return { type, handler: this._core.get(type), origin: 'core', isKnown: true, source: 'official_core' };
    }
    // 默认分支兜底：绝不假设 AI 能力边界，未知类型有定义良好的返回。
    return { type, handler: null, origin: 'unknown', isKnown: false, source: null };
  }

  has(type) { return this._overrides.has(type) || this._core.has(type); }

  /** 核心轨快照（冻结）——用于实证覆写后核心未被污染（红线5）。 */
  coreSnapshot() { return Object.freeze(Array.from(this._core.keys()).sort()); }

  /** 覆写轨清单——用于可观测性。 */
  overrideList() {
    return Array.from(this._overrides.entries()).map(([type, e]) => ({ type, source: e.source }));
  }

  /**
   * 断言核心轨与给定快照一致（键集合不变）。任何漂移即核心污染。
   */
  assertCoreIntact(snapshot) {
    const now = this.coreSnapshot();
    const ok = Array.isArray(snapshot) && now.length === snapshot.length
      && now.every((k, i) => k === snapshot[i]);
    if (!ok) throw new CorePollutionError('核心轨键集合发生漂移，疑似核心污染');
    return true;
  }
}

module.exports = { ActionRegistry, CorePollutionError };
