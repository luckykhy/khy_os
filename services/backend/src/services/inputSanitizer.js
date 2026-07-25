'use strict';

/**
 * inputSanitizer.js — 用户输入预处理（清洗 / 结构化 / 矫正），规范见
 * docs/03_DESIGN_设计/[DESIGN-ARCH-018] 用户输入预处理规范.md。
 *
 * 目的：把用户「乱输入」里的**纯噪声**（控制字符、零宽字符、乱码替换符、刷屏式
 * 重复标点、过量空白/空行、连续重复行）在送入模型前过滤掉，从而降低 token 消耗、
 * 提升模型对有效内容的聚焦。
 *
 * 设计纪律（防呆，硬约束）：
 *   1. 绝不修改有效信息：只删除/折叠确定性的噪声；字母与数字的字符级内容一律不动
 *      （避免把 "10000000" 折成 "1000" 这类语义破坏）；代码块（``` 围栏与 `行内代码`）
 *      整段保护、原样还原。
 *   2. 失败/可疑即回退原文：任何异常、或处理后内容退化（变空 / 丢失全部字母数字/CJK
 *      内容）一律返回原始输入，绝不阻断主流程。
 *   3. 纯规则、零模型调用：本模块不调用任何 LLM（那会反向消耗 token），全部是确定性
 *      字符串变换，幂等（sanitize(sanitize(x)) === sanitize(x)）。
 *   4. 只新增、可配置、默认保守：通过 env / JSON 配置开关与阈值；默认开启但阈值保守，
 *      正常输入零改动。主开关 KHY_INPUT_SANITIZE=0 可整体关闭。
 *
 * 注：所有噪声字符均用 new RegExp + 反斜杠转义表达，保持本文件为纯 ASCII 源（不嵌入
 *     控制/零宽字节）。零外部依赖（仅 Node 内置 + 本仓既有可选模块）。
 */

const path = require('path');

// ── 默认配置（全部可经 env / JSON 覆盖）──────────────────────────────────────
const DEFAULTS = Object.freeze({
  enabled: true,
  stripControlChars: true,     // 删除控制字符（保留 \n \t）
  stripZeroWidth: true,        // 删除零宽字符
  stripReplacementChar: true,  // 删除 U+FFFD 乱码替换符
  collapseWhitespace: true,    // 行内多空格/制表符 → 单空格
  maxBlankLines: 1,            // 连续空行上限（≥2 个空行折叠为该数）
  collapsePunctRun: true,      // 折叠刷屏标点
  maxPunctRun: 4,              // 同一标点连续 ≥ 此数才折叠
  punctRunKeep: 3,             // 折叠后保留个数
  collapseLetterRuns: false,   // 字母长串折叠（默认关，保守；数字永不折叠）
  maxLetterRun: 8,
  letterRunKeep: 3,
  dedupLines: true,            // 连续重复行去重
  maxLineRepeat: 3,            // 同一行连续重复 ≥ 此数才折叠
  lineRepeatKeep: 3,           // 折叠后保留行数
  trimTrailingWs: true,        // 行尾空白清除
  maxInputChars: 200000,       // 超长输入跳过（防呆，避免极端正则开销）
});

