'use strict';
/*
 * check_beginner_docs.test.js — 面向小白文档体检器的守卫测试（node:test）
 * 坏样本必红（检出对应 kind）、好样本必绿（[]）；并对真实仓库树锁一条「必须 ok」的集成断言。
 * 运行：node --test scripts/docs/check_beginner_docs.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkSection, checkBeginnerDocs } = require('./check_beginner_docs.js');

/** 在临时 repoRoot 下铺一个目录 + 文件，返回 { repoRoot, section }。 */
function scaffold(files, sectionOverrides = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beginner-docs-'));
  const rel = 'docs/t';
  const absDir = path.join(repoRoot, rel);
  fs.mkdirSync(absDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(absDir, name), body, 'utf8');
  }
  const section = Object.assign({ dir: rel, kind: 'concept', requireFanren: false, numberPrefix: null }, sectionOverrides);
  return { repoRoot, section };
}

function kinds(problems) {
  return problems.map((p) => p.kind);
}

test('好样本：索引挂全、有同目录导航、编号连续 → 无问题', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [一](./[CONCEPT-01]%20a.md)\n- [二](./[CONCEPT-02]%20b.md)\n',
    '[CONCEPT-01] a.md': '正文一\n👉 [下一篇](./[CONCEPT-02]%20b.md)\n',
    '[CONCEPT-02] b.md': '正文二\n👈 [回索引](./00_INDEX_x.md)\n',
  }, { numberPrefix: 'CONCEPT' });
  assert.deepStrictEqual(checkSection(repoRoot, section), []);
});

test('坏样本 orphan：内容文档未被索引挂链接', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [一](./a.md)\n',
    'a.md': '正文一\n[回索引](./00_INDEX_x.md)\n',
    'b.md': '正文二（孤儿）\n[回索引](./00_INDEX_x.md)\n',
  });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('orphan'), '应检出 orphan，实际: ' + k.join(','));
});

test('坏样本 dead-index-link：索引指向本目录不存在的兄弟文件', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [一](./a.md)\n- [缺](./missing.md)\n',
    'a.md': '正文一\n[回索引](./00_INDEX_x.md)\n',
  });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('dead-index-link'), '应检出 dead-index-link，实际: ' + k.join(','));
});

test('坏样本 dead-end：内容文档无任何同目录导航链接', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [一](./a.md)\n',
    'a.md': '正文，只有外链\n[某外部](../02_CONCEPTS_概念入门/x.md)\n',
  });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('dead-end'), '应检出 dead-end，实际: ' + k.join(','));
});

test('坏样本 no-fanren：故事类目录缺 📒 凡人笔记', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [章一](./c1.md)\n',
    'c1.md': '# 第一章\n剧情……\n[回总目录](./00_INDEX_x.md)\n',
  }, { kind: 'story', requireFanren: true });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('no-fanren'), '应检出 no-fanren，实际: ' + k.join(','));
});

test('好样本 story：有 📒 凡人笔记则不报 no-fanren', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [章一](./c1.md)\n',
    'c1.md': '# 第一章\n剧情……\n## 📒 凡人笔记\n翻译表\n[回总目录](./00_INDEX_x.md)\n',
  }, { kind: 'story', requireFanren: true });
  assert.deepStrictEqual(checkSection(repoRoot, section), []);
});

test('坏样本 number-gap：CONCEPT 编号跳号', () => {
  const { repoRoot, section } = scaffold({
    '00_INDEX_x.md': '# 索引\n- [一](./[CONCEPT-01]%20a.md)\n- [三](./[CONCEPT-03]%20c.md)\n',
    '[CONCEPT-01] a.md': '正文\n[回索引](./00_INDEX_x.md)\n',
    '[CONCEPT-03] c.md': '正文\n[回索引](./00_INDEX_x.md)\n',
  }, { numberPrefix: 'CONCEPT' });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('number-gap'), '应检出 number-gap，实际: ' + k.join(','));
});

test('缺索引：目录没有 00_INDEX 报 missing-index', () => {
  const { repoRoot, section } = scaffold({ 'a.md': '孤零零\n' });
  const k = kinds(checkSection(repoRoot, section));
  assert.ok(k.includes('missing-index'), '应检出 missing-index，实际: ' + k.join(','));
});

test('集成守卫：真实仓库树必须体检全绿（ok===true）', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const result = checkBeginnerDocs(repoRoot);
  assert.strictEqual(result.ok, true, '真实文档树体检未通过:\n' + JSON.stringify(result.problems, null, 2));
});
