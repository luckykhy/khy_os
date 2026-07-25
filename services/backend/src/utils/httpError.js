'use strict';

/**
 * httpError.js — 「造带 statusCode 的 Error」单一真源(纯)。
 *
 * 收敛 5 处 body 逐字节相同的私有 helper:
 *   `const err = new Error(message); err.statusCode = statusCode; return err;`
 *   (backend: conversationStore · projectStore · promptStore;
 *    ai-backend: cozeImportService · workflowService)。
 *   造 Error(message) 后挂 err.statusCode = statusCode 返回(供 HTTP 层读状态码)。
 *
 * ai-backend 侧经 `require('../../../backend/src/utils/httpError')` 跨服务根委托到本 SSOT
 * (与 services/ai-backend/src/constants/models.js 引用 backend constants 的既定模式一致)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 用 err.status / err.code(字段名不同)、或额外挂 name/expose/body 的变体。
 *   - 参数序颠倒(message, statusCode)、或 message 缺省的变体。
 *   - 继承自定义 HttpError class 的变体。
 *
 * 契约:纯函数、确定性、不 mutate 入参(仅新建并返回 Error)。
 *
 * 各消费方保留同名本地 `const httpError = require('.../httpError')`→ 调用点逐字节不变。
 */

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = httpError;
