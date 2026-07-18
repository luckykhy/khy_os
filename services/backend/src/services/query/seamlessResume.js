'use strict';

// seamlessResume.js — pure leaf (zero IO, deterministic, never throws, unit-testable).
//
// 目的:让"连接中断后自动从断点续写"(无感续写)在短/普通任务上也能真正触发。
//
// 背景(诊断):无感续写的机件早已就位——query/inertialContinuation.js 保存已流出
// 前缀并注入"从断点无缝继续"指令,toolUseLoop.js 的瞬时错误路径会自动 `continue`
// 重发模型调用。唯一缺口是"自动续写预算":toolUseLoop._resolveTransientRecoveryMax
// 按任务规模给默认值 small=0 / normal=1 / large=3——short prompt(含不少"讲个故事")
// 被判 small,断流后零次静默续写,立刻甩手动「继续」提示。
//
// 本叶子只做一件事:提供"按规模的默认续写预算地板",门控开 → 抬高 small/normal,
// 门控关 → 逐字节回退现状默认值。显式 env 覆盖与 options 仍由 call-site 最高优先,
// 本叶子从不读那些覆盖项,只给"未显式设置时的默认值"。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 均衡(用户确认):耗尽后仍回退手动提示;每多一次=API 真挂时多一次调用+几秒等待。
const ON_DEFAULTS = Object.freeze({ small: 1, normal: 2, large: 3 });
// 现状字节值(门控关时逐字节回退,= toolUseLoop._resolveTransientRecoveryMax 原默认)。
const LEGACY_DEFAULTS = Object.freeze({ small: 0, normal: 1, large: 3 });

/**
 * 无感续写默认预算抬升,默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_SEAMLESS_RESUME;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 规整任务规模到 {small|normal|large}。未知/缺省 → normal(与 call-site 中段一致)。
 * @param {string} scale
 * @returns {'small'|'normal'|'large'}
 */
function _normScale(scale) {
  const s = String(scale == null ? '' : scale).trim().toLowerCase();
  if (s === 'small' || s === 'large') return s;
  return 'normal';
}

/**
 * 给定任务规模,返回"未显式设置 env/options 时应使用的默认瞬时续写预算"。
 *   • 门控开 → ON_DEFAULTS(small 抬到 1、normal 抬到 2、large 维持 3)
 *   • 门控关 → LEGACY_DEFAULTS(0/1/3,= 现状字节值)
 * @param {string} scale
 * @param {object} [env]
 * @returns {number}
 */
function defaultTransientBudget(scale, env = process.env) {
  const s = _normScale(scale);
  return isEnabled(env) ? ON_DEFAULTS[s] : LEGACY_DEFAULTS[s];
}

module.exports = {
  isEnabled,
  defaultTransientBudget,
  ON_DEFAULTS,
  LEGACY_DEFAULTS,
  OFF_VALUES,
};
