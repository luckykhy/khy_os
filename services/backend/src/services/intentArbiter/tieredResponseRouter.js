'use strict';

/**
 * tieredResponseRouter.js — 分级响应沙箱网（§3.3）。
 *
 * 把意图光谱的三段映射到三个安全等级递增的沙箱，实现「精准放行 ⇄ 安全隔离」的平衡：
 *
 *   ChatSandbox      [0.0,0.3)  纯生成、零工具权限。闲聊与「你是什么模型」在此物理隔绝。
 *   ConfirmSandbox   [0.3,0.7)  只产出确认请求、**零副作用**（防呆④）。用户二次明确后才重算放行。
 *   ExecutionGateway [0.7,1.0]  意图明确，放行——但执行前仍声明须串接数据主权网关 + 权限审批
 *                               （见 [DESIGN-ARCH-040]），本路由器只裁定「可入闸」，不代执行（零侵入）。
 *
 * 防呆④（写死）：ConfirmSandbox 描述符 `sideEffectsAllowed=false` 且不挂任何工具/状态变更接口；
 * `assertZeroRisk` 在装配确认沙箱时断言其零风险，任何副作用接口渗入即抛。
 *
 * 纯函数、确定性。
 */

const { BANDS } = require('./intentLexicon');

// ExecutionGateway 放行后仍须依次经过的下游管道（声明式，不在此执行——零侵入）。
const EXECUTION_DOWNSTREAM = Object.freeze(['data-sovereignty', 'permission-approval']);

class ZeroRiskViolationError extends Error {
  constructor(field) {
    super(`确认沙箱零风险铁律被破坏：检出副作用接口「${field}」（防呆④）`);
    this.name = 'ZeroRiskViolationError';
    this.code = 'ERR_CONFIRM_SANDBOX_SIDE_EFFECT';
  }
}

class TieredResponseRouter {
  /**
   * @param {object} analysis  IntentSpectrumAnalyzer.analyze 的输出
   * @returns {{
   *   sandbox:string, band:string, confidence:number, intent:string,
   *   sideEffectsAllowed:boolean, toolsAllowed:boolean,
   *   confirmPrompt?:string, downstream?:string[], note:string
   * }}
   */
  route(analysis) {
    const band = analysis.band;
    const confidence = analysis.confidence;
    const intent = analysis.text;

    switch (band) {
      case BANDS.EXECUTION:
        return {
          sandbox: 'ExecutionGateway', band, confidence, intent,
          sideEffectsAllowed: true, toolsAllowed: true,
          downstream: [...EXECUTION_DOWNSTREAM],
          note: '强意图特征，放行入闸；执行前仍须经数据主权网关 + 权限审批',
        };

      case BANDS.CONFIRM: {
        // 防呆④：确认沙箱**绝无**副作用，只生成零风险确认请求。
        const sandbox = {
          sandbox: 'ConfirmSandbox', band, confidence, intent,
          sideEffectsAllowed: false, toolsAllowed: false,
          confirmPrompt: this._confirmPrompt(analysis),
          note: '歧义模糊带：禁止自主猜测执行（防呆②），生成确认请求交用户裁决',
        };
        return this.assertZeroRisk(sandbox);
      }

      case BANDS.CHAT:
      default:
        return {
          sandbox: 'ChatSandbox', band: BANDS.CHAT, confidence, intent,
          sideEffectsAllowed: false, toolsAllowed: false,
          note: '安全对话带：纯生成、无工具权限，闲聊/自指疑问物理隔绝于系统模式',
        };
    }
  }

  /** 依目标宾语构造零风险确认问句（不含任何执行接口）。 */
  _confirmPrompt(analysis) {
    const target = (analysis.features.targets && analysis.features.targets[0]) || '该操作';
    return `您是否希望执行「${target}」相关操作？(Y/N)`;
  }

  /**
   * 防呆④断言：确认沙箱必须零副作用、零工具、且不携带任何状态变更接口。
   * @throws {ZeroRiskViolationError}
   */
  assertZeroRisk(sandbox) {
    if (sandbox.sandbox !== 'ConfirmSandbox') return sandbox;
    if (sandbox.sideEffectsAllowed) throw new ZeroRiskViolationError('sideEffectsAllowed');
    if (sandbox.toolsAllowed) throw new ZeroRiskViolationError('toolsAllowed');
    for (const k of ['exec', 'tool', 'mutate', 'apply', 'commit', 'downstream']) {
      if (k in sandbox) throw new ZeroRiskViolationError(k);
    }
    return sandbox;
  }
}

module.exports = { TieredResponseRouter, ZeroRiskViolationError, EXECUTION_DOWNSTREAM };
