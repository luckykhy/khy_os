'use strict';

/**
 * parser.js — 审计轨迹的通用解析器 + 有效轮判定（外部质检脚本的本地等价物）。
 *
 * 两个职责：
 *   1. parseTrajectory：把 .jsonl 读成 {messages:[]} 形态，并抽出工具调用序列。
 *      刻意写成「通用解析器」的样子 —— 只认每行的 `message: {role, content}`
 *      （缺失时退到行上的 role/content），不依赖任何 khy 私有字段。这就是记录器
 *      的自检口：如果通用解析器读不出工具调用，外部质检也读不出。
 *   2. judgeRounds：按外部规则判定每一轮是否有效。三条同时满足，缺一不可：
 *        a) 这一轮有新的增量要求
 *        b) 有可见的工具调用行为
 *        c) 有非空的代码 diff，或者「运行 + 截图」的验证动作
 *
 * 判定刻意从严：任何拿不准的都判成不满足，宁可自己先发现无效轮，也不要等外部
 * 质检发现。每条判定都带 reason，直接可读给人看该补什么。
 *
 * 契约：零写盘、绝不抛（坏行跳过并计入 malformed）。
 *
 * @module services/auditTrajectory/parser
 */

const fs = require('fs');

/** 只说「继续/接着做」这类的提示词不算新增量要求。 */
const CONTINUATION_PATTERNS = [
  /^\s*(继续|接着|接着做|继续做|go on|continue|next|proceed|再来|然后呢?)\s*[。.!！~]*\s*$/i,
];

/** 与历史轮提示词的相似度上限；超过视为重复要求，不算增量。 */
const DEFAULT_SIMILARITY_MAX = 0.85;

// ── 解析 ──

/** 把 content（字符串或块数组）里的纯文本拼起来。 */
function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => String(b.text || ''))
    .join('\n');
}

/** 取出 content 里的 tool_use 块。 */
function toolUsesOf(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({ id: String(b.id || ''), name: String(b.name || ''), input: b.input || {} }));
}

/** 取出 content 里的 tool_result 块。 */
function toolResultsOf(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((b) => b && b.type === 'tool_result')
    .map((b) => ({
      tool_use_id: String(b.tool_use_id || ''),
      content: b.content,
      is_error: !!b.is_error,
    }));
}

/**
 * 解析一份轨迹 jsonl。
 * @param {string} filePath
 * @returns {{messages:Array, events:Array, toolCalls:Array, toolResults:Array, malformed:number, file:string}}
 */
function parseTrajectory(filePath) {
  const out = { file: String(filePath || ''), messages: [], events: [], toolCalls: [], toolResults: [], malformed: 0 };
  let raw = '';
  try {
    raw = String(fs.readFileSync(out.file, 'utf-8'));
  } catch (err) {
    out.error = (err && err.message) || String(err);
    return out;
  }
  return parseTrajectoryText(raw, out.file);
}

/**
 * 同 parseTrajectory，但直接吃字符串（单测与管道用）。
 * @param {string} raw
 * @param {string} [file]
 */
function parseTrajectoryText(raw, file = '') {
  const out = { file, messages: [], events: [], toolCalls: [], toolResults: [], malformed: 0 };
  const lines = String(raw || '').split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let e = null;
    try {
      e = JSON.parse(line);
    } catch {
      out.malformed += 1;
      continue;
    }
    if (!e || typeof e !== 'object') {
      out.malformed += 1;
      continue;
    }
    out.events.push(e);

    // 通用解析器视角：只认 message.{role,content}，退化时才看行上的 role/content。
    const msg =
      e.message && typeof e.message === 'object'
        ? { role: e.message.role || e.role || 'unknown', content: e.message.content }
        : { role: e.role || 'unknown', content: e.content };
    out.messages.push(msg);

    for (const t of toolUsesOf(msg.content)) {
      out.toolCalls.push({ ...t, uuid: e.uuid || '', round: Number(e.round) || 0, timestamp: e.timestamp || '' });
    }
    for (const r of toolResultsOf(msg.content)) {
      out.toolResults.push({
        ...r,
        uuid: e.uuid || '',
        round: Number(e.round) || 0,
        toolName: e.toolName || '',
        evidence: e.evidence,
      });
    }
  }
  return out;
}

