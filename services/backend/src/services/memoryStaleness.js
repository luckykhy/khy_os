'use strict';

/**
 * memoryStaleness —— 纯叶子 (pure leaf):记忆条目「是否过期」的确定性判定单一真源。
 *
 * 契约 (CONTRACT):零 IO(时间戳与 nowMs 由调用方读入后作参数传进来;本叶子只做纯数值/
 *   字符串判定,绝不碰 fs / 时钟 / 子进程 / 网络)、确定性(同入参恒定同输出,**不调用
 *   Date.now()**——当前时刻必须由调用方传入 nowMs)、绝不抛、单一真源(每类记忆的过期视界
 *   天数只在这里派生,且复用 distiller 同名 env 旋钮保持与蒸馏期一致)、env 门控默认开
 *   (`KHY_MEMORY_STALENESS`,仅 {0,false,off,no} 关闭,关闭即「永不判为过期」字节回退,
 *   召回路径不再追加任何过期标注)。fail-soft:缺时间戳 / 非法入参一律判为「不过期」
 *   (绝不因为读不到 updated 就把好记忆误标过期)。
 *
 * 背景:记忆条目此前没有 per-memory 的「最后更新时间」,加载时无法区分「3 年前写的项目笔记」
 *   与「昨天写的」。saveMemory 现在落盘 `updated` ISO 时间戳(缺失则调用方回退文件 mtime),
 *   召回时用本叶子按类型视界判定是否已过期,过期项追加一条**非侵入**的提示标注(不改变选择,
 *   只让模型知道该条可能已陈旧)。
 *
 * 与 distiller 的关系:蒸馏期 `memoryEngine/distiller.staleThresholdDays` 用同一批 env 旋钮
 *   决定归档;本叶子读**相同**的 `KHY_MEMORY_STALE_DAYS_*` 默认值,确保两处视界一致(单一真源)。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 每类记忆的过期视界默认天数(与 distiller.staleThresholdDays 一致)。 */
const DEFAULT_HORIZON_DAYS = Object.freeze({
  user: 3650,      // 身份类:近乎不过期
  feedback: 540,
  reference: 365,
  project: 180,
  _default: 365,
});

/** 是否启用过期判定(门控关 → 永不判过期,召回不追加标注)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_MEMORY_STALENESS) != null ? env.KHY_MEMORY_STALENESS : '')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 读 env 正浮点(缺失 / 非法 / 非正 → undefined,交后续用默认)。 */
function _envPosFloat(env, key) {
  const raw = env && env[key];
  if (raw == null || String(raw).trim() === '') return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 某类型记忆的过期视界(天)。复用 distiller 的 env 旋钮以保持单一真源。
 * @param {string} type
 * @param {Object} [env]
 * @returns {number}
 */
function horizonDays(type, env = (typeof process !== 'undefined' ? process.env : {})) {
  const t = String(type || '').toLowerCase();
  const e = env && typeof env === 'object' ? env : {};
  const perTypeKey = {
    user: 'KHY_MEMORY_STALE_DAYS_USER',
    feedback: 'KHY_MEMORY_STALE_DAYS_FEEDBACK',
    reference: 'KHY_MEMORY_STALE_DAYS_REFERENCE',
    project: 'KHY_MEMORY_STALE_DAYS_PROJECT',
  }[t];
  if (perTypeKey) {
    return _envPosFloat(e, perTypeKey)
      || DEFAULT_HORIZON_DAYS[t]
      || DEFAULT_HORIZON_DAYS._default;
  }
  return _envPosFloat(e, 'KHY_MEMORY_STALE_DAYS') || DEFAULT_HORIZON_DAYS._default;
}

/**
 * 判定一条记忆是否过期。所有事实由调用方读入后传进来(updatedMs / nowMs)。
 *
 * @param {Object} params
 * @param {string} params.type        记忆类型(user/feedback/reference/project)
 * @param {number} params.updatedMs   最后更新时刻(epoch ms);缺失 / 非法 → 不判过期
 * @param {number} params.nowMs       当前时刻(epoch ms);**必须由调用方传入**
 * @param {Object} [env]
 * @returns {{stale:boolean, ageDays:number|null, horizonDays:number}}
 */
function assessStaleness(params = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  const type = params && params.type;
  const horizon = horizonDays(type, env);

  // 门控关:永不判过期(字节回退)。
  if (!isEnabled(env)) return { stale: false, ageDays: null, horizonDays: horizon };

  const rawUpdated = params && params.updatedMs;
  const rawNow = params && params.nowMs;
  // 注意:Number(null) === 0(有限),会把缺失时间戳误当 epoch 0 → 永远过期。
  // 必须先排除 null / '' / undefined,再做数值化。
  const updatedMs = (rawUpdated == null || rawUpdated === '') ? NaN : Number(rawUpdated);
  const nowMs = (rawNow == null || rawNow === '') ? NaN : Number(rawNow);
  // 缺时间戳 / 非法 → fail-soft 判为不过期(绝不误标好记忆)。
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) {
    return { stale: false, ageDays: null, horizonDays: horizon };
  }

  const ageMs = nowMs - updatedMs;
  if (!(ageMs > 0)) return { stale: false, ageDays: 0, horizonDays: horizon }; // 未来 / 同刻 → 不过期
  const ageDays = ageMs / MS_PER_DAY;
  return { stale: ageDays > horizon, ageDays, horizonDays: horizon };
}

/**
 * 解析 frontmatter 的 `updated` 字段为 epoch ms。非法 / 缺失 → null,
 * 由调用方决定是否回退到文件 mtime。
 * @param {*} updatedValue
 * @returns {number|null}
 */
function parseUpdatedMs(updatedValue) {
  if (updatedValue == null || updatedValue === '') return null;
  const ms = Date.parse(String(updatedValue));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 为一条过期记忆生成简短的非侵入标注(召回块尾追加)。不过期 → 空串。
 * @param {{stale:boolean, ageDays:number|null, horizonDays:number}} assessment
 * @returns {string}
 */
function formatStaleNote(assessment) {
  if (!assessment || !assessment.stale) return '';
  const age = Number.isFinite(assessment.ageDays) ? Math.round(assessment.ageDays) : null;
  const horizon = Math.round(assessment.horizonDays);
  const agePart = age != null ? `约 ${age} 天前更新` : '更新时间不明';
  return `> ⏳ 该记忆可能已过期(${agePart},超过 ${horizon} 天视界)——采用前请核实其仍然成立。`;
}

module.exports = {
  MS_PER_DAY,
  DEFAULT_HORIZON_DAYS,
  isEnabled,
  horizonDays,
  assessStaleness,
  parseUpdatedMs,
  formatStaleNote,
};
