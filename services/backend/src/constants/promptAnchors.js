'use strict';

/**
 * promptAnchors.js — 纯叶子:给系统提示词的每个装配段打上**机器可读锚点**,使「分层」从
 * 隐含的数组位置变成可解析、可计量、可守卫的事实。
 *
 * 背景(承 [DESIGN-ARCH-098] §4.1):分区信息此前**隐式**分散在五处(返回数组位置 /
 * `systemPromptSection` 的 cached 标志 / `promptCacheOrder.VOLATILE_SECTION_IDS` /
 * `ON_DEMAND_PROMPT_SECTION_IDS` / `_memoStaticSection`),靠人工同步。P0 先把「每个段
 * 当前落在哪个槽」显式化——**只加锚点,不搬任何内容**,因此可逐字节回退。
 *
 * 锚点形态(HTML 注释,对模型无副作用、对解析友好):
 *   `<!-- khy:prefix:simple_intro -->`
 *   `<!-- khy:dynamic:project_instructions -->`
 *   `<!-- khy:tail:git_status -->`
 *
 * 槽位(slot)是**现状事实**,不是目标期望:
 *   prefix    位于 __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ 之前
 *   dynamic   位于边界之后、尾部之前
 *   trailing  动态组之后、易变组之前(content_output_guide / base_security)
 *   tail      绝对尾部(易变组 + 按需胶囊)
 * 目标分层(L0–L4)由 [DESIGN-ARCH-098] 定义,在 P2 真正搬动内容后才改这里的 slot 语义。
 *
 * 三个消费者:
 *   1. `scripts/ci/check-prompt-taxonomy.js` → 断言槽位落点单调性、每轮重算字节预算;
 *   2. `constants/promptPrefixShape.js` → 由锚点切分,把「系统提示变了」细化为**哪一段变了**
 *      (对标 Claude Code 的 promptCacheBreakDetection 的 per-section 粒度);
 *   3. 单条注入内容硬上限(对标 Codex CLI 的「单条 ≤10k tokens」)→ findOversizedEntries。
 *
 * 契约:纯/确定性(无时钟、无随机)、零文件与网络 IO、绝不抛(fail-soft:门控关 / 坏输入 →
 * 安全空值,调用方逐字节回退)。
 *
 * 门控:
 *  - KHY_PROMPT_ANCHORS(默认**关**):关 → annotate 不插任何标记 → 装配产物与启用前逐字节一致。
 *    默认关的理由:锚点会进入模型可见文本(约 +1.4KB),P0 阶段只服务于度量与守卫,不应改变线上产物。
 *
 * @module constants/promptAnchors
 */

/** 委派 flagRegistry 判定门控;require 失败 → 保守回退「仅显式 0/false/off/no 关」。绝不抛。 */
const _gateOn = require('../utils/gateOn');

/** 四个槽位(顺序即期望的落点顺序,守卫据此做单调性断言)。 */
const SLOTS = Object.freeze(['prefix', 'dynamic', 'trailing', 'tail']);
const _SLOT_SET = new Set(SLOTS);

/** 锚点门控名。 */
const ANCHOR_FLAG = 'KHY_PROMPT_ANCHORS';

/** 锚点是否启用。门控 KHY_PROMPT_ANCHORS,默认关。 */
function isAnchorEnabled(env) {
  try {
    return _gateOn(ANCHOR_FLAG, env);
  } catch {
    return false;
  }
}

/** 单条注入内容的 token 上限(对标 Codex CLI context/mod.rs 的「≤10k tokens/条目」)。 */
const DEFAULT_ENTRY_MAX_TOKENS = 10000;

/** 环境变量覆盖名(与 KHY_SKILL_CATALOG_CHARS 同款「数字型 env 直读」先例)。 */
const ENTRY_MAX_TOKENS_ENV = 'KHY_PROMPT_ENTRY_MAX_TOKENS';

/**
 * 读单条上限;`<=0` / 非数字 / 缺省 → DEFAULT_ENTRY_MAX_TOKENS。绝不抛。
 * @param {object} [env]
 * @returns {number}
 */
