'use strict';

/**
 * changelogParse.test.js — 纯叶子 CHANGELOG 解析器契约(node:test,零 IO)。
 *
 * 锁定:版本头识别(## 而非 ###)、摘要抽取、Highlights bullet → {title,detail}、
 * 多行 bullet 续接、--- 不结束条目、其它小节并入 sections、selectReleaseNotes 按版本/数量筛、
 * splitHighlight 粗体标题拆分、防呆(空串/非串/无版本头)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseChangelog, splitHighlight, selectReleaseNotes } = require('../../../src/services/changelog/changelogParse');

const SAMPLE = [
  '# Changelog',
  '',
  'All notable changes are documented here.',
  '',
  '---',
  '',
  '## 0.1.136',
  '',
  '让纯文本模型也能识图——OCR 兜底。',
  '',
  '### Highlights',
  '',
  '- **纯文本模型识图兜底（`docHelper.py`）**：新增 CLI 兜底，',
  '  只要引擎在 PATH 上即可识图。',
  '- 第二条亮点无粗体标题。',
  '',
  '---',
  '',
  '## 0.1.2',
  '',
  'Focuses on production stability.',
  '',
  '### Highlights',
  '',
  '- Task-scale-aware retry strategy.',
  '',
  '### Compatibility',
  '',
  '- Python: `>=3.8`',
  '',
  '---',
].join('\n');

describe('parseChangelog', () => {
  const entries = parseChangelog(SAMPLE);

  test('解析出两个版本条目(物理顺序,新在上)', () => {
    assert.equal(entries.length, 2);
    assert.equal(entries[0].version, '0.1.136');
    assert.equal(entries[1].version, '0.1.2');
  });

  test('摘要抽取(到首个 ### 为止)', () => {
    assert.equal(entries[0].summary, '让纯文本模型也能识图——OCR 兜底。');
    assert.equal(entries[1].summary, 'Focuses on production stability.');
  });

  test('Highlights bullet → {title,detail},多行续接合并', () => {
    const h = entries[0].highlights;
    assert.equal(h.length, 2);
    assert.equal(h[0].title, '纯文本模型识图兜底（`docHelper.py`）');
    assert.match(h[0].detail, /新增 CLI 兜底/);
    assert.match(h[0].detail, /只要引擎在 PATH 上即可识图/); // 续接行已并入
    assert.equal(h[1].title, '第二条亮点无粗体标题。');
    assert.equal(h[1].detail, '');
  });

  test('--- 不结束条目;非 Highlights 小节并入 sections 不计 highlights', () => {
    assert.equal(entries[1].highlights.length, 1);
    assert.deepStrictEqual(entries[1].sections, ['Compatibility']);
  });

  test('前言(版本头之前)整体忽略', () => {
    // "All notable changes" 不应混入任何条目摘要。
    assert.ok(!entries.some((e) => /All notable/.test(e.summary)));
  });
});

describe('splitHighlight', () => {
  test('粗体标题 + 冒号详情', () => {
    assert.deepStrictEqual(splitHighlight('**标题**: 详情在这里'), { title: '标题', detail: '详情在这里' });
  });
  test('全角冒号亦可', () => {
    assert.deepStrictEqual(splitHighlight('**标题**：详情'), { title: '标题', detail: '详情' });
  });
  test('无粗体 → 整句为 title', () => {
    assert.deepStrictEqual(splitHighlight('一条普通亮点'), { title: '一条普通亮点', detail: '' });
  });
  test('防呆:空/非串', () => {
    assert.deepStrictEqual(splitHighlight(''), { title: '', detail: '' });
    assert.deepStrictEqual(splitHighlight(null), { title: '', detail: '' });
    assert.deepStrictEqual(splitHighlight(undefined), { title: '', detail: '' });
  });
});

describe('selectReleaseNotes', () => {
  const entries = parseChangelog(SAMPLE);
  test('默认取最新 1 个', () => {
    const r = selectReleaseNotes(entries);
    assert.equal(r.length, 1);
    assert.equal(r[0].version, '0.1.136');
  });
  test('limit=2 取前 2', () => {
    assert.equal(selectReleaseNotes(entries, { limit: 2 }).length, 2);
  });
  test('limit 非法 → 退化为 1', () => {
    assert.equal(selectReleaseNotes(entries, { limit: 0 }).length, 1);
    assert.equal(selectReleaseNotes(entries, { limit: -5 }).length, 1);
    assert.equal(selectReleaseNotes(entries, { limit: NaN }).length, 1);
  });
  test('version 精确命中(可带前导 v)', () => {
    assert.equal(selectReleaseNotes(entries, { version: '0.1.2' })[0].version, '0.1.2');
    assert.equal(selectReleaseNotes(entries, { version: 'v0.1.2' })[0].version, '0.1.2');
  });
  test('version 未命中 → 空数组', () => {
    assert.equal(selectReleaseNotes(entries, { version: '9.9.9' }).length, 0);
  });
});

describe('防呆', () => {
  test('空串/非串 → 空数组', () => {
    assert.deepStrictEqual(parseChangelog(''), []);
    assert.deepStrictEqual(parseChangelog(null), []);
    assert.deepStrictEqual(parseChangelog(42), []);
  });
  test('无版本头的文本 → 空数组', () => {
    assert.deepStrictEqual(parseChangelog('just some\nprose\nwithout headers'), []);
  });
  test('### 不被误当版本头', () => {
    const r = parseChangelog('## 1.0.0\nsummary\n### Highlights\n- a');
    assert.equal(r.length, 1);
    assert.equal(r[0].version, '1.0.0');
  });
});
