'use strict';

/**
 * sessionRecapCjk.js — 会话回顾(/recap)的 CJK 抽取纯叶子。
 *
 * **背景(真实缺口·数据级证实)**:`sessionRecapService` 的抽取器全是英文正则
 * (`_extractDecisions` 认 `I'll|Let me`、`_extractInsights` 认 `important|note`、
 * `_extractOpenQuestions` 只认 ASCII `?`);而 khy 是**中文优先**工具——assistant 用
 * 中文说话。于是对真实的中文会话,`decisions/keyInsights/openQuestions` 三段**全空**,
 * 文件名还被全角标点(`。，；！？`)截断(`proxyUriParsers.js。` 抓不到)。`/recap`
 * 命令在、接线全,却对 khy 实际运行的语言**产不出内容** —— 这就是「缺少了 recap」。
 *
 * **本叶子职责**:提供 CJK 补充抽取,与既有英文抽取**加性合并**(union),绝不替换。
 * 纯函数、零 IO、绝不抛(异常保守返回空)。确定性:同输入同输出,无模型无网络。
 *
 * **门控 `KHY_RECAP_CJK`(default-on)**:关 → 所有 helper 返回空数组/空集 → 服务侧
 * union 空 → 抽取结果**逐字节回退**到原英文行为。sibling 门(问题类),不进
 * flagRegistry(同家族先例)。
 *
 * ── HOW-TO-EXTEND(抄写式)──────────────────────────────────────────────
 * 新增一类中文触发词:往对应冻结数组(_CJK_DECISION_MARKERS / _CJK_INSIGHT_MARKERS)
 * 加词干即可,词干须是**动作/断言**前缀(如「重构」「回滚」),抽取取该词干起 6..60 字。
 * 新增标点边界:往 _CJK_TERMINATORS 加字符。所有改动会被 sessionRecapCjk.test.js 锁定。
 * ─────────────────────────────────────────────────────────────────────
 *
 * @module sessionRecapCjk
 */

// ── 门控 ────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

function _cjkEnabled(env) {
  const raw = env && env.KHY_RECAP_CJK;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 中文触发词(冻结·SSOT)────────────────────────────────────────────
// 决策类:表达「做了什么/决定怎么做」的动作/断言前缀。
const _CJK_DECISION_MARKERS = Object.freeze([
  '我将', '我会', '我已', '我打算', '我准备',
  '决定', '采用', '选择', '选用', '改用',
  '创建', '新增', '新建', '写了', '写好', '添加',
  '更新', '修复', '修正', '修改', '删除', '移除', '重构', '回滚', '拆分',
]);

// 洞见类:表达「关键事实/根因/原因」的前缀。
const _CJK_INSIGHT_MARKERS = Object.freeze([
  '重要', '注意', '关键', '要点', '值得注意', '切记',
  '根本原因', '根因', '问题在于', '问题是', '原因是', '原因在于',
  '因为', '之所以', '本质上', '实际上',
]);

// CJK 句子终结符(全角标点)。既作问句切分,也作文件名右边界。
const _CJK_TERMINATORS = Object.freeze(['。', '！', '？', '；', '，', '、', '：', '\n']);

// 上限(与英文侧对齐,合并后再各自截断)。
const _MAX_DECISIONS = 10;
const _MAX_INSIGHTS = 5;
const _MAX_QUESTIONS = 5;
const _MAX_FILES = 30;

// ── 工具:含子去重 ─────────────────────────────────────────────────
// 多个词干可能命中同一句(如「我已经创建了 X」既中「我已」又中「创建」),产出彼此
// 包含的片段。收敛策略:只保留最完整者 —— 候选被已有片段包含则丢弃;候选包含某已有
// 片段则替换之(取最长)。保证同一断言只出现一次。
function _pushContainmentUnique(out, frag) {
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].includes(frag)) return; // 已有更完整的
    if (frag.includes(out[i])) { out[i] = frag; return; } // 候选更完整
  }
  out.push(frag);
}

// ── 工具:构造「以词干起、到下个终结符止」的片段 ──────────────────────
function _terminatorClass() {
  // 转义后拼成字符类;\n 直接放入。
  const chars = _CJK_TERMINATORS.map((t) => (t === '\n' ? '\\n' : t)).join('');
  return chars;
}

function _sliceFromMarker(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const rest = text.slice(idx);
  // 到下一个终结符为止。
  let end = rest.length;
  for (const t of _CJK_TERMINATORS) {
    const p = rest.indexOf(t, marker.length);
    if (p >= 0 && p < end) end = p;
  }
  const frag = rest.slice(0, end).trim();
  return frag;
}

/**
 * 从 assistant 中文消息抽取「决策」片段。
 * @param {Array<{role:string,content:string}>} assistantMessages
 * @param {object} [env]
 * @returns {string[]} 门关或异常 → []
 */
