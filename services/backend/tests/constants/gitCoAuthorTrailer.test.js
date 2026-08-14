'use strict';

/**
 * gitCoAuthorTrailer.test.js — 纯叶子:提交尾注 Co-Authored-By 单一真源。
 *
 * 验收要点:
 *  - 门控 KHY_GIT_COAUTHOR_TRAILER:未设/非关键字 → 开;0/false/off/no → 关。
 *  - 门开 → 正文后以恰一空行分隔追加默认尾注行。
 *  - 幂等:message 已含 Co-Authored-By 行 → 原样返回,不重复。
 *  - 门关 → 逐字节原样返回(无尾注)。
 *  - env KHY_GIT_COAUTHOR_TRAILER_LINE 合法覆盖 → 用覆盖行;非法/空 → 回默认。
 *  - 非字符串 / 空正文 → fail-soft 原样返回。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/constants/gitCoAuthorTrailer');

test('isEnabled: 未设/非关键字 → 开;0/false/off/no(含大小写/空白) → 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_GIT_COAUTHOR_TRAILER: off }), false, `off: ${off}`);
  }
});

test('门开 → 正文后以恰一空行分隔追加默认尾注', () => {
  const out = leaf.appendCoAuthorTrailer('feat: add x', {});
  assert.equal(out, `feat: add x\n\n${leaf.DEFAULT_TRAILER}`);
  // 正文与尾注间恰一个空行(两个换行)
  assert.match(out, /add x\n\nCo-Authored-By:/);
});

test('多行正文 → 尾注追加在末尾,body 尾部空白被规整', () => {
  const msg = 'feat: add x\n\nbody line 1\nbody line 2\n\n';
  const out = leaf.appendCoAuthorTrailer(msg, {});
  assert.equal(out, `feat: add x\n\nbody line 1\nbody line 2\n\n${leaf.DEFAULT_TRAILER}`);
});

test('幂等:已含 Co-Authored-By 行 → 原样返回不重复', () => {
  const msg = `feat: add x\n\n${leaf.DEFAULT_TRAILER}`;
  assert.equal(leaf.appendCoAuthorTrailer(msg, {}), msg);
  // 大小写/别的作者也算已存在
  const other = 'feat: y\n\nco-authored-by: Alice <a@example.com>';
  assert.equal(leaf.appendCoAuthorTrailer(other, {}), other);
});

test('门关 → 逐字节原样返回(无尾注)', () => {
  const msg = 'feat: add x';
  assert.equal(leaf.appendCoAuthorTrailer(msg, { KHY_GIT_COAUTHOR_TRAILER: 'off' }), msg);
});

test('env 覆盖:合法尾注行被采用;非法/空回默认', () => {
  const custom = 'Co-Authored-By: Bob <bob@example.com>';
  const out = leaf.appendCoAuthorTrailer('feat: z', { KHY_GIT_COAUTHOR_TRAILER_LINE: custom });
  assert.equal(out, `feat: z\n\n${custom}`);
  // 非法覆盖(缺 <email>)→ 回默认
  const bad = leaf.appendCoAuthorTrailer('feat: z', { KHY_GIT_COAUTHOR_TRAILER_LINE: 'not a trailer' });
  assert.equal(bad, `feat: z\n\n${leaf.DEFAULT_TRAILER}`);
  // 空覆盖 → 回默认
  const empty = leaf.appendCoAuthorTrailer('feat: z', { KHY_GIT_COAUTHOR_TRAILER_LINE: '   ' });
  assert.equal(empty, `feat: z\n\n${leaf.DEFAULT_TRAILER}`);
});

test('resolveTrailerLine: 合法覆盖优先,否则默认', () => {
  assert.equal(leaf.resolveTrailerLine({}), leaf.DEFAULT_TRAILER);
  assert.equal(
    leaf.resolveTrailerLine({ KHY_GIT_COAUTHOR_TRAILER_LINE: 'Co-Authored-By: C <c@x.io>' }),
    'Co-Authored-By: C <c@x.io>',
  );
});

test('非字符串 message → fail-soft 原样返回', () => {
  assert.equal(leaf.appendCoAuthorTrailer(null, {}), null);
  assert.equal(leaf.appendCoAuthorTrailer(undefined, {}), undefined);
  assert.deepEqual(leaf.appendCoAuthorTrailer(42, {}), 42);
});

test('空/纯空白正文 → 不塑形,原样返回', () => {
  assert.equal(leaf.appendCoAuthorTrailer('', {}), '');
  assert.equal(leaf.appendCoAuthorTrailer('   \n  ', {}), '   \n  ');
});
