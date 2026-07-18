'use strict';

/**
 * weakModelChangeGuard.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标:**避免小模型乱改把 khy 改坏**。
 *
 * khy 会把活派给不同能力档的模型(见 modelTier.js:resolveTier → T0 前沿 / T1 强 /
 * T2 中 / T3 弱)。弱档模型(mini/lite/flash/haiku/small/7b…)推理浅、容易「自信地改错」,
 * 一旦让它直接改动「红线文件」(密钥 .env / 发布·CI 脚本 / flagRegistry SSOT / 版本三源 /
 * 权限核心 / .git 内部),就可能无声破坏整个仓库的可发布性与安全约束。
 *
 * 本叶子把「某能力档的模型能不能改这个文件」收成单一真源(纯判定,不执行任何动作):
 *
 *   classifyChangeRisk(filePath):
 *       'red-line'  → 密钥/发布/CI/版本 SSOT/权限核心/.git —— 弱模型碰即拦
 *       'sensitive' → god-file 级核心(网关/harness/工具循环) —— 弱模型碰须确认
 *       'normal'    → 其余普通源码/文档
 *
 *   assessWeakModelChange({ modelId, tier, filePath, changeKind, env }):
 *       门关 / 异常 / 入参不全 → 返回 null(调用方逐字节回退:按原逻辑放行,本闸不介入);
 *       强档(T0/T1)          → { allow:true,  reason:'strong-model' }(强模型不受限);
 *       弱档 + red-line       → { allow:false, action:'require-strong-review', … }(拦);
 *       弱档 + sensitive      → { allow:true,  requireConfirm:true, … }(放行但要人点头);
 *       其余                  → { allow:true }(普通文件随便改)。
 *
 * 门控 KHY_WEAK_MODEL_EDIT_GUARD(默认开;0/false/off/no 关 → assessWeakModelChange 返 null
 * 逐字节回退)。flagRegistry 优先,失败回退本地 CANON;绝不抛。
 *
 * ─────────────────────────── HOW-TO-EXTEND ───────────────────────────
 * 要把某类文件纳入「弱模型不许碰」的红线:往 RED_LINE_PATTERNS 加一条正则(匹配相对/绝对
 * 路径的 basename 或路径片段)。要纳入「弱模型碰须确认」的敏感核心:加进 SENSITIVE_PATTERNS。
 * 两张表都是**纯数据**,加正则即生效,无需改判定逻辑。判「弱」的口径统一走 modelTier.resolveTier,
 * 想调整哪些档算弱只在下方 _isWeakTier 一处改。
 * ─────────────────────────────────────────────────────────────────────
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 归一路径:统一成正斜杠、去掉结尾斜杠,便于跨平台正则匹配。
function _norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
}

// 红线文件:弱模型碰即拦(要求强模型复核)。纯数据 —— 见 HOW-TO-EXTEND。
const RED_LINE_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i,                 // 密钥/凭据文件(.env / .env.local / .env.broken-* …)
  /(^|\/)scripts\/release\//i,              // 发布脚本(不可逆外发)
  /(^|\/)scripts\/ci\//i,                   // CI 门禁脚本
  /(^|\/)\.github\//i,                       // GitHub 工作流/模板
  /(^|\/)flagRegistry\.js$/i,               // 特性开关 SSOT
  /(^|\/)permissionStore\.js$/i,            // 权限档核心
  /(^|\/)criticalGate\.js$/i,               // 不可绕过关键门
  /(^|\/)pyproject\.toml$/i,                // 版本三源(pip)
  /(^|\/)package\.json$/i,                  // 版本三源 + npm 脚本
  /(^|\/)MANIFEST\.in$/i,                    // 打包清单
  /(^|\/)setup\.py$/i,                       // 打包入口
  /(^|\/)\.git\//i,                          // git 内部(索引/refs/hooks)
];

// 敏感核心:弱模型可改但须人确认(god-file 级、改坏影响面大)。
const SENSITIVE_PATTERNS = [
  /(^|\/)aiGateway\.js$/i,                   // 网关 god-file
  /(^|\/)toolUseLoop([A-Za-z]*)?\.js$/i,    // 工具使用循环核心
  /(^|\/)replSession\.js$/i,                // 交互会话核心
  /(^|\/)harness([A-Za-z]*)?\.js$/i,        // harness 运行骨架
  /(^|\/)sessionPersistence\.js$/i,         // 会话持久化(改坏丢历史)
];

function _matchAny(patterns, normPath) {
  for (const re of patterns) {
    try { if (re.test(normPath)) return true; } catch { /* never-throw */ }
  }
  return false;
}

