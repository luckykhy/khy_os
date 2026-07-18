'use strict';

/**
 * archDebtScan --god-report — the split backlog the single maintainer works
 * from. R2 already grandfathers existing god files in the baseline; this report
 * turns "acknowledged debt" into a ranked, actionable split worklist. node:test.
 */

const test = require('node:test');
const assert = require('node:assert');

const scan = require('../../scripts/archDebtScan');

test('scanGodReport: ranked by overage, with structural split seams', () => {
  const items = scan.scanGodReport(scan.SRC_DIR, scan.GOD_FILE_LOC);
  assert.ok(Array.isArray(items));
  assert.ok(items.length > 0, 'repo has known god files in the baseline');

  for (const it of items) {
    assert.ok(typeof it.file === 'string' && it.file.length > 0);
    assert.ok(it.loc > scan.GOD_FILE_LOC, 'only files over the ceiling appear');
    assert.strictEqual(it.overBy, it.loc - scan.GOD_FILE_LOC);
    assert.ok(it.suggestedFiles >= 2, 'a god file splits into at least 2');
    for (const k of ['topLevelFns', 'classes', 'exports', 'sectionBanners']) {
      assert.ok(Number.isInteger(it[k]) && it[k] >= 0, `${k} is a count`);
    }
  }
  // descending by overBy
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].overBy >= items[i].overBy, 'sorted by overage desc');
  }
});

test('a tighter ceiling surfaces strictly more (or equal) god files', () => {
  const loose = scan.scanGodReport(scan.SRC_DIR, 100000);
  const tight = scan.scanGodReport(scan.SRC_DIR, 1000);
  assert.ok(tight.length >= loose.length);
});

test('formatGodReport renders a human-readable backlog', () => {
  const items = scan.scanGodReport(scan.SRC_DIR, scan.GOD_FILE_LOC);
  const text = scan.formatGodReport(items, scan.GOD_FILE_LOC);
  assert.match(text, /上帝组件拆分待办/);
  assert.match(text, /单文件行数上限/);
  if (items.length) assert.match(text, /建议拆成|→\s*\d+ 个文件/);
});

test('empty backlog (impossibly high ceiling) renders the all-clear line', () => {
  const text = scan.formatGodReport([], 100000);
  assert.match(text, /没有上帝组件/);
});

test('main(--god-report) is read-only and exits 0', () => {
  // capture stdout, assert no throw and exit code 0
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try { code = scan.main(['--god-report']); }
  finally { process.stdout.write = orig; }
  assert.strictEqual(code, 0);
  assert.match(chunks.join(''), /上帝组件拆分待办/);
});
