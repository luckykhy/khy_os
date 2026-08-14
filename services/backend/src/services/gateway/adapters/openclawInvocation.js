'use strict';

/**
 * openclawInvocation.js — 纯叶子:把「让 khyos 指挥 openclaw 作为便携 CLI 后端引擎」的调用
 * 参数构建为单一真源(零 IO、确定性、env 门控、绝不抛、可单测)。仿 opencodeInvocation.js。
 *
 * 背景:OpenClaw 的非交互/headless 一次性入口是官方 CI 场景的
 * `openclaw agent exec --json --isolated [message]`:
 *   - prompt 用位置参数尾部传入(与 Aider/OpenCode 的位置参数模式同构),真正的 spawn /
 *     探测 / 输出捕获仍复用 cliToolAdapter 既有子进程机制;
 *   - `--json` 输出完整信封 { ok, status, final, usage, model, ... }(status ∈ ok/error/timeout);
 *   - `--isolated` 忽略用户配置(适合 khy 指挥场景);
 *   - 模型注入用 `--model provider/model`(如 `openai/gpt-5.6-sol`)。
 * 本叶子只负责把这些开关规范化成参数数组。
 *
 * 契约:零 IO(只做字符串/数组逻辑,不 require fs/net/子进程);确定性(同输入同输出);
 * 绝不抛(坏输入 → 安全回退)。
 *
 * 门控 KHY_OPENCLAW(**默认关闭**,仅显式 1/true/on/yes 打开):与 opencodeInvocation 的
 * KHY_OPENCODE 默认开相反。原因:本环境无法真跑该 CLI 做 smoke test,契约仅文档确认;门控
 * 关闭时 detect 返回不可用,网关整体跳过该适配器,确保适配器集合与接入前字节级一致。
 * ⚠️ 待真实运行冒烟测试(openclaw agent exec --json --isolated)通过后,可将默认改为开
 * (对齐 opencode 的默认开语义)。
 *
 * @module services/gateway/adapters/openclawInvocation
 */

const _ON = new Set(['1', 'true', 'on', 'yes']);

/** 门控:KHY_OPENCLAW 默认关,仅显式 1/true/on/yes 打开。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_OPENCLAW;
  return v !== undefined && _ON.has(String(v).trim().toLowerCase());
}

/**
 * 构建 `openclaw agent exec` 的参数数组。固定 `--json`(完整信封输出)+ `--isolated`
 * (忽略用户配置)。尾部的 `__PROMPT__` 占位符由 cliToolAdapter.invokeToolAsync 在 spawn
 * 前替换成真实 prompt(与 Aider 的 `--message __PROMPT__` / OpenCode 的 `run __PROMPT__`
 * 同一机制)——契约「prompt 用位置参数尾部传入」。
 *
 * @returns {string[]}
 */
function buildRunArgs() {
  return ['agent', 'exec', '--json', '--isolated', '__PROMPT__'];
}

/**
 * 在既有参数数组上追加 `--model provider/model`(仅当 model 是含 '/' 的非空串)。供
 * cliToolAdapter 的通用 model 注入钩子调用。绝不改动入参:返回新数组;不合法 → 原样返回浅拷贝。
 */
function applyModelArg(args, model) {
  const base = Array.isArray(args) ? args.slice() : [];
  if (typeof model === 'string' && model.trim().includes('/')) {
    base.push('--model', model.trim());
  }
  return base;
}

module.exports = {
  isEnabled,
  buildRunArgs,
  applyModelArg,
};
