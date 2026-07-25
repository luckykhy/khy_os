'use strict';

/**
 * resilience/salvage.js — SalvageProtector：穷尽有限路径后的「强制兜底协议」。
 *
 * 当降级树遍历完毕仍失败、或预算用尽提前熔断时，绝不允许只丢一句"失败"给用户。
 * 必须交差一份结构化的最终交代：尝试了哪些路径、各自为何失败、抢救到了什么残料、
 * 以及人类下一步能做什么。
 *
 *   {
 *     "status": "failed_with_salvage",
 *     "intent": "原目标简述",
 *     "attempted_paths": [ { "plan": "...", "reason": "...", "retry": 0|1 }, ... ],
 *     "salvage_data": "抢救到的片段（可能为空字符串，但字段必在）",
 *     "next_action_suggestion": "可执行的下一步建议"
 *   }
 *
 * 防呆：attempted_paths 必非空（即便预算从一开始就见底，也要登记"本应尝试但被熔断"的那一步）；
 *       salvage_data 与 next_action_suggestion 字段恒在，绝不退化成只有 status。
 */

class SalvageProtector {
  /**
   * 组装强制兜底 JSON。
   * @param {object} args
   * @param {string}  args.intent
   * @param {string}  [args.description]
   * @param {Array}   args.attempted        [{ plan, reason, retry }]
   * @param {Array}   [args.salvageData]    各 Plan 抠出的残留数据片段
   * @param {object}  [args.lastFailure]    classifyFailure() 的结果
   * @param {string}  [args.circuit]        熔断原因：budget-floor | budget-insufficient | tree-exhausted | executor-error
   * @returns {object} 兜底 JSON
   */
  static assemble(args = {}) {
    const {
      intent, description, attempted = [], salvageData = [],
      lastFailure = null, circuit = 'tree-exhausted',
    } = args;

    const paths = (Array.isArray(attempted) ? attempted : [])
      .map((a) => ({
        plan: String(a.plan || '(unknown)'),
        reason: String(a.reason || 'unknown'),
        retry: Number(a.retry) || 0,
      }));

    // 防呆：兜底必须交差 —— attempted_paths 不得为空。
    if (paths.length === 0) {
      paths.push({ plan: '(none)', reason: `aborted:${circuit}`, retry: 0 });
    }

    return {
      status: 'failed_with_salvage',
      intent: String(description || intent || '(未命名意图)'),
      attempted_paths: paths,
      salvage_data: SalvageProtector._bestSalvage(salvageData),
      next_action_suggestion: SalvageProtector._suggest(lastFailure, paths, circuit),
    };
  }

  /** 从所有残料里挑出"最有价值"的一份（最长的非空文本；对象则原样保留）。 */
  static _bestSalvage(salvageData) {
    const items = (Array.isArray(salvageData) ? salvageData : [])
      .filter((x) => x !== null && x !== undefined && x !== '');
    if (items.length === 0) return '';
    // 文本型：取最长非空串。
    const texts = items.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
    if (texts.length > 0) {
      return texts.reduce((a, b) => (b.length > a.length ? b : a));
    }
    // 非文本（数组/对象）：返回首个非空，避免丢信息。
    return items[0];
  }

  /** 依据最后一类失败 + 熔断原因，给出可执行的下一步建议。 */
  static _suggest(lastFailure, paths, circuit) {
    if (circuit === 'budget-floor' || circuit === 'budget-insufficient') {
      return '预算（Token/步数）已不足以安全开启新的降级路径，已提前兜底。请缩小目标范围、分批执行，或提高预算上限后重试。';
    }
    if (circuit === 'executor-error') {
      return '降级执行器自身遇到异常并已 fail-safe 兜底，请检查运行环境后重试；本次已附上已尝试路径供排查。';
    }
    const reason = lastFailure && lastFailure.reason ? lastFailure.reason : '';
    const dep = lastFailure && lastFailure.missingDependency;
    if (reason === 'missing-dependency') {
      return dep
        ? `手动安装依赖 ${dep}（如 npm i ${dep} / pip install ${dep}），或改用不依赖它的来源后重试。`
        : '手动安装缺失的依赖后重试，或改用不依赖它的路径。';
    }
    if (/^http-4(0[13]|29)$/.test(reason) || reason === 'permission') {
      return '目标拒绝访问（鉴权/限频/防爬）。请提供网页账号或 Cookie、放慢请求频率，或更换可公开访问的来源。';
    }
    if (/^http-5\d\d$/.test(reason)) {
      return '目标服务端错误（5xx）。请稍后重试，或更换镜像/来源。';
    }
    if (reason === 'timeout') {
      return '所有路径均超时。请检查网络连通性、提高超时阈值，或更换更轻量的获取方式。';
    }
    if (reason === 'network') {
      return '网络不可达。请检查连通性/代理设置后重试，或改用离线来源。';
    }
    if (reason === 'not-found') {
      return '目标资源不存在。请核对 URL/路径/标识是否正确。';
    }
    // 末路兜底建议也绝不空着。
    const last = paths[paths.length - 1];
    return `已穷尽 ${paths.length} 条降级路径（最后失败于 ${last ? last.plan : '未知'}：${reason || '未知原因'}）。请人工核查上述尝试记录，提供更多上下文或更换策略后重试。`;
  }
}

module.exports = { SalvageProtector };
