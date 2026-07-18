'use strict';

/**
 * core/coreActions.js — 官方核心轨内置动作（任务三 · 受保护基座样例）。
 *
 * 这些是官方维护、用户/模型严禁直接修改的核心动作处理器。它们由 DualTrackRuntime 在
 * assemble 阶段注册进核心轨并随即密封。用户扩展轨可通过 Override **影子覆盖**同名 type，
 * 但本文件作为官方源**保持不变**（红线5）。
 *
 * 每个 handler 形如 (action, ctx) => result，纯逻辑、无副作用，便于测试。
 */

const CORE_ACTIONS = Object.freeze({
  // 文本输出
  say(action) {
    const text = (action && action.params && action.params.text) || '';
    return { ok: true, kind: 'say', text: String(text), origin: 'official_core' };
  },
  // 读取文件（样例：仅回显意图，真实实现由调度器注入执行器）
  read_file(action) {
    const path = (action && action.params && action.params.path) || '';
    return { ok: true, kind: 'read_file', path: String(path), origin: 'official_core' };
  },
  // 无操作占位
  noop() {
    return { ok: true, kind: 'noop', origin: 'official_core' };
  },
});

/** 官方核心接入点契约：用户扩展轨可依赖的稳定 Hook/Slot/Override 入口（供兼容性检查）。 */
const CORE_ENTRY_POINTS = Object.freeze([
  'registerOverride',     // 覆写官方默认动作
  'registerAction',       // 新增动作执行器
  'action.params',        // 动作参数槽（向后兼容数据结构）
  'action.type',          // 动作类型槽
]);

module.exports = { CORE_ACTIONS, CORE_ENTRY_POINTS };