function extractCjkDecisions(assistantMessages, env) {
  try {
    if (!_cjkEnabled(env || process.env)) return [];
    if (!Array.isArray(assistantMessages)) return [];
    const out = [];
    const seen = new Set();
    for (const msg of assistantMessages) {
      const text = (msg && msg.content) || '';
      if (!text) continue;
      for (const marker of _CJK_DECISION_MARKERS) {
        // 一条消息里同一词干可能出现多次;用 while 扫。
        let from = 0;
        for (;;) {
          const idx = text.indexOf(marker, from);
          if (idx < 0) break;
          from = idx + marker.length;
          const frag = _sliceFromMarker(text.slice(idx), marker);
          if (!frag) continue;
          // 片段须至少含词干 + 若干实义字符。
          if (frag.length < marker.length + 3 || frag.length > 60) continue;
          const key = frag.slice(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);
          _pushContainmentUnique(out, frag);
          if (out.length >= _MAX_DECISIONS) return out;
        }
      }
    }
    return out;
  } catch { return []; }
}

/**
 * 从 assistant 中文消息抽取「洞见/根因」片段。
 * @param {Array<{role:string,content:string}>} assistantMessages
 * @param {object} [env]
 * @returns {string[]}
 */
function extractCjkInsights(assistantMessages, env) {
  try {
    if (!_cjkEnabled(env || process.env)) return [];
    if (!Array.isArray(assistantMessages)) return [];
    const out = [];
    const seen = new Set();
    // 与英文侧一致:只看最近若干条 assistant 消息。
    const recent = assistantMessages.slice(-5);
    for (const msg of recent) {
      const text = (msg && msg.content) || '';
      if (!text) continue;
      for (const marker of _CJK_INSIGHT_MARKERS) {
        const frag = _sliceFromMarker(text, marker);
        if (!frag) continue;
        if (frag.length < marker.length + 3 || frag.length > 80) continue;
        const key = frag.slice(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        _pushContainmentUnique(out, frag);
        if (out.length >= _MAX_INSIGHTS) return out;
      }
    }
    return out;
  } catch { return []; }
}

/**
 * 从最近消息抽取「中文问句」(以 ？ 结尾,或含 吗/呢 语气)。
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [env]
 * @returns {string[]}
 */
function extractCjkQuestions(messages, env) {
  try {
    if (!_cjkEnabled(env || process.env)) return [];
    if (!Array.isArray(messages)) return [];
    const out = [];
    const seen = new Set();
    const recent = messages.slice(-6);
    const termClass = _terminatorClass();
    // 以任意终结符切句,取以「？」结尾的句子。
    const splitter = new RegExp('[' + termClass + ']');
    for (const msg of recent) {
      const text = (msg && msg.content) || '';
      if (!text) continue;
      // 把全角/半角问号统一为切句锚:先按终结符+？切。
      const chunks = text.split(splitter);
      // split 丢了分隔符,故用正则重新扫「……？」
      const qRe = /([^。！？；，、：\n]{4,60})？/g;
      let m;
      while ((m = qRe.exec(text)) !== null) {
        const clean = (m[1] + '？').trim();
        if (clean.length < 5 || clean.length > 62) continue;
        const key = clean.slice(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
        if (out.length >= _MAX_QUESTIONS) return out;
      }
      void chunks; // 保留切句变量的语义说明(上方 qRe 才是真抽取)
    }
    return out;
  } catch { return []; }
}

/**
 * CJK 标点感知的文件名抽取:补齐被全角标点(。，；！？、)截断而漏掉的引用。
 * 与英文侧 union(服务侧合并去重)。
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [env]
 * @returns {string[]}
 */
function extractCjkFileReferences(messages, env) {
  try {
    if (!_cjkEnabled(env || process.env)) return [];
    if (!Array.isArray(messages)) return [];
    const files = [];
    const seen = new Set();
    // 左边界:行首/空白/反引号/引号/CJK 标点;右边界:同上 + CJK 终结符 + 行尾。
    // 文件名本体:与英文侧一致的保守集合。
    const fileRe = /(?:^|[\s`"'。，；！？、（）「」【】：])([a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.[a-zA-Z]{1,6})(?=$|[\s`"'。，；！？、（）「」【】：])/gm;
    for (const msg of messages) {
      const text = (msg && msg.content) || '';
      if (!text) continue;
      let m;
      while ((m = fileRe.exec(text)) !== null) {
        const f = m[1];
        if (f.includes('http') || f.includes('www.') || f.startsWith('.')) continue;
        if (/\.(com|org|net|io|dev)$/i.test(f)) continue;
        if (seen.has(f)) continue;
        seen.add(f);
        files.push(f);
        if (files.length >= _MAX_FILES) return files;
      }
    }
    return files;
  } catch { return []; }
}

module.exports = {
  extractCjkDecisions,
  extractCjkInsights,
  extractCjkQuestions,
  extractCjkFileReferences,
  // 供测试锁定:
  _cjkEnabled,
  _CJK_DECISION_MARKERS,
  _CJK_INSIGHT_MARKERS,
  _CJK_TERMINATORS,
};
