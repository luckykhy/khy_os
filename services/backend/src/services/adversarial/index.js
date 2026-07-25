'use strict';

/**
 * adversarial/index.js — 对抗式训练门面 AdversarialTrainer（DESIGN-ARCH-055）。
 *
 * Khyos 已有完整的「防御 + 从失败中学习」生态（resilience / selfHeal / failsafe / evoEngine /
 * dualTrackForge / structuredFurnace），却缺一支**主动红队**：所有 friction 都是被动的，只有线上
 * 真实失败才留痕。本子系统补上这个缺口——在防御从未见过的极端/敌对条件下系统性施压，逼出
 * 抗压短板，并把破防收口进既有进化生态。一条战役四步闭环：
 *
 *   武器库(attackVectors) → 施压器(stressHarness) → 评分器(survivalCriteria) → 加固回路(hardeningLoop)
 *   ───「打什么」────────────  ───「怎么打」──────────  ───「算不算活」──────────  ───「沉淀成需求」───
 *
 * 设计立场（与被测子系统同源）：
 *   - 零侵入：只驱动各防御子系统的**公开契约**，不对任何热路径动刀。开关全在本门面。
 *   - 永不抛：单条向量翻车被规约成一条破防记录，绝不拖垮整场战役。
 *   - 非破坏默认：harden（写 evoLedger）默认关闭——纯评测不污染进化需求池；显式开启才沉淀。
 *   - 确定性可复现：向量 build() 无随机无时钟，同一战役多次运行结论一致。
 */

const attackVectors = require('./attackVectors');
const survivalCriteria = require('./survivalCriteria');
const stressHarness = require('./stressHarness');
const hardeningLoop = require('./hardeningLoop');

class AdversarialTrainer {
  /**
   * @param {object} [opts]
   * @param {object[]} [opts.vectors]  自定义向量集（默认全量 attackVectors.VECTORS）
   * @param {object}   [opts.bridge]   注入 frictionBridge（测试可注 mock）
   * @param {object}   [opts.forge]    注入 DualTrackForge 实例（启用双轨二次沉淀）
   */
  constructor(opts = {}) {
    this.vectors = Array.isArray(opts.vectors) && opts.vectors.length
      ? opts.vectors.slice()
      : attackVectors.listVectors();
    this.bridge = opts.bridge || null;
    this.forge = opts.forge || null;
  }

  /**
   * 跑一场对抗战役。
   * @param {object} [campaign]
   * @param {string}   [campaign.target]   只打某个子系统（attackVectors.TARGET.*）
   * @param {string}   [campaign.family]   只打某个攻击族（attackVectors.FAMILY.*）
   * @param {string[]} [campaign.vectorIds]只打指定向量
   * @param {boolean}  [campaign.harden=false] 是否把破防沉淀进 evoLedger（默认否，非破坏）
   * @returns {Promise<{results:Array, summary:object, hardened:Array, breaches:Array}>}
   */
  async runCampaign(campaign = {}) {
    const selected = this._select(campaign);
    const results = [];
    const observations = [];
    const hardened = [];
    const breaches = [];

    for (const vector of selected) {
      const observation = await stressHarness.stress(vector);
      const evaluation = survivalCriteria.evaluate(observation);
      observations.push(observation);
      results.push(evaluation);

      if (!evaluation.survived) {
        for (const b of evaluation.breaches) {
          breaches.push({ vectorId: evaluation.vectorId, target: evaluation.target, invariant: b.invariant, detail: b.detail });
        }
        if (campaign.harden) {
          const sank = await hardeningLoop.harden(evaluation, observation, { bridge: this.bridge, forge: this.forge });
          hardened.push(sank);
        }
      }
    }

    return {
      results,
      observations,
      summary: survivalCriteria.summarize(results),
      breaches,
      hardened,
    };
  }

  /** 选取本场战役要打的向量。 */
  _select(campaign) {
    let v = this.vectors;
    if (campaign.target) v = v.filter((x) => x.target === campaign.target);
    if (campaign.family) v = v.filter((x) => x.family === campaign.family);
    if (Array.isArray(campaign.vectorIds) && campaign.vectorIds.length) {
      const set = new Set(campaign.vectorIds);
      v = v.filter((x) => set.has(x.id));
    }
    return v;
  }
}

/** 便捷入口：跑一场全量评测战役（不沉淀），返回 summary + breaches。 */
async function runDefaultCampaign(campaign = {}) {
  return new AdversarialTrainer().runCampaign(campaign);
}

module.exports = {
  AdversarialTrainer,
  runDefaultCampaign,
  // 子模块再导出，便于上层/测试按需取用
  attackVectors,
  survivalCriteria,
  stressHarness,
  hardeningLoop,
  TARGET: attackVectors.TARGET,
  FAMILY: attackVectors.FAMILY,
  INVARIANTS: survivalCriteria.INVARIANTS,
};
