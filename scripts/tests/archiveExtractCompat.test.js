'use strict';

/**
 * archiveExtractCompat.test.js — 还原「解密后内层归档形制可提取性」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/archiveExtractCompat.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 保守优先：头缺失 / 数组 / plaintextFormat 类型错 → unverifiable，绝不谎报 supported；
 *   · plaintextFormat 不在本机解包器支持集 → unsupported-format（离机断桥要抓的盲目 tar -xzf 假绿）；
 *   · 格式可解压但 layout 存在且陌生 → unknown-layout（能解开却不认识内部布局）；
 *   · layout 缺省是老快照合法情形 → 格式支持即 supported，不因缺 layout 卡死；
 *   · ok===true 当且仅当 status==='supported'；
 *   · 任何畸形输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const M = require('../lib/archiveExtractCompat');
const {
  checkArchiveExtractCompat,
  SUPPORTED_PLAINTEXT_FORMATS, SUPPORTED_LAYOUTS,
  STATUS_SUPPORTED, STATUS_UNSUPPORTED_FORMAT,
  STATUS_UNKNOWN_LAYOUT, STATUS_UNVERIFIABLE,
  _isNonEmptyStr, _inList,
} = M;

// 与真实 shipped snapshot.json 对齐的最小合法头。
function goodHeader(over = {}) {
  return { plaintextFormat: SUPPORTED_PLAINTEXT_FORMATS[0], layout: SUPPORTED_LAYOUTS[0], ...over };
}

// ── 档 4：supported（唯一 ok:true）─────────────────────────────────────────────

test('认识的 plaintextFormat + 认识的 layout → supported + ok:true', () => {
  const r = checkArchiveExtractCompat(goodHeader());
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plaintextFormat, 'tar.gz');
  assert.strictEqual(r.layout, 'git-archive');
});

test('真实 shipped 头形制（tar.gz / git-archive）→ supported', () => {
  // 对齐 packaging/npm/bundled/_source/snapshot.json 的真实盖章值。
  const r = checkArchiveExtractCompat({
    format: 'khy-source-snapshot', formatVersion: 1,
    layout: 'git-archive', plaintextFormat: 'tar.gz',
    captureMode: 'working-tree', includesUncommitted: true,
  });
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

test('layout 缺省（老快照）+ 支持的格式 → 仍 supported（向后兼容，不因缺 layout 卡死）', () => {
  const h = goodHeader();
  delete h.layout;
  const r = checkArchiveExtractCompat(h);
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.layout, null);
});

test('layout 为空串 + 支持的格式 → 视同缺省，supported', () => {
  const r = checkArchiveExtractCompat(goodHeader({ layout: '' }));
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

// ── 档 2：unsupported-format（核心断桥）────────────────────────────────────────

test('未来 tar.zst 格式 → unsupported-format + ok:false（旧 khy 盲目 tar -xzf 的假绿）', () => {
  const r = checkArchiveExtractCompat(goodHeader({ plaintextFormat: 'tar.zst' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_FORMAT);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /升级 khy|解不开/);
});

test('zip 格式 → unsupported-format + ok:false', () => {
  const r = checkArchiveExtractCompat(goodHeader({ plaintextFormat: 'zip' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_FORMAT);
  assert.strictEqual(r.ok, false);
});

test('不支持的格式优先于 layout 判定（先抓格式不支持）', () => {
  // 格式不支持 + layout 也陌生：应命中 unsupported-format（更保守、更靠前）。
  const r = checkArchiveExtractCompat({ plaintextFormat: 'zip', layout: 'weird-layout' });
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_FORMAT);
});

// ── 档 3：unknown-layout ───────────────────────────────────────────────────────

test('格式支持但 layout 陌生 → unknown-layout + ok:false（能解压却不认识布局）', () => {
  const r = checkArchiveExtractCompat(goodHeader({ layout: 'full-fs-with-git' }));
  assert.strictEqual(r.status, STATUS_UNKNOWN_LAYOUT);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /布局|原样/);
});

// ── 档 1：unverifiable（保守）──────────────────────────────────────────────────

test('null 头 → unverifiable + ok:false', () => {
  const r = checkArchiveExtractCompat(null);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('数组头 → unverifiable（typeof []==="object" 经典陷阱须显式排除）', () => {
  const r = checkArchiveExtractCompat([]);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('非对象（字符串 / 数字）头 → unverifiable', () => {
  for (const bad of ['x', 42, true]) {
    const r = checkArchiveExtractCompat(bad);
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE, `input=${JSON.stringify(bad)}`);
    assert.strictEqual(r.ok, false);
  }
});

test('plaintextFormat 缺失 → unverifiable', () => {
  const h = goodHeader();
  delete h.plaintextFormat;
  const r = checkArchiveExtractCompat(h);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('plaintextFormat 非字符串（数字 / 空串）→ unverifiable', () => {
  for (const bad of [1, '', null, {}]) {
    const r = checkArchiveExtractCompat(goodHeader({ plaintextFormat: bad }));
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE, `pf=${JSON.stringify(bad)}`);
  }
});

// ── 恒久红线 & 纯度 ────────────────────────────────────────────────────────────

test('ok===true 当且仅当 status==="supported"', () => {
  const supported = checkArchiveExtractCompat(goodHeader());
  assert.strictEqual(supported.ok, true);
  for (const r of [
    checkArchiveExtractCompat(null),
    checkArchiveExtractCompat([]),
    checkArchiveExtractCompat(goodHeader({ plaintextFormat: 'zip' })),
    checkArchiveExtractCompat(goodHeader({ layout: 'weird' })),
  ]) {
    assert.strictEqual(r.ok, r.status === STATUS_SUPPORTED);
    assert.strictEqual(r.ok, false);
  }
});

test('裁决始终带支持集快照（供 CLI/文档呈现，且是新副本不外泄内部数组引用）', () => {
  const r = checkArchiveExtractCompat(goodHeader());
  assert.deepStrictEqual(r.supportedFormats, SUPPORTED_PLAINTEXT_FORMATS);
  assert.deepStrictEqual(r.supportedLayouts, SUPPORTED_LAYOUTS);
  r.supportedFormats.push('tampered');
  assert.strictEqual(SUPPORTED_PLAINTEXT_FORMATS.includes('tampered'), false);
});

test('任何畸形输入绝不抛', () => {
  const weird = [undefined, null, NaN, [], {}, '', 0, false, Symbol('x'),
    { plaintextFormat: [] }, { plaintextFormat: 'tar.gz', layout: 99 }];
  for (const w of weird) {
    assert.doesNotThrow(() => checkArchiveExtractCompat(w));
  }
});

test('layout 为非串（数字）但格式支持 → 视同缺省 supported（layout 非串不当陌生布局误拦）', () => {
  const r = checkArchiveExtractCompat(goodHeader({ layout: 99 }));
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.layout, null);
});

// ── helper 单元 ───────────────────────────────────────────────────────────────

test('_isNonEmptyStr / _inList 基础语义', () => {
  assert.strictEqual(_isNonEmptyStr('x'), true);
  assert.strictEqual(_isNonEmptyStr(''), false);
  assert.strictEqual(_isNonEmptyStr(1), false);
  assert.strictEqual(_inList(['tar.gz'], 'tar.gz'), true);
  assert.strictEqual(_inList(['tar.gz'], 'TAR.GZ'), false); // 大小写敏感：精确契约值
  assert.strictEqual(_inList(null, 'x'), false);
});
