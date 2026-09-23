'use strict';

/**
 * promptFreshness.js — 纯叶子:为「会话内看似稳定、实则依赖可变的磁盘/进程状态」的系统提示段
 * 计算**新鲜度戳(freshness stamp)**,用作 `systemPromptSection` 的 cacheKey。
 *
 * 背景(承 [DESIGN-ARCH-098] §7 改动 1–3 / CONCERNS.staleKey):段缓存按 id 存**一条**记录,
 * cacheKey 不变即永不重算。三处段因此被冻结在会话首轮,与它们自己声明的易变性矛盾:
 *
 *   git_status          声明「工作树一变即变」——cacheKey 却只有 cwd      → 会话内永不刷新
 *   project_instructions 声明注入 khy.md/CLAUDE.md/AGENTS.md——键只有 cwd → 改了文件不生效
 *   skill_catalog        声明列出已装技能——键只有 contextWindowTokens    → 新装技能不出现
 *
 * 本叶子把「该折入什么」变成可单测的纯函数;真正的 IO(statSync / 目录发现 / 技能表读取)
 * 由 prompts.js 在调用侧完成并**作为参数传入**,因此本模块自身零 IO、可确定性重放。
 *
 * 契约:纯/确定性(时间由调用方以 now/ttlMs 传入,不使用 Date.now())、零文件与网络 IO、
 * 绝不抛(坏输入 → '' 或安全回退值,调用方据此回退到旧键)。
 *
 * 门控:
 *  - KHY_PROMPT_FRESH_KEYS(默认**开**,仅显式 0/false/off/no 关):关 → 调用方回退旧键
 *    (cwd / contextWindowTokens),段缓存行为与今日逐字节一致。默认开的理由:这三处是**缺陷修复**,
 *    冻结本身是 bug;关掉即逐字节回退到修复前的冻结行为。
 *
 * @module constants/promptFreshness
 */

/** 委派 flagRegistry 判定门控;require 失败 → 保守回退「仅显式 0/false/off/no 关」。绝不抛。 */
const _gateOn = require('../utils/gateOn');

/** 新鲜度键门控名。 */
const FRESH_KEYS_FLAG = 'KHY_PROMPT_FRESH_KEYS';

/** git 状态戳的时间桶宽度 env 名(数字型,直读,先例见 KHY_SKILL_CATALOG_CHARS)。 */
const GIT_STAMP_TTL_ENV = 'KHY_PROMPT_GIT_STAMP_TTL_MS';

/** git 状态戳默认时间桶:30s。 */
const DEFAULT_GIT_STAMP_TTL_MS = 30000;

/**
 * 新鲜度键是否启用。门控 KHY_PROMPT_FRESH_KEYS,默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isFreshKeysEnabled(env) {
  try {
    return _gateOn(FRESH_KEYS_FLAG, env);
  } catch {
    return true;
  }
}

/**
 * git 状态戳的时间桶宽度(ms)。`<=0` / 非法 → 默认 30s;`0` 可显式表示「不要时间桶」
 * (那时键只剩 .git 下两个 mtime,staged/切分支能感知、纯工作区编辑不能)。
 *
 * @param {object} [env]
 * @returns {number}
 */
function gitStampTtlMs(env) {
  try {
    const raw = String((env || process.env)[GIT_STAMP_TTL_ENV] || '').trim();
    if (raw === '0') {
      return 0;
    }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_GIT_STAMP_TTL_MS;
  } catch {
    return DEFAULT_GIT_STAMP_TTL_MS;
  }
}

/**
 * FNV-1a 32 位哈希 → 8 位 hex。纯、确定性、无 crypto 依赖(避免 leaf 契约对 crypto 的额外白名单要求)。
 * @param {string} s
 * @returns {string}
 */
function hashString(s) {
  try {
    let h = 0x811c9dc5;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      // h *= 16777619，用位移避免浮点误差
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  } catch {
    return '00000000';
  }
}

/**
 * 由「已采集的 stat 事实」拼一个稳定戳。调用方负责 statSync;本函数纯。
 *
 * @param {Array<{path:string, mtimeMs?:number, size?:number}>} items
 * @returns {string} 空/坏输入 → ''
 */
