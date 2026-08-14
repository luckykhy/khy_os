'use strict';

/**
 * resolveEnv.js — 「注入 env 优先,回退 process.env」解析器单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_env(env)`
 * (services/browser/_evalTimeout · services/gateway/_gatewayHardDeadline · tools/_toolTimeout):
 *   `env || (typeof process !== 'undefined' ? process.env : {})`
 * 语义:传入的 env 为真值(含空对象 {})→ 原样返回;否则回退到 process.env(无 process 则 {})。
 *   用途:叶子接受可注入 env 以便测试,缺省时读全局 process.env。
 *
 * **刻意不收敛**:services/sourceHealService 的 `_env(opts)`(读 `opts.env`·签名不同)、
 *   video/imageGenService 的 `_env(name)`(前缀读具体变量)——签名/语义不同,留原样(C 组)。
 *
 * 契约:确定性、不 mutate。注:回退分支读全局 process.env(非纯·env-injection 惯用)。
 *
 * 各消费方保留同名本地 `const _env = require('.../resolveEnv')` → 调用点逐字节不变。
 */

function resolveEnv(env) {
  return env || (typeof process !== 'undefined' ? process.env : {});
}

module.exports = resolveEnv;
