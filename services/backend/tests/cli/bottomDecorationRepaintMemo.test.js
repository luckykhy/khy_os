'use strict';

/**
 * bottomDecorationRepaintMemo 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - buildPrefix:与「历史整串去掉末尾光标复位」逐字节一致(rowsBelowCursor=0 / >0 · gapRows 0/1/2)。
 *  - getPrefix:同 (rowsBelowCursor,gapRows,rule,footer) 命中单槽复用 · 任一字段变则重拼 · 门控关每次现拼 ·
 *    key 缺失安全 · 异常不抛。
 *  - getRepaint:前缀 + `\x1b[{col+1}G` 尾部 · cursorCol 变只换尾部(前缀命中) · 缺 cursorCol → col 0。
 *  - **byte-identity**:getRepaint(memo) == 参考实现(每键全量现拼)对一批 metrics 逐字节一致(ON & OFF)。
 *  - LIVE wiring:repl.js 经 bottomDecorationRepaintMemo 委托。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/repl/bottomDecorationRepaintMemo');

// 参考实现:repl.js 历史 _computeBottomDecorationRepaint 的等价体(用于 byte-identity 断言)。
function refRepaint(rowsBelowCursor, gapRows, rule, footer, cursorCol) {
  let out = '';
  if (rowsBelowCursor > 0) out += `\x1b[${rowsBelowCursor}B`;
  for (let i = 0; i < gapRows; i++) out += '\x1b[1B\x1b[2K\x1b[1G';
  out += '\x1b[1B\x1b[2K\x1b[1G' + rule;
  out += '\x1b[1B\x1b[2K\x1b[1G' + footer;
  const rowsReturn = rowsBelowCursor + gapRows + 2;
  if (rowsReturn > 0) out += `\x1b[${rowsReturn}A`;
  out += `\x1b[${cursorCol + 1}G`;
  return out;
}

const RULE = '\x1b[38;2;215;119;87m' + '─'.repeat(60) + '\x1b[39m';
const FOOTER = '\x1b[2m! for shell · esc to cancel\x1b[22m';

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_BOTTOM_DECORATION_REPAINT_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_BOTTOM_DECORATION_REPAINT_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('buildPrefix: matches reference minus trailing cursor-restore', () => {
  for (const rbc of [0, 1, 3]) {
    for (const gap of [0, 1, 2]) {
      const prefix = memo.buildPrefix(rbc, gap, RULE, FOOTER);
      const full = refRepaint(rbc, gap, RULE, FOOTER, 7);
      // full = prefix + `\x1b[8G`
      assert.equal(prefix + '\x1b[8G', full, `rbc=${rbc} gap=${gap}`);
    }
  }
});

test('getPrefix: same tuple → single slot reuse', () => {
  memo._clear();
  const key = { rowsBelowCursor: 0, gapRows: 1, rule: RULE, footer: FOOTER };
  const a = memo.getPrefix(key, {});
  const b = memo.getPrefix({ rowsBelowCursor: 0, gapRows: 1, rule: RULE, footer: FOOTER }, {});
  assert.equal(a, b);
  assert.equal(memo._hasSlot(), true);
});

test('getPrefix: any field change → rebuild', () => {
  memo._clear();
  const base = { rowsBelowCursor: 0, gapRows: 1, rule: RULE, footer: FOOTER };
  const p0 = memo.getPrefix(base, {});
  const p1 = memo.getPrefix({ ...base, rowsBelowCursor: 2 }, {});
  const p2 = memo.getPrefix({ ...base, rowsBelowCursor: 2, footer: 'X' }, {});
  assert.notEqual(p0, p1, 'rowsBelowCursor change alters prefix');
  assert.notEqual(p1, p2, 'footer change alters prefix');
});

test('getPrefix: gate off → still correct (no slot dependence)', () => {
  memo._clear();
  const off = { KHY_BOTTOM_DECORATION_REPAINT_MEMO: 'off' };
  const p = memo.getPrefix({ rowsBelowCursor: 1, gapRows: 2, rule: RULE, footer: FOOTER }, off);
  assert.equal(p + '\x1b[5G', refRepaint(1, 2, RULE, FOOTER, 4));
  assert.equal(memo._hasSlot(), false, 'gate off does not populate slot');
});

test('getPrefix: missing key safe', () => {
  memo._clear();
  assert.doesNotThrow(() => memo.getPrefix(null, {}));
  assert.doesNotThrow(() => memo.getPrefix(undefined, { KHY_BOTTOM_DECORATION_REPAINT_MEMO: 'off' }));
});

test('getRepaint: cursorCol change only swaps trailing restore (prefix cached)', () => {
  memo._clear();
  const base = { rowsBelowCursor: 0, gapRows: 1, rule: RULE, footer: FOOTER };
  const r5 = memo.getRepaint({ ...base, cursorCol: 5 }, {});
  const r6 = memo.getRepaint({ ...base, cursorCol: 6 }, {});
  assert.ok(r5.endsWith('\x1b[6G'), 'col 5 → 6G');
  assert.ok(r6.endsWith('\x1b[7G'), 'col 6 → 7G');
  // prefixes identical
  assert.equal(r5.slice(0, -('\x1b[6G'.length)), r6.slice(0, -('\x1b[7G'.length)));
});

test('getRepaint: missing cursorCol → col 0', () => {
  memo._clear();
  const r = memo.getRepaint({ rowsBelowCursor: 0, gapRows: 1, rule: RULE, footer: FOOTER }, {});
  assert.ok(r.endsWith('\x1b[1G'), 'default col 0 → 1G');
});

test('byte-identity: getRepaint == reference across metrics sweep (ON & OFF)', () => {
  const cases = [];
  for (const rbc of [0, 1, 2, 4]) {
    for (const gap of [0, 1, 2]) {
      for (const col of [0, 1, 5, 40, 79]) {
        cases.push({ rowsBelowCursor: rbc, gapRows: gap, rule: RULE, footer: FOOTER, cursorCol: col });
      }
    }
  }
  for (const env of [{ KHY_BOTTOM_DECORATION_REPAINT_MEMO: 'on' }, { KHY_BOTTOM_DECORATION_REPAINT_MEMO: 'off' }]) {
    memo._clear();
    for (const k of cases) {
      const got = memo.getRepaint(k, env);
      const want = refRepaint(k.rowsBelowCursor, k.gapRows, k.rule, k.footer, k.cursorCol);
      assert.equal(got, want, `env=${JSON.stringify(env)} ${JSON.stringify({ ...k, rule: 'RULE', footer: 'FOOTER' })}`);
    }
  }
});

test('LIVE wiring: repl.js delegates through bottomDecorationRepaintMemo', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(/require\(['"]\.\/repl\/bottomDecorationRepaintMemo['"]\)/.test(src), 'requires the memo');
  assert.ok(/_bdrMemo\.getRepaint\(/.test(src), 'delegates via getRepaint');
  assert.ok(/function _computeBottomDecorationRepaint\(/.test(src), 'original body preserved as _computeBottomDecorationRepaint fallback');
});
