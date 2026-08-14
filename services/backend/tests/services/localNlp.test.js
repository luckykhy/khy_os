'use strict';

/**
 * localNlp.test.js (node:test)
 *
 * Goal "无模型也要能用 — 在没有 AI 的情况怎么切词、总结、智能处理": verifies the
 * zero-dependency, no-model NLP toolkit used by the deterministic local tool
 * loop — segmentation (切词), keyword extraction, relevance scoring (智能处理),
 * and extractive query-focused summarization (总结). All pure functions.
 */
const test = require('node:test');
const assert = require('node:assert');

const nlp = require('../../src/services/localNlp');

test('segmentWords: ASCII words + CJK stopword-boundary chunks, readable', () => {
  const w = nlp.segmentWords('帮我优化本地模式的工具循环 runLocalToolLoop');
  // 帮/我/的 are stopwords → boundaries; ASCII identifier kept lowercased.
  assert.ok(w.includes('工具循环'), 'splits 的 boundary into 工具循环');
  assert.ok(w.includes('runlocaltoolloop'));
  // No stopword-only fragment survives.
  assert.ok(!w.includes('的'));
});

test('segmentWords: empty / punctuation-only input is safe', () => {
  assert.deepStrictEqual(nlp.segmentWords(''), []);
  assert.deepStrictEqual(nlp.segmentWords('，。！？'), []);
});

test('tokenize: produces CJK bigrams + ASCII words for scoring', () => {
  const t = nlp.tokenize('工具循环');
  assert.deepStrictEqual(t, ['工具', '具循', '循环']);
  const mixed = nlp.tokenize('Read 文件');
  assert.ok(mixed.includes('read'));
  // single-char CJK run that is a stopword is dropped.
  assert.deepStrictEqual(nlp.tokenize('的'), []);
});

test('extractKeywords: ranks frequent, longer terms first', () => {
  const kw = nlp.extractKeywords('本地模式 本地模式 工具循环 切词 总结 本地模式', { limit: 3 });
  assert.strictEqual(kw[0], '本地模式', 'most frequent term ranks first');
  assert.ok(kw.includes('工具循环'));
  assert.strictEqual(kw.length, 3);
});

test('scoreRelevance: fraction of query terms present, [0,1]', () => {
  assert.strictEqual(nlp.scoreRelevance('本地模式的工具循环很重要', '工具循环'), 1);
  const partial = nlp.scoreRelevance('只提到本地模式', '本地模式 工具循环');
  assert.ok(partial > 0 && partial < 1);
  assert.strictEqual(nlp.scoreRelevance('完全无关的内容', '工具循环'), 0);
  assert.strictEqual(nlp.scoreRelevance('anything', ''), 0);
});

test('splitSentences: handles CJK and ASCII terminators', () => {
  const s = nlp.splitSentences('第一句。第二句！第三句？ first. second.');
  assert.ok(s.length >= 5);
  assert.strictEqual(s[0], '第一句');
});

test('summarize: short text returned as-is', () => {
  const short = '一句话。';
  assert.strictEqual(nlp.summarize(short, { maxChars: 600 }), short);
});

test('summarize: list-like output is NOT reflowed (kept raw, truncated)', () => {
  // git-status-like: many short lines, no sentence terminators.
  const list = Array.from({ length: 20 }, (_, i) => ` M file_${i}.js`).join('\n');
  const out = nlp.summarize(list, { maxChars: 80 });
  assert.ok(out.length <= 81);
  assert.ok(out.includes('file_0.js'), 'keeps the head of the list verbatim');
  assert.ok(out.endsWith('…'));
});

test('summarize: query-focused extraction is decisive over salience', () => {
  const prose = [
    'KHY-OS 是 AI 原生操作系统。',
    '本地模式不依赖云端模型。',
    '工具循环在无模型时也能运行。',
    '这是无关填充句子一二三四。',
    '这是无关填充句子五六七八。',
    '这是无关填充句子九十。',
  ].join('').repeat(6); // inflate filler TF to test that query focus still wins
  const out = nlp.summarize(prose, { query: '本地模式 工具循环', maxSentences: 2, maxChars: 120 });
  assert.ok(out.includes('本地模式'), 'picks the query-relevant sentence');
  assert.ok(out.includes('工具循环'));
  assert.ok(!out.includes('无关填充'), 'filler excluded despite higher raw salience');
});

test('summarize: restores original reading order of picked sentences', () => {
  const prose = '甲句包含工具循环关键词内容。乙句普通填充内容文本。丙句也包含本地模式关键词。'.repeat(5);
  const out = nlp.summarize(prose, { query: '工具循环 本地模式', maxSentences: 2, maxChars: 60 });
  // 甲 (工具循环) appears before 丙 (本地模式) in source → must stay ordered.
  assert.ok(out.indexOf('甲句') < out.indexOf('丙句'));
});

test('summarize: respects char budget', () => {
  const prose = '这是一个比较长的句子用来测试预算限制。'.repeat(40);
  const out = nlp.summarize(prose, { maxChars: 50 });
  assert.ok(out.length <= 51);
});

test('env-extendable stopwords do not throw and base words present', () => {
  assert.ok(nlp.CJK_STOP.has('的'));
  assert.ok(nlp.EN_STOP.has('the'));
});
