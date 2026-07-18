'use strict';

/**
 * opencodeInvocation.js — 纯叶子:把「让 khyos 指挥 opencode 代码编辑器」的调用参数
 * 构建为单一真源(零 IO、确定性、env 门控、绝不抛、可单测)。
 *
 * 背景(goal「我希望 Khyos 可以指挥 cc、opencode 等代码编辑器」):khyos 已能通过
 * cliToolAdapter / claudeAdapter / codexAdapter 指挥 Claude Code、Codex、Aider,但
 * **opencode 从未被接入为可调用的子代理**。opencode 的非交互入口是
 * `opencode run [message..]`(位置参数,不读 stdin;`-m provider/model`;
 * `--format default|json`;`-c/--continue`、`-s/--session` 续接会话)。本叶子只负责
 * 把这些开关规范化成参数数组 —— 真正的 spawn / 探测 / 输出捕获仍复用 cliToolAdapter
 * 既有的子进程机制(与 Aider 的「位置参数 + 非流式」模式同构)。
 *
 * 契约:零 IO(只做字符串/数组逻辑,不 require fs/net/子进程);确定性(同输入同输出);
 * 绝不抛(坏输入 → 安全回退)。
 *
 * 门控 KHY_OPENCODE(默认开,仅显式 0/false/off/no 关闭):关闭后 opencode 既不进入
 * cliToolAdapter 的探测清单,专用 opencodeAdapter 也表现为「不可用」—— 逐字节回退到
 * 「opencode 未被接入」的历史行为。
 *
 * @module services/gateway/adapters/opencodeInvocation
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_OPENCODE 默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_OPENCODE;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/**
 * opencode 的 `-m/--model` 只接受 `provider/model` 形式(例如 `anthropic/claude-...`)。
 * khyos 内部的模型 ID 未必是这种形式,贸然传入会让 opencode 报错。故仅当模型串是
 * 非空、两侧都有内容的 `provider/model` 才注入;否则让 opencode 用它自己配置的默认模型。
 */
function looksLikeProviderModel(model) {
  if (typeof model !== 'string') return false;
  const s = model.trim();
  const slash = s.indexOf('/');
  if (slash <= 0 || slash >= s.length - 1) return false;
  // 只允许单个斜杠(provider/model),排除路径式 a/b/c 以免误判。
  return s.indexOf('/', slash + 1) === -1;
}

/**
 * 构建 `opencode run` 的参数数组。首两项固定为 `['run', '__PROMPT__']`,
 * `__PROMPT__` 占位符由 cliToolAdapter.invokeToolAsync 在 spawn 前替换成真实 prompt
 * (与 Aider 的 `--message __PROMPT__` 同一机制)。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]            provider/model(仅合法时注入 --model)
 * @param {('default'|'json')} [opts.format] 输出格式(default 省略;json 传 --format json)
 * @param {boolean} [opts.continueSession] 续接上一会话(--continue)
 * @param {string} [opts.sessionId]        指定会话 id(--session)
 * @param {string} [opts.agent]            指定 opencode agent(--agent)
 * @returns {string[]}
 */
function buildRunArgs(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = ['run', '__PROMPT__'];
  if (o.format === 'json') args.push('--format', 'json');
  if (o.continueSession) args.push('--continue');
  if (typeof o.sessionId === 'string' && o.sessionId.trim()) args.push('--session', o.sessionId.trim());
  if (typeof o.agent === 'string' && o.agent.trim()) args.push('--agent', o.agent.trim());
  if (looksLikeProviderModel(o.model)) args.push('--model', o.model.trim());
  return args;
}

/**
 * 在既有参数数组上追加 `--model provider/model`(仅当模型合法)。供 cliToolAdapter 的
 * 通用 model 注入钩子调用。绝不改动入参:返回新数组;不合法 → 原样返回浅拷贝。
 */
function applyModelArg(args, model) {
  const base = Array.isArray(args) ? args.slice() : [];
  if (looksLikeProviderModel(model)) base.push('--model', model.trim());
  return base;
}

module.exports = {
  isEnabled,
  looksLikeProviderModel,
  buildRunArgs,
  applyModelArg,
};
