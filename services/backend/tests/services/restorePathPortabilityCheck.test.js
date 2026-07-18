'use strict';

/**
 * Unit tests for restorePathPortabilityCheck.js — bundled 运行时纯叶，解包前把归档条目名逐条
 * 按五类跨 OS 命名危害分类（Windows 保留设备名 / 非法字符 / 结尾点空格 / 超 MAX_PATH / 大小写碰撞），
 * 并按宿主系统渲染一行诚实横幅（run via `node --test`）。
 *
 * 覆盖:
 *   - reserved:          con.txt / NUL / com1（大小写与扩展名无关）→ 命中 reserved。
 *   - illegalChar:       a:b.js / p*.md / q?.txt / 控制字符 → 命中 illegalChar；空格 / 连字符不误报。
 *   - trailingDotSpace:  foo. / bar<空格> → 命中；'.' / '..' 导航段不误报。
 *   - tooLong:           全路径 > 259 → 命中 tooLong。
 *   - caseCollision:     Foo.js vs foo.js → 双方入桶；仅大小写不同才算。
 *   - 干净集:            全合法 → ok:true, hazardTotal:0, 横幅 null。
 *   - host-aware 横幅:   win32→warn(全类)；darwin→碰撞 warn / 其余 info；linux→有危害 info、无危害 null。
 *   - 例名截断:          横幅每类例名 ≤3，超出附 '…'。
 *   - 畸形入参绝不抛:    null / 非数组 / 含非串元素 → 保守空裁决。
 *   - 红线:              裁决对象不含任何密钥（只放条目名）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const M = require('../../src/services/restorePathPortabilityCheck');
const {
  assessPathPortability,
  buildPortabilityBannerLine,
  HAZARD_KINDS,
  _isReservedSegment,
  _hasIllegalChar,
  _hasTrailingDotSpace,
  _classifyEntry,
} = M;

// ── reserved ──────────────────────────────────────────────────────────────────
test('保留设备名：con.txt / NUL / com1 命中 reserved', () => {
  const v = assessPathPortability(['src/con.txt', 'NUL', 'a/com1', 'a/LPT9.log']);
  assert.strictEqual(v.counts.reserved, 4);
  assert.strictEqual(v.ok, false);
});

test('保留设备名大小写无关、扩展名无关', () => {
  assert.strictEqual(_isReservedSegment('CON'), true);
  assert.strictEqual(_isReservedSegment('con'), true);
  assert.strictEqual(_isReservedSegment('Con.txt'), true);
  assert.strictEqual(_isReservedSegment('aux.tar.gz'), true);
  // 非保留：主名后带数字/字母不在集合
  assert.strictEqual(_isReservedSegment('com10'), false);
  assert.strictEqual(_isReservedSegment('console.js'), false);
  assert.strictEqual(_isReservedSegment('readme.md'), false);
});

// ── illegalChar ───────────────────────────────────────────────────────────────
test('非法字符：冒号/星号/问号/引号/竖线/尖括号 命中', () => {
  for (const n of ['a:b.js', 'p*.md', 'q?.txt', 'x"y', 'a|b', 'a<b', 'a>b']) {
    assert.strictEqual(_hasIllegalChar(n), true, n);
  }
});

test('非法字符：空格 / 连字符 / 普通名 不误报', () => {
  for (const n of ['my file.js', 'foo-bar.js', 'readme.md', 'a.b.c', '路径.txt']) {
    assert.strictEqual(_hasIllegalChar(n), false, n);
  }
});

test('非法字符：控制字符命中', () => {
  assert.strictEqual(_hasIllegalChar('ab'), true);
  assert.strictEqual(_hasIllegalChar('tab\tinside'), true); // \t = 0x09
});

// ── trailingDotSpace ─────────────────────────────────────────────────────────
test('结尾点/空格段命中；导航段与普通名不误报', () => {
  assert.strictEqual(_hasTrailingDotSpace('foo.'), true);
  assert.strictEqual(_hasTrailingDotSpace('bar '), true);
  assert.strictEqual(_hasTrailingDotSpace('foo.js'), false);
  assert.strictEqual(_hasTrailingDotSpace('foo'), false);
  // '.' / '..' 作为整段由 _segments 过滤，不进入 trailing 判定
  const v = assessPathPortability(['a/./b', 'a/../b']);
  assert.strictEqual(v.counts.trailingDotSpace, 0);
});

test('trailing 命中整条：dir 段结尾空格也算', () => {
  const v = assessPathPortability(['space /file.js', 'ok/dir.']);
  assert.strictEqual(v.counts.trailingDotSpace, 2);
});

// ── tooLong ───────────────────────────────────────────────────────────────────
test('超 259 字符命中 tooLong', () => {
  const long = 'd/' + 'x'.repeat(300);
  const v = assessPathPortability([long, 'short.js']);
  assert.strictEqual(v.counts.tooLong, 1);
  assert.strictEqual(v.hazards.tooLong[0], long);
});

test('恰 259 字符不命中，260 命中', () => {
  const at259 = 'a'.repeat(259);
  const at260 = 'a'.repeat(260);
  assert.strictEqual(assessPathPortability([at259]).counts.tooLong, 0);
  assert.strictEqual(assessPathPortability([at260]).counts.tooLong, 1);
});

// ── caseCollision ─────────────────────────────────────────────────────────────
test('大小写碰撞：Foo.js vs foo.js 双方入桶', () => {
  const v = assessPathPortability(['a/Foo.js', 'a/foo.js', 'a/bar.js']);
  assert.strictEqual(v.counts.caseCollision, 2);
  assert.ok(v.hazards.caseCollision.includes('a/Foo.js'));
  assert.ok(v.hazards.caseCollision.includes('a/foo.js'));
});

test('同名重复（完全相等）不算碰撞（Set 去重）', () => {
  const v = assessPathPortability(['a/x.js', 'a/x.js']);
  assert.strictEqual(v.counts.caseCollision, 0);
});

test('不同目录同文件名不算碰撞（全路径不同小写）', () => {
  const v = assessPathPortability(['a/x.js', 'b/x.js']);
  assert.strictEqual(v.counts.caseCollision, 0);
});

// ── 干净集 ────────────────────────────────────────────────────────────────────
test('全合法 → ok:true, hazardTotal:0, 横幅 null', () => {
  const v = assessPathPortability(['src/index.js', 'README.md', 'my file.js', 'foo-bar/baz.ts']);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.hazardTotal, 0);
  assert.strictEqual(buildPortabilityBannerLine(v, { hostPlatform: 'win32' }), null);
  assert.strictEqual(buildPortabilityBannerLine(v, { hostPlatform: 'linux' }), null);
});

// ── host-aware 横幅 ───────────────────────────────────────────────────────────
test('win32：任何危害 → severity warn', () => {
  const v = assessPathPortability(['con.txt']);
  const b = buildPortabilityBannerLine(v, { hostPlatform: 'win32' });
  assert.ok(b);
  assert.strictEqual(b.severity, 'warn');
  assert.match(b.line, /Windows/);
  assert.match(b.line, /保留设备名/);
});

test('darwin：仅碰撞 → warn；仅 Windows 专属危害 → info', () => {
  const collide = assessPathPortability(['A.js', 'a.js']);
  assert.strictEqual(buildPortabilityBannerLine(collide, { hostPlatform: 'darwin' }).severity, 'warn');

  const winOnly = assessPathPortability(['con.txt']);
  assert.strictEqual(buildPortabilityBannerLine(winOnly, { hostPlatform: 'darwin' }).severity, 'info');
});

test('linux：有危害 → info（跨 OS 提醒）；无危害 → null', () => {
  const v = assessPathPortability(['con.txt', 'A.js', 'a.js']);
  const b = buildPortabilityBannerLine(v, { hostPlatform: 'linux' });
  assert.strictEqual(b.severity, 'info');
  assert.match(b.line, /Windows \/ macOS/);
});

test('横幅缺 host（未知平台）→ 有危害走 info 分支', () => {
  const v = assessPathPortability(['con.txt']);
  const b = buildPortabilityBannerLine(v, {});
  assert.strictEqual(b.severity, 'info');
});

// ── 例名截断 ──────────────────────────────────────────────────────────────────
test('横幅每类例名 ≤3 且超出附 …', () => {
  const many = ['con.a', 'con.b', 'con.c', 'con.d', 'con.e'];
  const v = assessPathPortability(many);
  assert.strictEqual(v.counts.reserved, 5);
  const b = buildPortabilityBannerLine(v, { hostPlatform: 'win32' });
  // 例名最多列 3 个 + 省略号
  assert.match(b.line, /con\.a、con\.b、con\.c …/);
  assert.ok(!b.line.includes('con.d'));
});

// ── 多类共存 ──────────────────────────────────────────────────────────────────
test('多类危害共存：counts 各自计数，hazardTotal 求和', () => {
  const v = assessPathPortability(['con.txt', 'a:b.js', 'foo.', 'A.js', 'a.js']);
  assert.strictEqual(v.counts.reserved, 1);
  assert.strictEqual(v.counts.illegalChar, 1);
  assert.strictEqual(v.counts.trailingDotSpace, 1);
  assert.strictEqual(v.counts.caseCollision, 2);
  assert.strictEqual(v.hazardTotal, 5);
  assert.strictEqual(v.ok, false);
});

// ── 畸形入参绝不抛 ─────────────────────────────────────────────────────────────
test('畸形入参绝不抛 → 保守空裁决', () => {
  for (const x of [null, undefined, 'x', 42, {}, true]) {
    assert.doesNotThrow(() => assessPathPortability(x));
    const v = assessPathPortability(x);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.total, 0);
    assert.strictEqual(v.hazardTotal, 0);
  }
});

test('数组含非串元素 → 过滤后只评估字符串', () => {
  const v = assessPathPortability(['con.txt', null, 42, undefined, {}, 'ok.js']);
  assert.strictEqual(v.total, 2); // 只有两个字符串
  assert.strictEqual(v.counts.reserved, 1);
});

test('buildPortabilityBannerLine 畸形裁决绝不抛 → null', () => {
  for (const x of [null, undefined, 'x', 42, [], {}, { hazardTotal: 0 }]) {
    assert.doesNotThrow(() => buildPortabilityBannerLine(x, { hostPlatform: 'win32' }));
    assert.strictEqual(buildPortabilityBannerLine(x, { hostPlatform: 'win32' }), null);
  }
});

// ── 红线：裁决对象不含密钥 ─────────────────────────────────────────────────────
test('红线：裁决对象只含条目名，不含任何密钥字段', () => {
  const v = assessPathPortability(['con.txt', 'a:b.js']);
  const json = JSON.stringify(v);
  assert.ok(!/secret|key|password|token|cipher/i.test(json));
});

// ── _classifyEntry 直测 ───────────────────────────────────────────────────────
test('_classifyEntry 返回命中 kind 列表', () => {
  assert.deepStrictEqual(_classifyEntry('src/index.js'), []);
  assert.deepStrictEqual(_classifyEntry('con.txt'), ['reserved']);
  const hits = _classifyEntry('a:b/CON.');
  assert.ok(hits.includes('reserved'));       // 段 CON. 主名 CON
  assert.ok(hits.includes('illegalChar'));    // 段 a:b 含冒号
  assert.ok(hits.includes('trailingDotSpace')); // 段 CON. 结尾点
});

test('HAZARD_KINDS 齐五类', () => {
  assert.deepStrictEqual(HAZARD_KINDS, ['reserved', 'illegalChar', 'trailingDotSpace', 'tooLong', 'caseCollision']);
});
