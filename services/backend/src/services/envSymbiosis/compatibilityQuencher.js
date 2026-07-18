'use strict';

/**
 * compatibilityQuencher.js — 兼容性即特长淬火器（§3.4 + 防呆②⑤）。
 *
 * 本架构对「兼容性阻断」的态度是颠覆性的：它不是要修补回统一抽象层的 Bug，而是一块**进化
 * 原石**。当某环境缺少某意图的原生器官（器官空洞），或某原生特长翻车需要回滚，淬火器把这份
 * 「该环境的不适」强制升维成一条带 `env_scope` 的 `EvoRequirement`——要求为**该特定环境**单独
 * 长出/收回器官，绝不污染全局架构（防呆②）。
 *
 * 两条淬火路径：
 *   quenchOrganVoid  器官空洞 → 「器官新生需求」：为该环境新增原生工具（绝不 Polyfill）。
 *   quenchRollback   特长翻车 → 「特长回滚需求」：熔断该特长 + 新增该环境安全兜底。
 *
 * 复用 evoEngine 的需求真源 `evoRequirement.forge`（零侵入，不改其定形）；env_scope 由本器
 * 在铸造后装饰——这是把「环境特异性」钉死在需求上、阻止其外溢为全局变更的关键一笔。
 * why 措辞经校准锁 `evoLevels.classify` 落 L1（器官新生级），绝不触发 L2 核心流转关键字。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const { PLATFORM, topologyFor, isPlatform } = require('./platformIds');

/** 淬火种类。 */
const QUENCH_KIND = Object.freeze({
  ORGAN_NEWBORN: 'organ-newborn',     // 器官新生（器官空洞淬火）
  SPECIALTY_ROLLBACK: 'specialty-rollback', // 特长回滚（熔断淬火）
});

class CompatibilityQuencher {
  /**
   * 器官空洞淬火：把「该环境缺某意图原生器官」升维为器官新生需求。
   * @param {{intent:string, specialty:string, reason?:string}} block  路由器 organ-void 结果
   * @param {{platform:string}} fingerprint  已识别指纹（防呆③ 已在上游保证）
   * @returns {object} { status, kind, env_scope, specialty, requirement, action, priority }
   */
  quenchOrganVoid(block, fingerprint) {
    const env = this._envScope(fingerprint);   // 防呆②：无 env_scope 即拒绝铸造，绝不外溢全局
    const intent = String((block && block.intent) || 'unknown-intent');
    const specialty = String((block && block.specialty) || `${intent}@${env}`);
    const directions = topologyFor(env);
    const organHint = directions.length ? `（参考该环境长板：${directions.slice(0, 3).join('、')}）` : '';

    const requirement = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.TOOL_FAILURE,
      painPoint: `${env} 缺少意图「${intent}」的原生器官${organHint}`,
      attribution: {
        kind: 'compatibility-block',
        // L1 锚点：含「拓扑空洞 / 新原生工具」，规避 classify 的 L2 触发词（网关/调度/压缩/核心流转）。
        why: `${env} 环境能力拓扑空洞——意图「${intent}」无原生器官，须为该环境长出新原生工具，绝不以跨平台 Polyfill 抹平。`,
        surface: specialty,
      },
      impact: `仅 ${env} 受影响：该环境无法以原生方式满足「${intent}」，沦为二等公民。`,
      proposedModules: this._organModules(env, intent),
      acceptanceCriteria: [
        `为 ${env} 新增「${intent}」原生器官并注册至该环境亲和路由表`,
        `新器官仅作用于 env_scope=${env}，不改动其它环境与全局架构`,
      ],
    });

    return this._decorate({
      status: 'quenched', kind: QUENCH_KIND.ORGAN_NEWBORN, env_scope: env, specialty,
      requirement, action: `为 ${env} 新生「${intent}」原生器官`, priority: 'High', rollback: false,
    });
  }

  /**
   * 特长回滚淬火（防呆⑤）：某原生特长引发安全降级/崩溃，升维为回滚需求。
   * @param {{specialty:string, cause:string, detail?:any}} fault  熔断信息（来自 SpecialtyBreaker.fuse）
   * @param {{platform:string}} fingerprint
   * @returns {object} 同 quenchOrganVoid，含 rollback:true
   */
  quenchRollback(fault, fingerprint) {
    const env = this._envScope(fingerprint);
    const specialty = String((fault && fault.specialty) || `unknown@${env}`);
    const cause = String((fault && fault.cause) || 'crash');

    const requirement = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `${env} 原生特长 ${specialty} 触发${cause === 'security-degrade' ? '安全降级' : '系统崩溃'}，已熔断`,
      attribution: {
        kind: 'specialty-fault',
        why: `${env} 原生特长 ${specialty} 引发${cause}——能力拓扑空洞，须熔断回滚并新增该环境安全兜底原生工具。`,
        surface: specialty,
      },
      impact: `仅 ${env} 受影响：该特长已熔断、降级为通用安全方案，需补该环境安全兜底器官。`,
      proposedModules: [`${env}-${specialty}-安全兜底器官`, `${env}-特长健康探针`],
      acceptanceCriteria: [
        `${specialty} 在 ${env} 经验证安全前保持熔断`,
        `提供 ${env} 通用安全降级路径，回滚需求仅作用于 env_scope=${env}`,
      ],
    });

    return this._decorate({
      status: 'quenched', kind: QUENCH_KIND.SPECIALTY_ROLLBACK, env_scope: env, specialty,
      requirement, action: `熔断并回滚 ${env} 特长 ${specialty}，补安全兜底`, priority: 'High', rollback: true,
    });
  }

  /** env_scope 唯一来源：必须是已识别平台，否则拒绝铸造（防呆②③：无指纹不臆造环境需求）。 */
  _envScope(fingerprint) {
    const env = fingerprint && fingerprint.platform;
    if (!isPlatform(env)) {
      throw new Error('CompatibilityQuencher: 缺少已识别的 env_scope，拒绝铸造环境特异性需求（防呆②③）');
    }
    return env;
  }

  /** 拟新增器官清单：环境长板方向 + 意图专属器官命名。 */
  _organModules(env, intent) {
    const dirs = topologyFor(env).slice(0, 2);
    return [`${env}-${intent}-原生器官`, ...dirs.map((d) => `${env}:${d}`)];
  }

  /** 防呆②硬保证：每条淬火需求必带 env_scope，并把环境标记钉进 requirement 本体。 */
  _decorate(out) {
    if (!isPlatform(out.env_scope)) {
      throw new Error('CompatibilityQuencher: 淬火产出缺 env_scope（防呆②）');
    }
    out.requirement.env_scope = out.env_scope;
    out.requirement.specialty = out.specialty;
    out.requirement.envSpecific = true;
    if (out.rollback) out.requirement.rollback = true;
    return out;
  }
}

module.exports = { CompatibilityQuencher, QUENCH_KIND, PLATFORM };
