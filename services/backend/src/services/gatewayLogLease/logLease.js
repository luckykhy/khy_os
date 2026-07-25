'use strict';

/**
 * gatewayLogLease/logLease.js — GatewayLogLease：日志可见性决策引擎。
 *
 * 给定"这条日志来自哪个适配器 + 什么级别 + 文本"，结合当前 AsyncLocalStorage 租界上下文，
 * 裁决它能去哪里。这是「按需可见」规则表的代码化实现（防呆：规则写死在此，不可被调用方绕过）：
 *
 *   触发场景                         可见性          去向
 *   ───────────────────────────────────────────────────────────
 *   查网关状态 (mode=status-query)   ✅ 全量          L0（净味摘要，保留适配器名）
 *   静默沙箱   (mode=sandbox)         ❌ 不可见        BUFFER（重定向到上下文缓冲）
 *   任务中 & 源 === 活跃适配器        ✅ 净味后         L0（友好提示）/ 纯噪音→DROP
 *   任务中 & 源 !== 活跃适配器        ❌ 不可见        L1（仅开发日志，绝不上主流）
 *   无上下文（游离/全局）            ❌ 不可见        L1（结构化下沉，绝不上主流）
 *
 * 去向（channel）取值：
 *   'L0'     用户流（净味后）
 *   'L1'     开发日志（debug.log / 内存环）
 *   'BUFFER' 当前上下文的 buffer（沙箱重定向）
 *   'DROP'   /dev/null（彻底丢弃）
 */

const ctxMod = require('./context');
const noiseFilter = require('./noiseFilter');

const CHANNELS = Object.freeze({ L0: 'L0', L1: 'L1', BUFFER: 'BUFFER', DROP: 'DROP' });

/**
 * 裁决一条来自适配器的日志。
 * @param {object} entry
 * @param {string} entry.sourceAdapter  日志来源适配器 id（未知/系统传 null）
 * @param {string} [entry.level]         'log'|'info'|'warn'|'error'|'debug'
 * @param {*}      entry.text            原始文本 / Error
 * @returns {{ visible:boolean, channel:string, output:string|null, raw:string }}
 *   output：要落到该 channel 的内容（L0=净味句、L1/BUFFER/状态=脱敏原文）；DROP 时为 null。
 */
function decide(entry = {}) {
  const source = ctxMod.normalizeAdapterId(entry.sourceAdapter);
  const level = entry.level || 'log';
  const rawText = _text(entry.text);
  const ctx = ctxMod.current();

  // —— 无上下文：游离日志（含未被任何请求绑定的后台异步）→ 绝不上主流，下沉 L1。
  if (!ctx) {
    return _mk(false, CHANNELS.L1, noiseFilter.sanitizeForStatus(rawText), rawText);
  }

  // —— 查网关状态：全量可见，净味摘要（保留适配器名，状态查询里它是合法信息）。
  if (ctx.mode === ctxMod.MODES.STATUS_QUERY) {
    return _mk(true, CHANNELS.L0, noiseFilter.sanitizeForStatus(rawText), rawText);
  }

  // —— 静默沙箱：初始化 / Token 刷新的内部输出，一律重定向缓冲，绝不可见。
  if (ctx.mode === ctxMod.MODES.SANDBOX) {
    return _mk(false, CHANNELS.BUFFER, noiseFilter.sanitizeForStatus(rawText), rawText);
  }

  // —— 任务模式：取决于来源是否等于当前活跃适配器。
  const active = ctx.activeAdapter;
  if (active && source && source === active) {
    // 在用适配器：净味翻译后给用户(L0)；纯噪音(translate→null)直接丢弃。
    const friendly = noiseFilter.translate(rawText);
    if (friendly == null) return _mk(false, CHANNELS.DROP, null, rawText);
    return _mk(true, CHANNELS.L0, friendly, rawText);
  }

  // 来源不是活跃适配器（或来源未知）：对用户不可见，仅下沉开发日志 L1。
  return _mk(false, CHANNELS.L1, noiseFilter.sanitizeForStatus(rawText), rawText);
}

function _mk(visible, channel, output, raw) {
  return { visible, channel, output, raw, level: undefined };
}

function _text(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (t instanceof Error) return t.message || String(t);
  try { return String(t); } catch { return ''; }
}

module.exports = { decide, CHANNELS };
