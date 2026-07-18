'use strict';

/**
 * withTimeout.js — 「给 promise 套超时·到点以哨兵值 resolve(绝不 reject)」共享 helper
 *   (非纯·调度 setTimeout 定时器·但无 IO/文件/env/模块依赖)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_withTimeout(promise, ms)`——
 *   services/contextScope/index(内部用·:79)· services/reverseEngineer/reconstructionPort(内部用·:134)。
 *
 * 语义:返回一个**只 resolve 不 reject** 的 Promise。ms 到点仍未结算 →
 *   resolve `{ __timeout: true }`;原 promise 先 fulfilled → resolve 其值(清定时器);
 *   原 promise rejected → resolve `{ __error: true }`。`settled` 闩保证只结算一次。
 *
 * 契约:非纯(setTimeout/clearTimeout 定时器)·不 mutate 入参·绝不抛/绝不 reject。
 *   各消费方保留同名本地 `const _withTimeout = require('../../utils/withTimeout')`
 *   → 调用点逐字节不变。
 */

function _withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve({ __timeout: true }); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve({ __error: true }); } },
    );
  });
}

module.exports = _withTimeout;