/**
 * 纯判定:某文件路径属于哪一类改动风险。绝不抛;空/非法路径视为 'normal'。
 * @param {string} filePath
 * @returns {'red-line'|'sensitive'|'normal'}
 */
function classifyChangeRisk(filePath) {
  const p = _norm(filePath);
  if (!p) return 'normal';
  if (_matchAny(RED_LINE_PATTERNS, p)) return 'red-line';
  if (_matchAny(SENSITIVE_PATTERNS, p)) return 'sensitive';
  return 'normal';
}

// 弱档判定:T2/T3 视为「弱」(中档也可能力不足以安全改红线)。T0/T1 为强。
function _isWeakTier(tier) {
  return tier === 'T2' || tier === 'T3';
}

/**
 * 门控 KHY_WEAK_MODEL_EDIT_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function weakModelChangeGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_WEAK_MODEL_EDIT_GUARD', e);
      }
    } catch { /* registry 不可用 → 本地 CANON */ }
    const raw = e.KHY_WEAK_MODEL_EDIT_GUARD;
    if (raw == null || raw === '') return true; // CANON: default-on
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return false; // 异常一律关门,交由调用方逐字节回退
  }
}

// 解析能力档:优先用调用方显式传入的 tier(T0..T3);否则走 modelTier.resolveTier(modelId)。
function _resolveTier(modelId, tier, env) {
  const VALID = ['T0', 'T1', 'T2', 'T3'];
  if (typeof tier === 'string' && VALID.includes(tier)) return tier;
  try {
    const mt = require('./modelTier');
    if (mt && typeof mt.resolveTier === 'function') {
      const t = mt.resolveTier(modelId, { env });
      if (typeof t === 'string' && VALID.includes(t)) return t;
    }
  } catch { /* never-throw */ }
  return null; // 无法判档
}

/**
 * 核心裁决:弱模型能不能改这个文件。纯函数、绝不抛。
 *
 * @param {object} input
 * @param {string} [input.modelId]     模型名(用于走 modelTier 自动分档)
 * @param {string} [input.tier]        显式能力档 T0..T3(优先于 modelId)
 * @param {string} input.filePath      被改动的文件路径
 * @param {string} [input.changeKind]  改动类型(edit/write/delete…,仅透传进裁决对象供上层用)
 * @param {Record<string,string>} [input.env]
 * @returns {null | { allow:boolean, risk:string, tier:(string|null),
 *                    action?:string, requireConfirm?:boolean, reason:string }}
 *          门关/异常/入参不全 → null(调用方逐字节回退,本闸不介入)。
 */
function assessWeakModelChange(input = {}) {
  try {
    const env = input.env || process.env;
    if (!weakModelChangeGuardEnabled(env)) return null; // 门关 → 回退
    const filePath = input.filePath;
    if (!filePath || typeof filePath !== 'string') return null; // 入参不全 → 回退

    const risk = classifyChangeRisk(filePath);
    const tier = _resolveTier(input.modelId, input.tier, env);
    const changeKind = typeof input.changeKind === 'string' ? input.changeKind : 'edit';

    // 无法判档 → 保守但不越权:普通文件放行,红线/敏感也只是要求确认(不硬拦,避免误伤强模型)。
    if (tier == null) {
      if (risk === 'red-line' || risk === 'sensitive') {
        return { allow: true, risk, tier: null, requireConfirm: true, changeKind,
          reason: '模型能力档未知,改动红线/敏感文件建议人工确认' };
      }
      return { allow: true, risk, tier: null, changeKind, reason: '普通文件放行(档未知)' };
    }

    // 强档(T0/T1)不受限。
    if (!_isWeakTier(tier)) {
      return { allow: true, risk, tier, changeKind, reason: 'strong-model' };
    }

    // 弱档(T2/T3)+ 红线 → 拦,要求强模型复核。
    if (risk === 'red-line') {
      return { allow: false, risk, tier, action: 'require-strong-review', changeKind,
        reason: `弱模型(${tier})不得直接改红线文件,请交强模型复核` };
    }
    // 弱档 + 敏感核心 → 放行但要确认。
    if (risk === 'sensitive') {
      return { allow: true, risk, tier, requireConfirm: true, changeKind,
        reason: `弱模型(${tier})改敏感核心文件,请人工确认` };
    }
    // 弱档 + 普通文件 → 放行。
    return { allow: true, risk, tier, changeKind, reason: '普通文件放行' };
  } catch {
    return null; // 任何异常 → 回退,绝不因本闸阻断正常流程
  }
}

