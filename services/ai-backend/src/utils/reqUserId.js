'use strict';

/**
 * reqUserId.js — 「从已认证 req 取用户 id」单一真源(纯)。
 *
 * 收敛 4 处 body 逐字节相同的私有 `userId(req)`:
 *   `return req.user && (req.user.id != null ? req.user.id : req.user.userId);`
 *   (ai-backend routes: marketplace · plugins · userGateway · workflow)。
 *   req.user 缺失 → 返回 falsy(req.user);否则优先 req.user.id,nullish 时回退 req.user.userId。
 *
 * **刻意不收敛(不可互委)**:
 *   - 读 req.userId / req.auth.id / req.session.userId 等不同来源的变体。
 *   - 缺失时抛 401 / 返回默认游客 id 的变体。
 *   - 强制 String()/Number() 归一化 id 的变体。
 *
 * 契约:纯函数、确定性、不 mutate 入参(仅读 req.user)。
 *
 * 各消费方保留同名本地 `const userId = require('.../reqUserId')`→ 调用点逐字节不变。
 */

function reqUserId(req) {
  return req.user && (req.user.id != null ? req.user.id : req.user.userId);
}

module.exports = reqUserId;