/** 校验 parentUuid 链完整（对话树可重建）。 */
function verifyChain(parsed) {
  const seen = new Set();
  const broken = [];
  for (const e of parsed.events || []) {
    if (e.parentUuid && !seen.has(e.parentUuid)) {
      broken.push({ uuid: e.uuid, parentUuid: e.parentUuid });
    }
    if (e.uuid) {
      seen.add(e.uuid);
    }
  }
  return { ok: broken.length === 0, broken };
}

// ── 相似度（判「是否新增量要求」用） ──

/** 二元字符组 Dice 系数，对中英文都稳。 */
function similarity(a, b) {
  const s1 = String(a || '').replace(/\s+/g, '');
  const s2 = String(b || '').replace(/\s+/g, '');
  if (!s1 && !s2) {
    return 1;
  }
  if (!s1 || !s2) {
    return 0;
  }
  if (s1 === s2) {
    return 1;
  }
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const g1 = grams(s1);
  const g2 = grams(s2);
  if (g1.size === 0 || g2.size === 0) {
    return s1 === s2 ? 1 : 0;
  }
  let inter = 0;
  for (const [g, n] of g1) {
    inter += Math.min(n, g2.get(g) || 0);
  }
  const total1 = [...g1.values()].reduce((x, y) => x + y, 0);
  const total2 = [...g2.values()].reduce((x, y) => x + y, 0);
  return (2 * inter) / (total1 + total2);
}

// ── 有效轮判定 ──

/**
 * 按 prompt 事件切轮，逐轮判三条件。
 * @param {object} parsed parseTrajectory 的返回值
 * @param {object} [opts] { similarityMax }
 * @returns {{rounds:Array, validCount:number, total:number, allValid:boolean}}
 */
