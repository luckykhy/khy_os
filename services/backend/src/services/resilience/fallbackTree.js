'use strict';

/**
 * resilience/fallbackTree.js — 有限深度「降级熔断树」与 FallbackTreeBuilder。
 *
 * 一个意图（intent）绑定一棵降级树。树是一条**有序、有限**的 Plan 链：
 *
 *     Root（意图）
 *       ├── Plan A  ── 失败 → 强制降级 ──▶ Plan B（禁止重试 A）
 *       ├── Plan B  ── 失败 → 强制降级 ──▶ Plan C
 *       └── Plan C  ── 失败 ──────────────▶ 触发强制兜底协议
 *
 * 硬约束（防呆，全部在本文件强制，绝非靠调用方自觉）：
 *   ① 降级链最大深度 = MAX_FALLBACK_DEPTH = 3，硬编码。任何意图定义超过 3 个 Plan，
 *      builder 直接抛 FallbackTreeError —— 绝不静默截断（截断会让人误以为"覆盖了全部路径"）。
 *   ② 每个 Plan 的 maxRetry 恒为 MAX_RETRY_PER_PLAN = 1，不接受外部放大。
 *      "同一 Plan 同类错误禁止重试超 1 次" 是协议红线，写死在数据结构里。
 *   ③ build() 产出冻结对象（Object.freeze），下游执行器无法在运行期偷偷加层。
 *
 * 一个 Plan 的形状：
 *   {
 *     plan:  string,                       // 展示名（如 'WebBrowser'）
 *     tool:  string,                       // 实际工具注册名
 *     buildParams: (context) => object,    // 由意图上下文构造该工具入参
 *     maxRetry: 1,                         // 恒 1
 *     isSuccess?: (result) => boolean,     // 自定义成功判定（缺省 result.success===true）
 *     extractSalvage?: (result) => *,      // 从（成功或失败）结果里抠出可交差的残留数据
 *     suggestion?: string,                 // 该 Plan 失败时给用户的下一步建议
 *   }
 */

// 硬编码上限：Root → L1 → L2 → L3，即降级链最多 3 个 Plan。
const MAX_FALLBACK_DEPTH = 3;
// 每个 Plan 内的重试上限：恒 1，且只有"修复依赖/参数后"那一次才允许（见 budgetExecutor）。
const MAX_RETRY_PER_PLAN = 1;

class FallbackTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FallbackTreeError';
  }
}

class FallbackTreeBuilder {
  /**
   * @param {string} intent  意图标识（如 'fetch-web-content'）
   * @param {object} [opts]  { description }
   */
  constructor(intent, opts = {}) {
    this.intent = String(intent || '').trim() || 'unnamed-intent';
    this.description = String(opts.description || this.intent);
    this._plans = [];
  }

  /**
   * 追加一个降级 Plan。超过硬上限直接抛错（防呆①）。
   * @param {string} name  Plan 展示名
   * @param {object} spec  { tool, params|buildParams, isSuccess, extractSalvage, suggestion }
   * @returns {FallbackTreeBuilder} this（链式）
   */
  plan(name, spec = {}) {
    if (this._plans.length >= MAX_FALLBACK_DEPTH) {
      throw new FallbackTreeError(
        `降级树深度超限：意图「${this.intent}」最多 ${MAX_FALLBACK_DEPTH} 个 Plan（防呆硬上限，拒绝定义第 ${this._plans.length + 1} 个）。`,
      );
    }
    const tool = String(spec.tool || name || '').trim();
    const planName = String(name || tool || '').trim();
    if (!tool) throw new FallbackTreeError(`Plan「${planName || '(匿名)'}」缺少 tool（工具注册名）。`);
    if (!planName) throw new FallbackTreeError('Plan 缺少展示名。');

    const params = spec.params && typeof spec.params === 'object' ? spec.params : null;
    this._plans.push(Object.freeze({
      plan: planName,
      tool,
      buildParams: typeof spec.buildParams === 'function'
        ? spec.buildParams
        : () => (params ? { ...params } : {}),
      maxRetry: MAX_RETRY_PER_PLAN, // 恒 1，不读取 spec.maxRetry
      isSuccess: typeof spec.isSuccess === 'function' ? spec.isSuccess : null,
      extractSalvage: typeof spec.extractSalvage === 'function' ? spec.extractSalvage : null,
      suggestion: String(spec.suggestion || ''),
    }));
    return this;
  }

  /** 产出冻结的降级树（防呆③）。空树拒绝构建。 */
  build() {
    if (this._plans.length === 0) {
      throw new FallbackTreeError(`意图「${this.intent}」至少需要 1 个 Plan。`);
    }
    return Object.freeze({
      intent: this.intent,
      description: this.description,
      maxDepth: MAX_FALLBACK_DEPTH,
      plans: Object.freeze(this._plans.slice()),
    });
  }

  /**
   * 便捷工厂：从 Plan 数组一次性构造。任一 Plan 触犯深度上限会抛错（不静默截断）。
   * @param {string} intent
   * @param {Array<object>} plans  每项 { plan|name, tool, ... }
   * @param {object} [opts] { description }
   */
  static from(intent, plans = [], opts = {}) {
    const builder = new FallbackTreeBuilder(intent, opts);
    for (const p of (Array.isArray(plans) ? plans : [])) {
      builder.plan(p.plan || p.name, p);
    }
    return builder.build();
  }
}

module.exports = {
  FallbackTreeBuilder,
  FallbackTreeError,
  MAX_FALLBACK_DEPTH,
  MAX_RETRY_PER_PLAN,
};
