'use strict';

/**
 * grepWindowsDriveKey.test.js — 纯叶子契约 + smartTruncation._filterSearchOutput 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、resolveGrepSeparatorIndex(Windows
 * 盘符行取盘符冒号之后·Linux/无盘符行等于 indexOf(':')·门关返 null)、fail-soft;
 * smartTruncation 真跑门开(Windows 400 文件不再塌成 4 行)/ 门关(逐字节回退)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/grepWindowsDriveKey'));

test('grepWinDriveDedupEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.grepWinDriveDedupEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.grepWinDriveDedupEnabled({ KHY_GREP_WIN_DRIVE_DEDUP: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.grepWinDriveDedupEnabled({ KHY_GREP_WIN_DRIVE_DEDUP: 'yep' }), true); // 非 CANON → 开
});

test('resolveGrepSeparatorIndex: Windows drive line → colon after drive', () => {
  // `C:\proj\file.js:1:content` — 盘符冒号在 1,真分隔冒号在 file.js 之后。
  const line = 'C:\\proj\\file.js:1:const x = 0;';
  const idx = leaf.resolveGrepSeparatorIndex(line, {});
  assert.strictEqual(idx, line.indexOf(':', 2));
  assert.strictEqual(line.slice(0, idx), 'C:\\proj\\file.js'); // 真文件名,不再是 "C"
});

test('resolveGrepSeparatorIndex: forward-slash drive form also handled', () => {
  const line = 'D:/repo/a.ts:42:x';
  const idx = leaf.resolveGrepSeparatorIndex(line, {});
  assert.strictEqual(line.slice(0, idx), 'D:/repo/a.ts');
});

test('resolveGrepSeparatorIndex: Linux/non-drive line == indexOf(":") (byte-equiv)', () => {
  for (const line of ['/proj/file.js:1:content', 'relative/a.js:3:y', 'no-colon-line', 'plain:value']) {
    assert.strictEqual(leaf.resolveGrepSeparatorIndex(line, {}), line.indexOf(':'), line);
  }
});

test('resolveGrepSeparatorIndex: gate OFF → null (caller reverts to indexOf)', () => {
  const line = 'C:\\proj\\file.js:1:x';
  assert.strictEqual(leaf.resolveGrepSeparatorIndex(line, { KHY_GREP_WIN_DRIVE_DEDUP: '0' }), null);
});

test('fail-soft: never throws on bad input', () => {
  assert.doesNotThrow(() => leaf.resolveGrepSeparatorIndex(null, {}));
  assert.doesNotThrow(() => leaf.resolveGrepSeparatorIndex(123, {}));
  assert.doesNotThrow(() => leaf.grepWinDriveDedupEnabled(undefined));
  assert.strictEqual(leaf.resolveGrepSeparatorIndex(null, {}), null);
});

// ── smartTruncation 接线(真跑 grep noise filter)─────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function winGrepText(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`C:\\proj\\file${i}.js:1:const x = ${i};`);
  return lines.join('\n');
}

test('smartTruncation: gate ON → Windows distinct files no longer collapse to one bucket', () => {
  withEnv({ KHY_GREP_WIN_DRIVE_DEDUP: undefined }, () => {
    delete require.cache[require.resolve('../src/services/smartTruncation')];
    delete require.cache[require.resolve('../src/services/grepWindowsDriveKey')];
    const st = require('../src/services/smartTruncation');
    const out = st.truncate('grep', winGrepText(400), {});
    const kept = out.text.split('\n').length;
    assert.ok(kept > 100, `expected many lines kept, got ${kept}`);
    assert.ok(!out.text.includes('(more matches in C)'), 'must not bucket under bogus "C"');
  });
});

test('smartTruncation: gate OFF → legacy collapse (byte-revert, all under "C")', () => {
  withEnv({ KHY_GREP_WIN_DRIVE_DEDUP: '0' }, () => {
    delete require.cache[require.resolve('../src/services/smartTruncation')];
    delete require.cache[require.resolve('../src/services/grepWindowsDriveKey')];
    const st = require('../src/services/smartTruncation');
    const out = st.truncate('grep', winGrepText(400), {});
    const kept = out.text.split('\n').length;
    assert.strictEqual(kept, 4, `legacy collapses to 4 lines, got ${kept}`);
    assert.ok(out.text.includes('(more matches in C)'), 'legacy buckets under "C"');
  });
});