/**
 * 双面顾问格式化(纯函数、绝不抛)。把 assessWeakModelChange 的裁决翻成人/AI 两行文案,
 * **只在值得提醒时**返回,其余一律 null(静默):
 *   - 门关/入参不全/异常            → null(逐字节回退,消费方零增量)
 *   - 强档(strong-model)/普通文件放行 → null(不打扰:khy 常态跑 T0/T1 → 本闸静默)
 *   - 弱档 + 红线(allow:false)      → 强提醒(该编辑应交强模型复核)
 *   - 需确认(requireConfirm)        → 温和提醒(弱档改敏感核心 / 档未知改红线,请人过目)
 *
 * 返回 { humanLine, aiNote } 与 selfEditAdvisory 双面投递同构(humanLine 交
 * onSelfEditAdvisory 回调;aiNote 前置进下一轮消息),故消费方复用既有汇聚点即可接线。
 *
 * @param {object} input 同 assessWeakModelChange(modelId/tier/filePath/changeKind/env)
 * @returns {null | { humanLine:string, aiNote:string, verdict:object }}
 */
function buildWeakModelAdvisory(input = {}) {
  try {
    const v = assessWeakModelChange(input);
    if (!v) return null; // 门关/入参不全/异常
    // 强档或普通文件放行 → 不打扰(静默,保持消费方逐字节等价)。
    if (v.reason === 'strong-model') return null;
    if (v.allow === true && v.risk === 'normal' && !v.requireConfirm) return null;

    const rel = _norm(input && input.filePath);
    const tierTxt = v.tier ? `弱能力档(${v.tier})` : '能力档未知';

    if (v.allow === false) {
      // 弱档改红线:该编辑已发生(本闸事后顾问,不硬拦),强提醒交强模型复核。
      return {
        verdict: v,
        humanLine: `⚠️ 弱模型改动红线文件:${rel}\n   ${tierTxt}直接改了「${v.risk}」级文件——建议交强模型复核这次改动是否安全。`,
        aiNote: `[WEAK-MODEL-EDIT-GUARD] 你(${tierTxt})刚改动了红线文件 ${rel}(风险级:${v.risk})。`
          + `红线文件(密钥/发布·CI/版本三源/权限核心/.git)一旦改错会无声破坏仓库可发布性,`
          + `请自查这次改动是否必要且正确;若不确定,应把这个改动交由更强的模型复核。`,
      };
    }
    // requireConfirm:true(弱档改敏感核心,或档未知碰红线/敏感)。
    return {
      verdict: v,
      humanLine: `ℹ️ 敏感文件改动待确认:${rel}\n   ${tierTxt}改了「${v.risk}」级文件——请过目确认这次改动无误。`,
      aiNote: `[WEAK-MODEL-EDIT-GUARD] 你(${tierTxt})改动了敏感核心文件 ${rel}(风险级:${v.risk})。`
        + `这类 god-file 级核心改坏影响面大,请复核本次改动并在提交前请人确认。`,
    };
  } catch {
    return null; // 绝不因格式化异常阻断正常流程
  }
}

module.exports = {
  classifyChangeRisk,
  assessWeakModelChange,
  weakModelChangeGuardEnabled,
  buildWeakModelAdvisory,
  // 内部逃生阀(测试用):
  _internals: { RED_LINE_PATTERNS, SENSITIVE_PATTERNS, _isWeakTier, _resolveTier },
};
