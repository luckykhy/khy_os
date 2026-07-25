'use strict';

/**
 * 本地推理引擎（无模型 · 简单思考）
 * =================================================================
 * 角色：在「无 AI 模型 + 有网络」时，用确定性规则做一点「简单思考」——
 * 拆解问题、对比利弊、跨源核验、离线逻辑推断——产出像模型一样的
 * 「结论 + 可选展开」答案。绝不杜撰：没有足够依据时返回 null，让上层
 * 优雅降级（既有 web 搜索兜底 / 建议联网或配置模型）。
 *
 * 设计铁律（与本地模式其余子系统一致）：
 *  - 零硬编码：所有上限/开关经 env 可调。
 *  - 状态透明：每条结论带 kind + 置信度 + 来源数；离线/降级显式说明。
 *  - 有界：子查询数上限、诚实闸门（无依据 → null）。
 *  - 纯函数 + 依赖注入：search() 注入，便于 hermetic 测试，无需真网络/模型。
 *
 * 入口：reason(query, { search, networkUp, signal }) -> ReasonResult | null
 *   ReasonResult = { kind, conclusion, expansion, sources, confidence, response }
 *   kind ∈ {compare, decompose, verify, offline_logic}
 *   response = 已渲染的「结论 + 可选展开」纯文本（调用方直接呈现）。
 */

let _nlp = null;
try { _nlp = require('./localNlp'); } catch { /* degrade to naive split */ }
let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