function judgeRounds(parsed, opts = {}) {
  const simMax = typeof opts.similarityMax === 'number' ? opts.similarityMax : DEFAULT_SIMILARITY_MAX;
  const events = (parsed && parsed.events) || [];

  // 切轮：每个 type='prompt' 事件开一轮，收拢到下一个 prompt 之前。
  const rounds = [];
  for (const e of events) {
    if (e.type === 'prompt') {
      rounds.push({
        round: Number(e.round) || rounds.length + 1,
        promptText: textOf(e.message && e.message.content) || textOf(e.content),
        origin: e.origin || null,
        timestamp: e.timestamp || '',
        events: [e],
      });
      continue;
    }
    if (rounds.length > 0) {
      rounds[rounds.length - 1].events.push(e);
    }
  }

  const priorPrompts = [];
  for (const r of rounds) {
    const reasons = [];

    // (a) 新的增量要求
    const text = String(r.promptText || '').trim();
    let hasNewRequirement = true;
    if (!text) {
      hasNewRequirement = false;
      reasons.push('本轮没有提示词正文，无从判定新增量要求');
    } else if (CONTINUATION_PATTERNS.some((re) => re.test(text))) {
      hasNewRequirement = false;
      reasons.push(`提示词只是续做指令（"${text.slice(0, 20)}"），不含新增量要求`);
    } else {
      let worst = 0;
      let worstIdx = -1;
      for (let i = 0; i < priorPrompts.length; i++) {
        const s = similarity(text, priorPrompts[i]);
        if (s > worst) {
          worst = s;
          worstIdx = i;
        }
      }
      if (worst >= simMax) {
        hasNewRequirement = false;
        reasons.push(`与第 ${worstIdx + 1} 轮提示词相似度 ${worst.toFixed(2)} ≥ ${simMax}，视为重复要求`);
      }
      r.maxSimilarity = Number(worst.toFixed(4));
    }
    priorPrompts.push(text);

    // (b) 可见的工具调用行为
    const calls = [];
    for (const e of r.events) {
      const c = e.message && e.message.content;
      for (const t of toolUsesOf(c)) {
        calls.push(t);
      }
    }
    const hasToolCall = calls.length > 0;
    if (!hasToolCall) {
      reasons.push('本轮没有 tool_use 块，外部质检看不到工具调用行为');
    }

    // (c) 非空 diff 或「运行 + 截图」验证
    let diffFiles = 0;
    let addedTotal = 0;
    let removedTotal = 0;
    for (const e of r.events) {
      const list = Array.isArray(e.evidence) ? e.evidence : e.evidence ? [e.evidence] : [];
      for (const ev of list) {
        if (ev && ev.empty === false) {
          diffFiles += 1;
          addedTotal += Number(ev.added) || 0;
          removedTotal += Number(ev.removed) || 0;
        }
      }
    }
    const verifications = r.events
      .filter((e) => e.type === 'verification' && e.verification)
      .map((e) => e.verification);
    const hasRunAndShot = verifications.some((v) => v && v.ran === true && v.captured === true);
    const hasEvidence = diffFiles > 0 || hasRunAndShot;
    if (!hasEvidence) {
      if (verifications.length > 0) {
        reasons.push('有验证事件但不满足「运行 + 截图」（缺命令或缺截图），且本轮无非空 diff');
      } else {
        reasons.push('本轮既无非空 diff，也无「运行 + 截图」验证动作');
      }
    }

    r.hasNewRequirement = hasNewRequirement;
    r.hasToolCall = hasToolCall;
    r.hasEvidence = hasEvidence;
    r.toolCallCount = calls.length;
    r.toolNames = calls.map((c) => c.name);
    r.diffFiles = diffFiles;
    r.added = addedTotal;
    r.removed = removedTotal;
    r.verifiedByRunAndShot = hasRunAndShot;
    r.originType = (r.origin && r.origin.type) || '';
    r.valid = hasNewRequirement && hasToolCall && hasEvidence;
    r.reasons = reasons;
    delete r.events; // 判定结果面向人阅读，不回吐整轮原始事件
  }

  const validCount = rounds.filter((r) => r.valid).length;
  return { rounds, validCount, total: rounds.length, allValid: rounds.length > 0 && validCount === rounds.length };
}

/**
 * 一站式：读文件 → 解析 → 判定，外加链完整性与来源统计。
 * @param {string} filePath
 * @param {object} [opts]
 */
function auditTrajectory(filePath, opts = {}) {
  const parsed = parseTrajectory(filePath);
  if (parsed.error) {
    return { ok: false, error: parsed.error, file: parsed.file };
  }
  const judged = judgeRounds(parsed, opts);
  const chain = verifyChain(parsed);
  const origins = { human: 0, ai_generated: 0, downgraded: 0 };
  for (const e of parsed.events) {
    if (e.type !== 'prompt' || !e.origin) {
      continue;
    }
    if (e.origin.type === 'human') {
      origins.human += 1;
    } else {
      origins.ai_generated += 1;
    }
    if (e.origin.downgradedFrom) {
      origins.downgraded += 1;
    }
  }
  return {
    ok: judged.allValid && chain.ok && parsed.malformed === 0,
    file: parsed.file,
    events: parsed.events.length,
    messages: parsed.messages.length,
    toolCalls: parsed.toolCalls.length,
    toolResults: parsed.toolResults.length,
    malformed: parsed.malformed,
    chain,
    origins,
    ...judged,
  };
}

module.exports = {
  parseTrajectory,
  parseTrajectoryText,
  judgeRounds,
  auditTrajectory,
  verifyChain,
  similarity,
  textOf,
  toolUsesOf,
  toolResultsOf,
  CONTINUATION_PATTERNS,
  DEFAULT_SIMILARITY_MAX,
};
