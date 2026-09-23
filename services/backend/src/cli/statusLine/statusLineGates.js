'use strict';

/**
 * statusLineGates.js — 纯叶子:statusLine 的 env 门控家族(逐字节搬移自 statusLineConfig.js)。
 * 契约:零 IO、零 require、确定性、只读 env + 共享 _FALSY 集。宿主 re-require 同名标识符再绑定,
 * isEnabled 作为宿主公共面的一部分同引用再导出。behavior-preserving split(棘轮第 20 次应用)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_STATUS_LINE 默认开;{0,false,off,no} 关。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_PCT_ROUND 默认开;{0,false,off,no} 关 → 逐字节回退原始浮点。
 * 独立于父门控 KHY_STATUS_LINE(父关则 runner 整体跳过执行;本子门控只治百分比取整这一面)。
 */
function _pctRoundEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_PCT_ROUND;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_COST 默认开;{0,false,off,no} 关 → payload 不含 `cost` 段
 * (逐字节回退刀92前的 stdin 契约)。独立于父门控 KHY_STATUS_LINE 与 KHY_STATUS_LINE_PCT_ROUND。
 */
function _costEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_COST;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_MODEL_NAME 默认开;{0,false,off,no} 关 → `model.display_name`
 * 逐字节回退原始 model id(刀96 前行为)。独立于父门控 KHY_STATUS_LINE 与其它子门控。
 */
function _modelNameEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_MODEL_NAME;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_OUTPUT_STYLE 默认开;{0,false,off,no} 关 → payload 不含 `output_style`
 * 段(逐字节回退刀97前的 stdin 契约)。独立于父门控 KHY_STATUS_LINE 与其它子门控。
 */
function _outputStyleEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_OUTPUT_STYLE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_PERMISSION_MODE 默认开;{0,false,off,no} 关 → payload 不含
 * `permission_mode` 字段(逐字节回退刀98前的 stdin 契约)。独立于父门控与其它子门控。
 */
function _permissionModeEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_PERMISSION_MODE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_SESSION_ID 默认开;{0,false,off,no} 关 → `session_id` 逐字节回退空串
 * (刀99 前行为——壳从不注入 sessionId,叶子恒发 '')。独立于父门控与其它子门控。
 */
function _sessionIdEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_SESSION_ID;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_TRANSCRIPT_PATH 默认开;{0,false,off,no} 关 → payload 不含
 * `transcript_path` 键(逐字节回退刀100前的 stdin 契约——该键从不存在)。独立于父门控与其它子门控。
 */
function _transcriptPathEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_TRANSCRIPT_PATH;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

module.exports = {
  isEnabled,
  _pctRoundEnabled,
  _costEnabled,
  _modelNameEnabled,
  _outputStyleEnabled,
  _permissionModeEnabled,
  _sessionIdEnabled,
  _transcriptPathEnabled,
};