// ── env helpers ──────────────────────────────────────────────────────
function _intFromEnv(name, def, min = 1, max = 100) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}
function _reasonEnabled() {
  const v = String(process.env.KHY_LOCAL_REASON || 'on').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

// ── intent regexes ───────────────────────────────────────────────────
// 对比/利弊：A 和 B 哪个好 / A vs B / X 的优缺点 / 区别 / 对比
const _COMPARE_RE = /(.+?)\s*(?:和|与|跟|vs\.?|对比|相比|比较)\s*(.+?)\s*(?:哪个?|谁)?\s*(?:更|比较)?\s*(?:好|强|快|优|合适|划算|靠谱)|(.+?)\s*的?\s*(?:优缺点|优劣|利弊|好处和?坏处|优点和?缺点|pros?\s*(?:and|&)?\s*cons?)/i;
const _COMPARE_TRIGGER_RE = /(哪个?更?好|哪个?强|区别|差别|对比|相比|优缺点|优劣|利弊|好处.*坏处|pros?\s*(?:and|&)?\s*cons?|\bvs\.?\b)/i;
// 拆解：复合问句（多个子问由连接词/顿号分隔，或「先…再…」「又…又…」）
const _DECOMPOSE_SPLIT_RE = /(?:，|,|；|;|、|\?|？|\band\b|以及|并且|而且|还有|另外|同时|分别|然后|接着|(?<!合|兼|吞)并(?!且|发|行|列|存|购|举|肩|重|入))/i;
const _DECOMPOSE_TRIGGER_RE = /(并且|而且|还有|以及|分别|同时|又.*又|既.*又|怎么.*又怎么|和.*怎么)/i;
// 事实型（与 IR 引擎一致，用于跨源核验路由）
const _FACT_RE = /(多少|多大|多高|多重|多长|多远|多深|多宽|几岁|几个|几年|几月|几天|哪一?年|哪一?月|哪一?天|什么时候|何时|是谁|谁是|在哪|哪里|哪儿|什么是|是什么|叫什么|价格|多少钱|身高|体重|年龄|首都|面积|人口|海拔|距离|温度|who\s+is|what\s+is|when\s|where\s+is|how\s+(?:many|much|tall|old|long|far|high)|price|capital|population)/i;

// 正负向（情感）词典——单实体优缺点抽取用，保守。
const _POS_RE = /(优点|优势|好处|强项|高效|快速|稳定|可靠|简单|易用|灵活|流行|成熟|安全|免费|开源|轻量|强大|方便|省|提升|增强|支持)/;
const _NEG_RE = /(缺点|劣势|不足|短板|坏处|问题|风险|复杂|缓慢|不稳定|昂贵|收费|限制|难|耗|占用|脆弱|过时|依赖|bug|漏洞|局限)/;

// ── text helpers ─────────────────────────────────────────────────────
function _tokenize(t) { return _nlp ? _nlp.tokenize(t) : String(t || '').toLowerCase().split(/\s+/).filter(Boolean); }
function _splitSentences(t) {
  if (_nlp) return _nlp.splitSentences(t);
  return String(t || '').split(/(?<=[。！？!?；;])\s*|\n+/).map(s => s.trim()).filter(s => s.length >= 4);
}
function _summarize(t, opts) { return _nlp ? _nlp.summarize(t, opts) : String(t || '').slice(0, opts?.maxChars || 300); }
function _scoreRelevance(t, q) { return _nlp ? _nlp.scoreRelevance(t, q) : 0; }

function _cleanSnippet(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// 把搜索结果合并成一段可抽句的语料（snippet 优先，title 补充），保留来源 url。
function _corpusFromResults(results) {
  const sentences = [];
  const sources = [];
  for (const r of (results || [])) {
    const text = _cleanSnippet(r.snippet || r.description || r.title || '');
    const url = String(r.url || '').trim();
    for (const s of _splitSentences(text)) {
      sentences.push(s);
      if (url) sources.push(url);
    }
  }
  return { sentences, sources };
}

function _uniqueUrls(results, limit = 4) {
  return [...new Set((results || []).map(r => String(r.url || '').trim()).filter(Boolean))].slice(0, limit);
}

// ── 呈现：结论 + 可选展开 ─────────────────────────────────────────────
function _confLabel(conf) {
  return conf === 'high' ? '高' : conf === 'low' ? '低' : '中';
}

/**
 * 渲染统一的「结论 + 可选展开」文本。
 * 优先经 localFormat 统一结构化排版（## 标题 + 结论/依据 区块 + 来源块 + 元信息）；
 * localFormat 不可用或被关闭时回退到朴素纯文本。
 * URL 独占整行不缩进，配合渲染层不硬换行规则，终端可整段选中复制。
 */
function _render({ title, conclusion, expansion, sources, confidence, sourceCount }) {
  const meta = [];
  if (confidence) meta.push(`${_confLabel(confidence)}置信`);
  if (sourceCount) meta.push(`基于 ${sourceCount} 个来源`);

  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: title || '本地推理',
      sections: [
        { heading: '结论', body: String(conclusion || '').trim() },
        { heading: '依据', body: expansion && expansion.trim() ? expansion.trim() : '' },
      ],
      sources: sources || [],
      meta,
    });
  }

  // 朴素回退
  const lines = [];
  lines.push(`结论：${conclusion}`);
  lines.push(`（${[...meta, '本地推理 · 无模型'].join(' · ')}）`);
  if (expansion && expansion.trim()) {
    lines.push('');
    lines.push('— 推理依据（展开）—');
    lines.push(expansion.trim());
  }
  if (sources && sources.length) {
    lines.push('');
    lines.push('来源（可复制完整链接）:');
    sources.forEach((u, i) => lines.push(`${i + 1}. ${u}`));
  }
  return lines.join('\n');
}