function stampFromStats(items) {
  try {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }
    const parts = [];
    for (const it of items) {
      if (!it || typeof it.path !== 'string' || !it.path) {
        continue;
      }
      const mt = Number.isFinite(it.mtimeMs) ? it.mtimeMs : -1;
      const sz = Number.isFinite(it.size) ? it.size : -1;
      parts.push(`${it.path}:${mt}:${sz}`);
    }
    return parts.join('|');
  } catch {
    return '';
  }
}

/**
 * git 状态新鲜度戳。纯:时间与 mtime 全部由调用方传入。
 *
 * 语义:`<indexMtime>|<headMtime>|<timeBucket>`
 *  - index/HEAD 的 mtime 捕获「git add / 切分支 / commit」这类立即变化;
 *  - timeBucket 保证**最坏情况**下每 ttlMs 也会重算一次,从而不会像修复前那样永久冻结
 *    (纯工作区编辑不写入 .git,只能靠时间桶兜底)。
 *
 * @param {object} opts
 * @param {number} [opts.indexMtimeMs] .git/index 的 mtime(-1 = 不存在)
 * @param {number} [opts.headMtimeMs]  .git/HEAD 的 mtime(-1 = 不存在)
 * @param {number} [opts.nowMs]        当前时间(ms);由调用方传 Date.now()
 * @param {number} [opts.ttlMs]        时间桶宽度;0 = 不启用时间桶
 * @returns {string} 坏输入 / 无任何有效输入 → ''
 */
function gitStatusStamp(opts) {
  try {
    const o = opts || {};
    const idx = Number.isFinite(o.indexMtimeMs) ? o.indexMtimeMs : -1;
    const head = Number.isFinite(o.headMtimeMs) ? o.headMtimeMs : -1;
    // 两个 mtime 都不存在 ⇒ 不是 git 仓库(或 .git 不可读)→ 返回 '' 让调用方回退旧键,
    // 避免对非 git 目录凭时间桶制造无意义的每 30s 重算。
    if (idx < 0 && head < 0) {
      return '';
    }
    const ttl = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_GIT_STAMP_TTL_MS;
    const now = Number.isFinite(o.nowMs) ? o.nowMs : 0;
    const bucket = ttl > 0 ? Math.floor(now / ttl) : 'off';
    return `${idx}|${head}|${bucket}`;
  } catch {
    return '';
  }
}

/**
 * 技能目录指纹。纯:输入是内存里的技能数组(prompts.js 侧由 `skills.getCachedSkills()` 取得)。
 * 指纹覆盖「段数与 id 集合」+「每个技能的 description 内容哈希」——后者是目录里真正展示的部分,
 * 因此改描述也能立即生效(仅比 id 集合更细,且不引入文件 IO)。
 *
 * @param {Array<object>} skills
 * @returns {string} 空/坏输入 → 'none'
 */
function skillCatalogStamp(skills) {
  try {
    if (!Array.isArray(skills) || skills.length === 0) {
      return 'none';
    }
    const parts = skills.map((s) => {
      const id = String((s && (s.id || s.name)) || '?');
      const desc = String((s && s.description) || '');
      return `${id}:${hashString(desc)}`;
    });
    parts.sort();
    return `n=${skills.length};${parts.join(',')}`;
  } catch {
    return 'none';
  }
}

/** 把多个戳拼成一个键,自动跳过空值。纯。 */
function combineStamp(parts) {
  try {
    if (!Array.isArray(parts)) {
      return '';
    }
    return parts.filter((p) => p != null && String(p) !== '').join('|');
  } catch {
    return '';
  }
}

module.exports = {
  FRESH_KEYS_FLAG,
  GIT_STAMP_TTL_ENV,
  DEFAULT_GIT_STAMP_TTL_MS,
  isFreshKeysEnabled,
  gitStampTtlMs,
  hashString,
  stampFromStats,
  gitStatusStamp,
  skillCatalogStamp,
  combineStamp,
};