function entryMaxTokens(env) {
  try {
    const raw = parseInt(String((env || process.env)[ENTRY_MAX_TOKENS_ENV] || ''), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ENTRY_MAX_TOKENS;
  } catch {
    return DEFAULT_ENTRY_MAX_TOKENS;
  }
}

/** 单条锚点标记。id 只保留 [A-Za-z0-9_] 以免破坏注释语法。 */
function marker(slot, id) {
  const s = _SLOT_SET.has(slot) ? slot : 'unknown';
  const safeId = String(id || 'anon').replace(/[^A-Za-z0-9_]/g, '_');
  return `<!-- khy:${s}:${safeId} -->`;
}

/** 匹配任意锚点标记。 */
const ANCHOR_RE = /<!--\s*khy:([a-z_]+):([A-Za-z0-9_]+)\s*-->/g;

/**
 * 估算一段文本的 token 数(偏保守,宁可高估)。
 * 中日韩字符按 1 token/字(实测 CJK 约 1–1.7 字/token),其余按 4 字符/token
 * (与 prompts.js::getSkillCatalogSection 的 CHARS_PER_TOKEN 先例一致)。
 * 保守方向的选择理由:超限告警宁可早报,不可漏报。
 *
 * @param {string} text
 * @returns {number} 估算 token(负输入/坏输入 → 0)
 */
function estimateTokens(text) {
  try {
    const s = String(text == null ? '' : text);
    if (!s) {
      return 0;
    }
    let cjk = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (
        (c >= 0x3000 && c <= 0x303f) || // CJK 标点
        (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
        (c >= 0x4e00 && c <= 0x9fff) || // 基本区
        (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
        (c >= 0xff00 && c <= 0xffef) || // 全角
        (c >= 0x20000 && c <= 0x3ffff) // 扩展 B+
      ) {
        cjk += 1;
      }
    }
    const rest = [...s].length - cjk;
    return cjk + Math.ceil(rest / 4);
  } catch {
    return 0;
  }
}

/**
 * 把「描述符数组」渲染成装配数组。
 *
 * @param {Array<{slot:string, id:(string|null), text:(string|null)}>} entries
 * @param {object} [env]
 * @returns {string[]} 门控关 / 无 entries → 纯 text 数组(与今日逐字节一致,且已滤 null)
 */
function annotate(entries, env) {
  try {
    if (!Array.isArray(entries)) {
      return [];
    }
    const on = isAnchorEnabled(env);
    const out = [];
    for (const e of entries) {
      if (!e || e.text == null) {
        continue;
      }
      if (on && e.id) {
        out.push(marker(e.slot, e.id));
      }
      out.push(e.text);
    }
    return out;
  } catch {
    return Array.isArray(entries)
      ? entries.filter((e) => e && e.text != null).map((e) => e.text)
      : [];
  }
}

/**
 * 解析装配产物里的锚点,给出每段的槽位、id 与字符数。
 * 无锚点的输入 → 返回空 entries(调用方据此判定「未打锚点」,不报错)。
 *
 * @param {string} system 装配后的系统提示串
 * @returns {{entries:Array<{slot:string,id:string,bytes:number}>}}
 */
function parseAnchors(system) {
  try {
    const s = String(system == null ? '' : system);
    const marks = [];
    ANCHOR_RE.lastIndex = 0;
    let m;
    while ((m = ANCHOR_RE.exec(s)) !== null) {
      marks.push({ slot: m[1], id: m[2], markerStart: m.index, bodyStart: m.index + m[0].length });
    }
    const entries = [];
    for (let i = 0; i < marks.length; i += 1) {
      const cur = marks[i];
      // 段正文直到下一个锚点(或串尾);再减去锚点行自带的前后换行,得到净字符数。
      const end = i + 1 < marks.length ? marks[i + 1].markerStart : s.length;
      const body = s.slice(cur.bodyStart, end);
      entries.push({
        slot: cur.slot,
        id: cur.id,
        bytes: body.replace(/^\n+|\n+$/g, '').length,
      });
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

/**
 * 按槽位汇总字符数与段数。
 * @param {string} system
 * @returns {{bySlot:Object<string,{count:number,bytes:number}>, total:number, anchored:boolean}}
 */
function summarizeBySlot(system) {
  const empty = { bySlot: {}, total: 0, anchored: false };
  try {
    const { entries } = parseAnchors(system);
    if (entries.length === 0) {
      return empty;
    }
    const bySlot = {};
    for (const slot of SLOTS) {
      bySlot[slot] = { count: 0, bytes: 0 };
    }
    let total = 0;
    for (const e of entries) {
      if (!bySlot[e.slot]) {
        bySlot[e.slot] = { count: 0, bytes: 0 };
      }
      bySlot[e.slot].count += 1;
      bySlot[e.slot].bytes += e.bytes;
      total += e.bytes;
    }
    return { bySlot, total, anchored: true };
  } catch {
    return empty;
  }
}

/**
 * 按锚点切出各段原文,找出超过单条 token 上限的段
 * (对标 Codex CLI `core/context/mod.rs` 的「条目 ≤10k tokens」硬规则)。
 *
 * 无锚点输入 → 空数组(无法逐段计量;fail-soft 不误报,而不是把整串当成一段)。
 *
 * @param {string} system 装配后的系统提示串(需带锚点)
 * @param {number} [maxTokens] 上限;非法/缺省 → DEFAULT_ENTRY_MAX_TOKENS
 * @returns {Array<{slot:string,id:string,bytes:number,tokens:number,maxTokens:number}>}
 */
function findOversizedEntries(system, maxTokens) {
  try {
    const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_ENTRY_MAX_TOKENS;
    const s = String(system == null ? '' : system);
    const marks = [];
    ANCHOR_RE.lastIndex = 0;
    let m;
    while ((m = ANCHOR_RE.exec(s)) !== null) {
      marks.push({
        slot: m[1],
        id: m[2],
        markerStart: m.index,
        bodyStart: m.index + m[0].length,
      });
    }
    const out = [];
    for (let i = 0; i < marks.length; i += 1) {
      // 段正文 = 锚点之后到**下一个锚点的起点**;不能用下一段的 bodyStart,否则会把下一个
      // 锚点标记本身算进本段字节数(单测已捕获该 off-by-marker 缺陷)。
      const end = i + 1 < marks.length ? marks[i + 1].markerStart : s.length;
      const body = s.slice(marks[i].bodyStart, end).replace(/^\n+|\n+$/g, '');
      const tokens = estimateTokens(body);
      if (tokens > cap) {
        out.push({ slot: marks[i].slot, id: marks[i].id, bytes: body.length, tokens, maxTokens: cap });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 只含一个锚点标记的行(用于按行判定的回退路径)。 */
const ANCHOR_LINE_RE = /^<!--\s*khy:[a-z_]+:[A-Za-z0-9_]+\s*-->$/;

/**
 * 某个装配元素是否**本身就是锚点标记**(而非含标记的正文)。
 * 供 `assembleSystemPrompt` 在扁平化时过滤掉锚点——与它已过滤 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
 * 的做法一致,使「扁平输出」在开/关锚点两种情况下**逐字节相同**(不必依赖字符串还原)。
 *
 * @param {*} element
 * @returns {boolean}
 */
function isAnchorMarker(element) {
  try {
    return element != null && ANCHOR_LINE_RE.test(String(element).trim());
  } catch {
    return false;
  }
}

/**
 * 去掉装配产物里的锚点标记,**还原为未打锚点的形态**。
 *
 * 实现用「按分隔符切开 → 丢掉纯标记元素 → 原分隔符重连」,而不是正则删除:标记本身是
 * 独立的装配元素、由分隔符连接,正则删除会留下多余的空行,导致 strip 结果与未打锚点的
 * 产物**不逐字节相等**(那正是 P0「零产物变更」要保证的不变量)。
 *
 * 分隔符必须与装配时一致:`assembleSystemPrompt` 用 `'\n\n'`(默认值即此);若调用方
 * 以其它分隔符拼接,须显式传入,否则退化为「按行过滤标记行」的近似还原。
 *
 * @param {string} system
 * @param {string} [separator='\n\n'] 装配时使用的分隔符
 * @returns {string} 坏输入 → ''
 */
function stripAnchors(system, separator) {
  try {
    const s = String(system == null ? '' : system);
    const sep = typeof separator === 'string' && separator ? separator : '\n\n';
    const parts = s.split(sep);
    const hasMarkerPart = parts.some((p) => ANCHOR_LINE_RE.test(p.trim()));
    if (hasMarkerPart) {
      return parts.filter((p) => !ANCHOR_LINE_RE.test(p.trim())).join(sep);
    }
    // 分隔符不匹配(或标记不是独立元素)→ 逐行过滤的近似还原
    return s
      .split('\n')
      .filter((line) => !ANCHOR_LINE_RE.test(line.trim()))
      .join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  ANCHOR_FLAG,
  DEFAULT_ENTRY_MAX_TOKENS,
  ENTRY_MAX_TOKENS_ENV,
  SLOTS,
  marker,
  ANCHOR_RE,
  isAnchorMarker,
  isAnchorEnabled,
  entryMaxTokens,
  estimateTokens,
  annotate,
  parseAnchors,
  summarizeBySlot,
  findOversizedEntries,
  stripAnchors,
};
