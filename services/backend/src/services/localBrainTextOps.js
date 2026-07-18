'use strict';

/**
 * localBrainTextOps.js — Tier-1 local text-operation handlers, extracted from
 * localBrainService.js to shrink that god file by responsibility
 * (mirrors the localBrainCalc.js extraction, DESIGN-ARCH-051 lineage).
 *
 * One cohesive responsibility: deterministic, no-model, no-network text
 * transforms (case, base64, url, json, wordcount, md5) plus their intent
 * detection / execution / formatting. Pure except for the optional localFormat
 * dependency (soft-required, degrades to plain text) and Node built-ins.
 *
 * localBrainService re-imports these under their original `_`-prefixed names so
 * the Tier-1 handler registry wiring is unchanged.
 */

let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

const TEXT_OPS = {
  upper: { match: /(转大写|大写|uppercase|to upper)/i, fn: (t) => t.toUpperCase(), label: '转大写' },
  lower: { match: /(转小写|小写|lowercase|to lower)/i, fn: (t) => t.toLowerCase(), label: '转小写' },
  base64enc: { match: /(base64\s*编码|base64\s*encode|encode.*base64|转.*base64)/i, fn: (t) => Buffer.from(t, 'utf8').toString('base64'), label: 'Base64 编码' },
  base64dec: { match: /(base64\s*解码|base64\s*decode|decode.*base64|base64.*转)/i, fn: (t) => { try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return '(解码失败)'; } }, label: 'Base64 解码' },
  wordcount: { match: /(字数|字符数|word count|文本统计|文字统计|\bwc\b|\blength\b)/i, fn: (t) => `字符: ${t.length} | 字(中): ${(t.match(/[一-龥]/g) || []).length} | 词(英): ${t.split(/\s+/).filter(Boolean).length} | 行: ${t.split('\n').length}`, label: '文本统计' },
  jsonformat: { match: /(格式化.*json|json.*格式化|format.*json|json.*format|美化.*json|json.*美化)/i, fn: (t) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return '(JSON 解析失败)'; } }, label: 'JSON 格式化' },
  urlencode: { match: /(url\s*编码|url\s*encode|encode.*url)/i, fn: (t) => encodeURIComponent(t), label: 'URL 编码' },
  urldecode: { match: /(url\s*解码|url\s*decode|decode.*url)/i, fn: (t) => { try { return decodeURIComponent(t); } catch { return '(解码失败)'; } }, label: 'URL 解码' },
  md5: { match: /(\bmd5\b|哈希|散列|md5.*计算|计算.*md5)/i, fn: (t) => { try { return require('crypto').createHash('md5').update(t).digest('hex'); } catch { return '(md5 不可用)'; } }, label: 'MD5' },
};

// Precomputed once at module load (Ch2「不要每轮重建可复用结构」). isTextOpIntent /
// detectTextOp are wired into the Tier-1 classification registry (text_op handler,
// cooperative:false) and run on every local-brain turn, each formerly allocating a
// fresh Object.values / Object.entries array. TEXT_OPS is a module const, iterated
// read-only (op.match.test + key/op destructure), never mutated — safe to share.
// Insertion order is preserved so detectTextOp's first-match semantics are identical.
const _TEXT_OP_VALUES = Object.values(TEXT_OPS);
const _TEXT_OP_ENTRIES = Object.entries(TEXT_OPS);

function isTextOpIntent(text) {
  for (const op of _TEXT_OP_VALUES) {
    if (op.match.test(text)) return true;
  }
  return false;
}

function detectTextOp(text) {
  let opKey = null;
  for (const [key, op] of _TEXT_OP_ENTRIES) {
    if (op.match.test(text)) { opKey = key; break; }
  }
  if (!opKey) return null;

  // 提取操作目标文本
  let sourceText = '';
  const quotedMatch = text.match(/[""「」『』]([^""「」『』]+)[""「」『』]/);
  const colonMatch = text.match(/[:：]\s*(.+)/s);
  if (quotedMatch) sourceText = quotedMatch[1];
  else if (colonMatch) sourceText = colonMatch[1].trim();
  else {
    // 移除指令关键词，剩下的就是目标文本
    sourceText = text
      .replace(/(转大写|转小写|大写|小写|uppercase|lowercase|base64\s*编码|base64\s*解码|base64\s*encode|base64\s*decode|字数|统计|word count|格式化|format|美化|url\s*编码|url\s*解码|url\s*encode|url\s*decode|md5|hash|哈希|散列|encode|decode|把|将|请|帮我)/gi, '')
      .trim();
  }
  if (!sourceText) return null;

  return { type: 'text_op', category: '文本处理', label: TEXT_OPS[opKey].label, opKey, sourceText };
}

function executeTextOp(plan) {
  const op = TEXT_OPS[plan.opKey];
  if (!op) return { type: 'text_op', success: false, error: '未知操作' };
  try {
    const result = op.fn(plan.sourceText);
    return { type: 'text_op', success: true, label: op.label, input: plan.sourceText, result };
  } catch (e) {
    return { type: 'text_op', success: false, error: e.message };
  }
}

function formatTextOp(result) {
  if (!result.success) return `文本处理失败: ${result.error}`;
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: result.label,
      sections: [{ heading: '结果', body: String(result.result) }],
      meta: ['本地文本处理'],
    });
  }
  return `[${result.label}]\n${result.result}`;
}

module.exports = {
  TEXT_OPS,
  isTextOpIntent,
  detectTextOp,
  executeTextOp,
  formatTextOp,
};