// ── 噪声字符类（全部 new RegExp + \u 转义，纯 ASCII 源）────────────────────────
// 控制字符：除 \t(09) \n(0A) 外的 C0 控制符 + DEL(7F)
const RE_CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
// 零宽字符 + BOM + word joiner + 软连字符
const RE_ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\uFEFF\\u2060\\u00AD]', 'g');
// 乱码替换符 U+FFFD
const RE_REPLACEMENT = new RegExp('\\uFFFD', 'g');
// 各类异常空白（不含换行）→ 普通空格（含不间断空格、各类 em/en 空格、表意空格）
const RE_WEIRD_SPACE = new RegExp('[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]', 'g');
// 内容指纹：字母/数字/CJK（含日文假名、韩文）有效内容
const RE_ESSENTIAL = new RegExp('[A-Za-z0-9\\u4E00-\\u9FFF\\u3040-\\u30FF\\uAC00-\\uD7A3]');
// 字母长串折叠目标（含 CJK 表意文字）；**不含 \d**，数字永不折叠
const RE_LETTER_RUN = new RegExp('([A-Za-z\\u4E00-\\u9FFF])\\1+', 'g');
// 代码占位符：用私有区(PUA, Unicode 类别 Co)字符包裹——不属控制/零宽/空白/标点/符号
// /字母，故清洗管线任一规则都不会触碰它，保证占位符在清洗后仍可被原样还原。
const PH_HEAD = String.fromCharCode(0xE000) + 'KHYCODE';
const PH_TAIL = String.fromCharCode(0xE001);
const RE_PLACEHOLDER = new RegExp('\\uE000KHYCODE(\\d+)\\uE001', 'g');

function _int(v, def) {
  const n = parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 0 ? n : def;
}
// 布尔解析统一走 parseBoolean 单一真源（base tier：1/true/yes/on ↔ 0/false/no/off，
// 不含 y/n 简写）。此前此处内联同一套 token 集，与其他模块各自维护易漂移。
const _parseBoolean = require('../utils/parseBoolean');
function _bool(v, def) {
  return _parseBoolean(v, def, { extended: false });
}

/**
 * 解析配置：DEFAULTS ← JSON 文件（getDataHome()/input_sanitizer.json）← env 覆盖。
 * 任何一步失败都安全降级到上一层，绝不抛。
 * @param {object} [env=process.env]
 * @returns {object}
 */
function loadConfig(env = process.env) {
  let cfg = { ...DEFAULTS };
  // ① JSON 文件（可选，镜像 featureFlags 的取法）
  try {
    const { getDataHome } = require('../utils/dataHome');
    const file = path.join(getDataHome(), 'input_sanitizer.json');
    const fs = require('fs');
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && typeof json === 'object') cfg = { ...cfg, ...json };
    }
  } catch { /* 文件缺失/损坏 → 用默认 */ }

  // ② env 覆盖（KHY_INPUT_SANITIZE* ）
  cfg.enabled = _bool(env.KHY_INPUT_SANITIZE, cfg.enabled);
  cfg.maxBlankLines = _int(env.KHY_INPUT_SANITIZE_MAX_BLANK_LINES, cfg.maxBlankLines);
  cfg.maxPunctRun = _int(env.KHY_INPUT_SANITIZE_MAX_PUNCT_RUN, cfg.maxPunctRun);
  cfg.punctRunKeep = _int(env.KHY_INPUT_SANITIZE_PUNCT_KEEP, cfg.punctRunKeep);
  cfg.collapseLetterRuns = _bool(env.KHY_INPUT_SANITIZE_LETTER_RUNS, cfg.collapseLetterRuns);
  cfg.maxLineRepeat = _int(env.KHY_INPUT_SANITIZE_MAX_LINE_REPEAT, cfg.maxLineRepeat);
  return cfg;
}

