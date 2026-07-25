'use strict';

/**
 * failsafe/ — 零静默失败与精准归因子系统（门面）。
 *
 * 目标：彻底废除"AI 未返回有效回复 / 未知错误 / 请求失败"等模糊文案。任何非正常终止
 * 都被归并到 E01–E08 之一并携带必填字段，且兜底协议不可绕过——即便进程被杀，流式
 * 拦截器也会在最后一刻补写 E04/E06。
 *
 * 组成：
 *   errorCodes.js    E01–E08 单一真源（reason 文案 / 必填字段 / 脱敏标记）。
 *   classifier.js    ErrorClassifier：任意原始信号 → E0x 标准结构（E02/E07 脱敏）。
 *   safeResponse.js  SafeResponseWrapper：拦截 LLM/工具/外部通信返回，空值/非法→结构化错误。
 *   streamInjector.js StreamFailSafeInjector：流式兜底注入（应用层/流意外结束/进程级三层）。
 *
 * 规范：DESIGN-ARCH-028。关联：DESIGN-ARCH-027（依赖自愈，E05 来源）、
 *      DESIGN-ARCH-026（审批网关，E07 来源）。
 */

const errorCodes = require('./errorCodes');
const classifier = require('./classifier');
const { SafeResponseWrapper } = require('./safeResponse');
const { StreamFailSafeInjector, sweepActive } = require('./streamInjector');

module.exports = {
  // 错误字典
  ERROR_CODES: errorCodes.ERROR_CODES,
  FALLBACK_CODE: errorCodes.FALLBACK_CODE,
  getErrorCode: errorCodes.getErrorCode,
  listCodes: errorCodes.listCodes,
  isKnownCode: errorCodes.isKnownCode,
  // 归因
  classify: classifier.classify,
  classifyCode: classifier.classifyCode,
  // 拦截器
  SafeResponseWrapper,
  // 流式兜底
  StreamFailSafeInjector,
  sweepActive,
};