// ── 1. 对比 / 利弊推理 ────────────────────────────────────────────────
function _extractCompareTerms(query) {
  const m = query.match(_COMPARE_RE);
  if (!m) return null;
  // 双实体形态：m[1]/m[2]；单实体优缺点形态：m[3]
  if (m[1] && m[2]) {
    const a = _trimTerm(m[1]), b = _trimTerm(m[2]);
    if (a && b) return { mode: 'dual', a, b };
  }
  if (m[3]) {
    const x = _trimTerm(m[3]);
    if (x) return { mode: 'single', x };
  }
  return null;
}
function _trimTerm(s) {
  return String(s || '')
    .replace(/[?？。.!！,，、；;:：]+/g, ' ')
    .replace(/^(请问|帮我|我想知道|想知道|告诉我|那|这|个)\s*/i, '')
    .replace(/\s*(的|呢|吗|啊|哪个?|谁|更|比较|好|强|快|优|合适)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

// 从语料里抽取与某实体相关、且属于正/负向维度的句子。
function _extractDimensions(entity, sentences, max = 4) {
  const pos = [], neg = [];
  for (const s of sentences) {
    if (_scoreRelevance(s, entity) < 0.15 && !s.includes(entity)) continue;
    if (_POS_RE.test(s) && pos.length < max) pos.push(s);
    else if (_NEG_RE.test(s) && neg.length < max) neg.push(s);
  }
  return { pos, neg };
}

async function _reasonCompare(query, terms, search) {
  if (terms.mode === 'single') {
    const res = await search(terms.x);
    const { sentences } = _corpusFromResults(res);
    if (!sentences.length) return null;
    const { pos, neg } = _extractDimensions(terms.x, sentences);
    if (!pos.length && !neg.length) return null;
    const exp = [];
    if (pos.length) exp.push('优点:', ...pos.map(s => `  + ${s}`));
    if (neg.length) exp.push('缺点:', ...neg.map(s => `  - ${s}`));
    const conclusion = `${terms.x} 的优点约 ${pos.length} 条、缺点约 ${neg.length} 条，详见下方依据。`;
    return _render({
      title: `${terms.x} 利弊分析`,
      conclusion, expansion: exp.join('\n'),
      sources: _uniqueUrls(res), confidence: 'low',
      sourceCount: (res || []).length,
    });
  }
  // dual：各查一侧
  const [resA, resB] = await Promise.all([search(terms.a), search(terms.b)]);
  const corpA = _corpusFromResults(resA), corpB = _corpusFromResults(resB);
  if (!corpA.sentences.length && !corpB.sentences.length) return null;
  const dimA = _extractDimensions(terms.a, corpA.sentences);
  const dimB = _extractDimensions(terms.b, corpB.sentences);
  const scoreA = dimA.pos.length - dimA.neg.length;
  const scoreB = dimB.pos.length - dimB.neg.length;
  let lean;
  if (scoreA > scoreB) lean = `综合搜索结果中的正负向描述，${terms.a} 略占优（仅供参考，非权威结论）。`;
  else if (scoreB > scoreA) lean = `综合搜索结果中的正负向描述，${terms.b} 略占优（仅供参考，非权威结论）。`;
  else lean = `两者在搜索结果中的正负向描述大致相当，需结合你的具体场景判断。`;

  const exp = [];
  const _side = (name, dim) => {
    exp.push(`【${name}】`);
    if (dim.pos.length) { exp.push('  优点:'); dim.pos.forEach(s => exp.push(`    + ${s}`)); }
    if (dim.neg.length) { exp.push('  缺点:'); dim.neg.forEach(s => exp.push(`    - ${s}`)); }
    if (!dim.pos.length && !dim.neg.length) exp.push('  （未在搜索结果中找到明确的优缺点描述）');
  };
  _side(terms.a, dimA);
  _side(terms.b, dimB);
  return _render({
    title: `${terms.a} vs ${terms.b}`,
    conclusion: lean, expansion: exp.join('\n'),
    sources: _uniqueUrls([...(resA || []), ...(resB || [])]),
    confidence: 'low',
    sourceCount: (resA || []).length + (resB || []).length,
  });
}

// ── 2. 问题拆解 + 多查询综合 ──────────────────────────────────────────
function splitSubQuestions(query) {
  const parts = String(query || '')
    .split(_DECOMPOSE_SPLIT_RE)
    .map(s => s.trim())
    .filter(s => s.length >= 4);
  // 去重 + 上限
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function _reasonDecompose(query, search) {
  const max = _intFromEnv('KHY_LOCAL_REASON_MAX_SUBQ', 3, 1, 6);
  const subs = splitSubQuestions(query).slice(0, max);
  if (subs.length < 2) return null;

  const sentencesPerSub = _intFromEnv('KHY_LOCAL_REASON_SUB_SENTENCES', 2, 1, 5);
  const blocks = [];
  const allSources = [];
  let answered = 0;
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    let res = null;
    try { res = await search(sub); } catch { /* one sub fails, continue */ }
    const { sentences } = _corpusFromResults(res);
    if (!sentences.length) {
      blocks.push(`${i + 1}. ${sub}\n   （未检索到有效信息）`);
      continue;
    }
    answered++;
    const joined = sentences.join(' ');
    const digest = _summarize(joined, { query: sub, maxSentences: sentencesPerSub, maxChars: 240 });
    blocks.push(`${i + 1}. ${sub}\n   ${digest}`);
    allSources.push(..._uniqueUrls(res, 2));
  }
  if (!answered) return null;

  const conclusion = `已将问题拆为 ${subs.length} 个子问题逐一检索，其中 ${answered} 个有结果，详见下方分点。`;
  return _render({
    title: '问题拆解',
    conclusion, expansion: blocks.join('\n\n'),
    sources: [...new Set(allSources)].slice(0, 6),
    confidence: answered === subs.length ? 'medium' : 'low',
    sourceCount: allSources.length,
  });
}

// ── 3. 跨源事实核验 ──────────────────────────────────────────────────
// 归一化候选答案（数字+单位/日期/裸词），便于投票一致性判定。
function _normalizeFact(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，,。.！!？?；;、]+$/, '')
    .toLowerCase();
}
// 从一条结果语料里抽最直接的事实短语（轻量版 _irExtractFact）。
function _extractFactCandidate(query, sentences) {
  const kwQuery = query;
  let best = null, bestScore = 0;
  for (const s of sentences) {
    const sc = _scoreRelevance(s, kwQuery);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  if (!best || bestScore < 0.1) return null;
  // 数字+单位优先。前导数字串有界 `[\d,，.]{0,31}` 防 ReDoS：原 `[\d,，.]*`
  // 贪婪吞完全部数字后，尾部单位锚点失败会在每个起点回溯 → O(n^2)。本处 `best`
  // 来自 web 搜索结果的 snippet（`_cleanSnippet` 不截长度），若某结果返回无句读
  // 分隔的超长数字串即冻结（60k→3s，100k→8.5s）。有界对真实数字串字节等价。
  const numUnit = best.match(/\d[\d,，.]{0,31}\s*(?:亿人|万人|厘米|毫米|公里|千米|平方公里|平方米|个月|周岁|小时|分钟|美元|人民币|欧元|日元|港元|米|克|吨|岁|年|天|秒|元|万|亿|个|人|位|名|%|℃|度|km|cm|mm|kg|m|g)/);
  if (numUnit) return numUnit[0].trim();
  // 「…是/为 X」结构
  const be = best.search(/[是为＝=:：]/);
  if (be >= 0) {
    const after = best.slice(be + 1).replace(/^[\s是为＝=:：]+/, '');
    const clause = after.split(/[，,。.；;！!？?、]/)[0].trim();
    if (clause.length >= 2 && clause.length <= 40) return clause;
  }
  return best.length <= 60 ? best.replace(/[。.！!？?；;，,、\s]+$/, '') : null;
}

async function _reasonVerify(query, search) {
  const res = await search(query);
  if (!Array.isArray(res) || res.length < 2) return null; // 单源无可核验
  // 逐条结果各抽一个候选答案
  const candidates = [];
  for (const r of res.slice(0, 5)) {
    const { sentences } = _corpusFromResults([r]);
    if (!sentences.length) continue;
    const cand = _extractFactCandidate(query, sentences);
    if (cand) candidates.push({ value: cand, norm: _normalizeFact(cand), url: String(r.url || '').trim() });
  }
  if (candidates.length < 2) return null;

  // 投票：归一化后多数一致 → 高置信
  const votes = new Map();
  for (const c of candidates) votes.set(c.norm, (votes.get(c.norm) || 0) + 1);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [topNorm, topCount] = ranked[0];
  const topCand = candidates.find(c => c.norm === topNorm);

  if (topCount >= 2 && topCount >= Math.ceil(candidates.length / 2)) {
    return _render({
      title: '事实核验',
      conclusion: `${topCand.value}`,
      expansion: `共 ${candidates.length} 个来源给出候选，其中 ${topCount} 个一致认为「${topCand.value}」。`,
      sources: _uniqueUrls(res), confidence: 'high', sourceCount: res.length,
    });
  }
  // 分歧：并列各家说法
  const distinct = [...new Set(candidates.map(c => c.value))].slice(0, 4);
  return _render({
    title: '事实核验',
    conclusion: `各来源说法不一致，未能确认唯一答案，请自行甄别。`,
    expansion: '各来源候选答案:\n' + distinct.map((v, i) => `  ${i + 1}) ${v}`).join('\n'),
    sources: _uniqueUrls(res), confidence: 'low', sourceCount: res.length,
  });
}

// ── 4. 离线逻辑（无网络也可用，保守，无依据则 null）─────────────────────
// 只处理能确定推断的形态：单位/数值换算交给 calcService；其余诚实返回 null。
function _reasonOfflineLogic(query) {
  // 数值/算式：交给计算子能力（中文算式也支持，如「2的10次方」）。
  try {
    const calc = require('./localBrainCalc');
    if (typeof calc.isCalcIntent === 'function' && calc.isCalcIntent(query)) {
      const plan = calc.detectCalc(query);
      const r = calc.executeCalc(plan);
      // 防呆：calc 解析失败时会退化成"裸数字"表达式（如把"123乘以456"
      // 误解析为 expr:"123"）。只有当表达式含真实运算（运算符/函数调用）时
      // 才采信，避免输出"123 = 123"这类无意义结论。
      const expr = r && typeof r.expr === 'string' ? r.expr : '';
      const isRealComputation = /[+\-*/%^]|Math\.|[a-z]+\s*\(/i.test(expr);
      if (r && r.success && r.result !== undefined && isRealComputation) {
        return _render({
          title: '本地计算',
          conclusion: `${r.expr} = ${r.result}`,
          expansion: `本地按算术规则直接计算得出（无需联网）。`,
          sources: [], confidence: 'high', sourceCount: 0,
        });
      }
    }
  } catch { /* calc not available */ }
  // 其余离线逻辑暂不杜撰 → null，让上层提示联网/配置模型。
  return null;
}

// ── 入口 ─────────────────────────────────────────────────────────────
/**
 * @param {string} query
 * @param {object} deps
 * @param {(q:string)=>Promise<Array>} deps.search  注入的检索函数，返回 results[]（{title,snippet,url}）。
 * @param {boolean} [deps.networkUp=true]
 * @returns {Promise<string|null>}  已渲染的「结论+展开」文本；null = 不该由推理层处理。
 */
async function reason(query, deps = {}) {
  if (!_reasonEnabled()) return null;
  const q = String(query || '').trim();
  if (q.length < 4) return null;
  const networkUp = deps.networkUp !== false;
  const search = typeof deps.search === 'function' ? deps.search : null;

  // 离线优先：无网络时只能走纯本地逻辑（数值/算式等）。
  if (!networkUp || !search) {
    return _reasonOfflineLogic(q);
  }

  // 路由优先级：对比 > 拆解 > 跨源核验。命中即用，未命中继续；全部未命中
  // 返回 null（让既有 web 搜索兜底接手），绝不杜撰。
  try {
    if (_COMPARE_TRIGGER_RE.test(q)) {
      const terms = _extractCompareTerms(q);
      if (terms) {
        const out = await _reasonCompare(q, terms, search);
        if (out) return out;
      }
    }
    if (_DECOMPOSE_TRIGGER_RE.test(q) || splitSubQuestions(q).length >= 2) {
      const out = await _reasonDecompose(q, search);
      if (out) return out;
    }
    if (_FACT_RE.test(q)) {
      const out = await _reasonVerify(q, search);
      if (out) return out;
    }
  } catch { /* any failure → degrade to null */ }

  // 最后兜底：尝试纯本地逻辑（如内嵌算式）。算术与网络无关，且
  // _reasonOfflineLogic 自带诚实闸门（仅真实运算才返回），可无条件尝试。
  const offline = _reasonOfflineLogic(q);
  if (offline) return offline;
  return null;
}

module.exports = {
  reason,
  splitSubQuestions,
  // 暴露内部供测试
  _extractCompareTerms,
  _extractDimensions,
  _extractFactCandidate,
  _normalizeFact,
  _reasonOfflineLogic,
  _render,
};