// ── 代码块保护（结构化前抽出，还原前放回）──────────────────────────────────
// 把 ```fenced``` 与 `inline` 代码替换为占位符，保证其内容**绝不**被清洗改动。
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_RE = /`[^`\n]+`/g;

function _protectCode(text) {
  const store = [];
  const sub = (m) => { store.push(m); return `${PH_HEAD}${store.length - 1}${PH_TAIL}`; };
  let out = text.replace(FENCE_RE, sub);
  out = out.replace(INLINE_RE, sub);
  return { out, store };
}

function _restoreCode(text, store) {
  RE_PLACEHOLDER.lastIndex = 0;
  return text.replace(RE_PLACEHOLDER, (m, i) => {
    const idx = Number(i);
    return store[idx] != null ? store[idx] : m;
  });
}

// ── 单字符运行折叠（仅标点/符号；字母数字永不动）──────────────────────────
// 通过 Unicode 属性匹配标点(P)与符号(S)；刷屏式重复属噪声。
let RE_PUNCT_RUN = null;
try {
  // u 标志 + \p 属性需 Node ≥ 10；用 try 兜底极旧环境。
  RE_PUNCT_RUN = new RegExp('([\\p{P}\\p{S}])\\1+', 'gu');
} catch { RE_PUNCT_RUN = null; }

function _collapsePunctRuns(text, cfg) {
  if (!cfg.collapsePunctRun || !RE_PUNCT_RUN) return text;
  return text.replace(RE_PUNCT_RUN, (m, ch) => {
    if (m.length >= cfg.maxPunctRun) return ch.repeat(Math.min(cfg.punctRunKeep, m.length));
    return m;
  });
}

// 可选：字母长串折叠（默认关）。**永不**作用于数字（RE_LETTER_RUN 不含 \d）。
function _collapseLetterRuns(text, cfg) {
  if (!cfg.collapseLetterRuns) return text;
  return text.replace(RE_LETTER_RUN, (m, ch) => {
    if (m.length >= cfg.maxLetterRun) return ch.repeat(Math.min(cfg.letterRunKeep, m.length));
    return m;
  });
}

// ── 连续重复行去重 ──────────────────────────────────────────────────────────
function _dedupLines(text, cfg) {
  if (!cfg.dedupLines) return text;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    let run = 1;
    while (i + run < lines.length && lines[i + run] === cur) run++;
    if (cur.trim() !== '' && run >= cfg.maxLineRepeat) {
      for (let k = 0; k < Math.min(cfg.lineRepeatKeep, run); k++) out.push(cur);
    } else {
      for (let k = 0; k < run; k++) out.push(cur);
    }
    i += run;
  }
  return out.join('\n');
}

/**
 * 估算 token（复用底座既有启发式；不可用时退化为 len/4）。
 * @param {string} s
 * @returns {number}
 */
function _estimateTokens(s) {
  try {
    return require('./textHeuristics').estimateTokens(String(s || ''));
  } catch {
    return Math.ceil(String(s || '').length / 4);
  }
}

/**
 * 核心清洗管线（已剥离回退判定）。纯函数。
 * 顺序：保护代码 → 清洗字符 → 矫正(标点/字母折叠) → 结构化(空白/空行/重复行) → 还原代码。
 * @param {string} text
 * @param {object} cfg
 * @returns {string}
 */
function _runPipeline(text, cfg) {
  const { out, store } = _protectCode(text);
  let s = out;

  // ── 清洗：删除纯噪声字符 ──
  if (cfg.stripControlChars) s = s.replace(RE_CONTROL, '');
  if (cfg.stripZeroWidth) s = s.replace(RE_ZERO_WIDTH, '');
  if (cfg.stripReplacementChar) s = s.replace(RE_REPLACEMENT, '');
  s = s.replace(RE_WEIRD_SPACE, ' ');

  // ── 矫正：刷屏标点 / 可选字母长串 ──
  s = _collapsePunctRuns(s, cfg);
  s = _collapseLetterRuns(s, cfg);

  // ── 结构化：行内空白、行尾空白、空行、重复行 ──
  if (cfg.collapseWhitespace) s = s.replace(/[ \t]{2,}/g, ' ');
  if (cfg.trimTrailingWs) s = s.replace(/[ \t]+$/gm, '');
  if (cfg.maxBlankLines >= 0) {
    const max = cfg.maxBlankLines;
    // 连续 (max+2) 个以上换行（= max+1 个以上空行）折叠为 max+1 个换行（保留 max 个空行）
    const re = new RegExp(`\\n{${max + 2},}`, 'g');
    s = s.replace(re, '\n'.repeat(max + 1));
  }
  s = _dedupLines(s, cfg);

  // 整体首尾空白。用原生 trim() 而非 /^\s+|\s+$/g:后者的 `\s+$` 贪婪吞掉内部空白串后,
  // 尾锚 `$` 失败会在每个起点回溯 → O(n^2)。前面的清洗只折叠 [ \t] 与 \n,**不触碰**
  // U+000D(CR,RE_CONTROL 的 0E-1F 区间不含它)、U+2028(行分隔)、U+2029(段分隔)
  // ——这三者仍属 \s,一段超长 CR/LS/PS 串(粘贴乱码常见)到此处即冻结(实测 CR x100k
  // → 8.6s,LS x80k → 10.6s;maxInputChars=200000 上限拦不住 O(n^2),200k → 约 34s)。
  // sanitizeForModel 在 cli/ai.js:5061 对 raw userMessage 调用 → 真 user-reachable DoS。
  // trim() 语义与该正则逐字节等价(裁剪首尾空白),但原生 O(n)(见 inputSanitizerTrimRedos
  // 守卫:battery + 5000 例随机 fuzz 证等价)。本注释保持纯 ASCII 源(不嵌入分隔符字节)。
  s = s.trim();

  return _restoreCode(s, store);
}

/**
 * 预处理用户输入。永不抛；任何异常或退化都回退原文。
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {object} [opts.config] - 覆盖配置（否则 loadConfig()）
 * @returns {{ original:string, sanitized:string, changed:boolean, fellBack:boolean,
 *            reason:string, stats:object }}
 */
function sanitize(input, opts = {}) {
  const original = typeof input === 'string' ? input : (input == null ? '' : String(input));
  const cfg = opts.config || loadConfig();
  const base = {
    original,
    sanitized: original,
    changed: false,
    fellBack: false,
    reason: 'noop',
    stats: _stats(original, original),
  };

  // 关闭 / 空白 / 超长 → 原样返回
  if (!cfg.enabled) return { ...base, reason: 'disabled' };
  if (!original || original.trim() === '') return { ...base, reason: 'empty' };
  if (original.length > cfg.maxInputChars) return { ...base, reason: 'too-large' };

  let sanitized;
  try {
    sanitized = _runPipeline(original, cfg);
  } catch (e) {
    return { ...base, fellBack: true, reason: `error:${e.message}` };
  }

  // ── 回退判定（防呆）──
  if (sanitized === original) return { ...base, reason: 'unchanged' };
  if (!sanitized || sanitized.trim() === '') {
    return { ...base, fellBack: true, reason: 'degenerate-empty' };
  }
  // 原文有有效内容（字母/数字/CJK）但结果全无 → 回退
  if (RE_ESSENTIAL.test(original) && !RE_ESSENTIAL.test(sanitized)) {
    return { ...base, fellBack: true, reason: 'essential-lost' };
  }

  return {
    original,
    sanitized,
    changed: true,
    fellBack: false,
    reason: 'sanitized',
    stats: _stats(original, sanitized),
  };
}

function _stats(before, after) {
  const beforeTokens = _estimateTokens(before);
  const afterTokens = _estimateTokens(after);
  return {
    beforeChars: before.length,
    afterChars: after.length,
    savedChars: before.length - after.length,
    beforeTokens,
    afterTokens,
    savedTokens: beforeTokens - afterTokens,
  };
}

/**
 * 便捷接口：返回可直接送入模型的字符串。永不抛；回退时即原文。
 * 用于在输入流程中一行接入（设计 §4）。
 *
 * @param {string} input
 * @param {object} [opts] - { config?, onStats?(result) }
 * @returns {string}
 */
function sanitizeForModel(input, opts = {}) {
  let res;
  try {
    res = sanitize(input, opts);
  } catch {
    return typeof input === 'string' ? input : (input == null ? '' : String(input));
  }
  if (typeof opts.onStats === 'function') {
    try { opts.onStats(res); } catch { /* 观测回调失败不影响主流程 */ }
  }
  return res.fellBack ? res.original : res.sanitized;
}

module.exports = {
  loadConfig,
  sanitize,
  sanitizeForModel,
  DEFAULTS,
  // 测试缝（内部纯函数）
  _runPipeline,
  _protectCode,
  _restoreCode,
  _estimateTokens,
};
