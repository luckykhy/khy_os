'use strict';

/**
 * Unit tests for restoreArchiveExtractCheck.js — bundled 运行时纯叶，把关「解密后、解包前」
 * 的内层归档形制（plaintextFormat / layout），让运行时 restore 在盲目 `tar -xzf` 之前
 * 确认本机认不认识这团解密归档（run via `node --test`）。
 *
 * 覆盖:
 *   - supported: 认识的 plaintextFormat + 认识的 layout → ok/none。
 *   - 向后兼容: 认识格式 + layout 缺省（老快照）→ supported（不因缺 layout 卡死）。
 *   - block: plaintextFormat 不在支持集（tar.zst / zip）→ unsupported-format + block。
 *   - warn: 认识格式但 layout 存在且陌生 → unknown-layout + warn（仍解包）。
 *   - unverifiable: 头非对象 / 数组 / 缺 plaintextFormat / plaintextFormat 非串 → none，绝不谎报 supported。
 *   - 绝不抛: 各种畸形入参 → 保守裁决，不抛。
 *   - severity 派生: ok/block/warn 互斥且只由 status 决定。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const M = require('../../src/services/restoreArchiveExtractCheck');
const {
  assessArchiveExtractCompat,
  SUPPORTED_PLAINTEXT_FORMATS,
  SUPPORTED_LAYOUTS,
  STATUS_SUPPORTED,
  STATUS_UNSUPPORTED_FORMAT,
  STATUS_UNKNOWN_LAYOUT,
  STATUS_UNVERIFIABLE,
} = M;

function goodHeader(over) {
  return { plaintextFormat: SUPPORTED_PLAINTEXT_FORMATS[0], layout: SUPPORTED_LAYOUTS[0], ...over };
}

// ── supported ────────────────────────────────────────────────────────────────
test('认识的 plaintextFormat + 认识的 layout → supported + ok:true + none', () => {
  const r = assessArchiveExtractCompat(goodHeader());
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.severity, 'none');
  assert.strictEqual(r.plaintextFormat, 'tar.gz');
  assert.strictEqual(r.layout, 'git-archive');
});

test('认识格式 + layout 缺省（老快照向后兼容）→ supported（不因缺 layout 卡死）', () => {
  const h = goodHeader();
  delete h.layout;
  const r = assessArchiveExtractCompat(h);
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.layout, null);
});

test('认识格式 + layout 为空串 → supported（空串视同缺省）', () => {
  const r = assessArchiveExtractCompat(goodHeader({ layout: '' }));
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

// ── block: unsupported-format ─────────────────────────────────────────────────
test('plaintextFormat=tar.zst（未来格式）→ unsupported-format + block', () => {
  const r = assessArchiveExtractCompat(goodHeader({ plaintextFormat: 'tar.zst' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_FORMAT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.severity, 'block');
  assert.match(r.message, /升级 khy/);
  assert.match(r.message, /tar\.zst/);
});

test('plaintextFormat=zip → unsupported-format + block（layout 陌生也让格式 block 优先）', () => {
  const r = assessArchiveExtractCompat({ plaintextFormat: 'zip', layout: 'weird-layout' });
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_FORMAT);
  assert.strictEqual(r.block, true);
});

// ── warn: unknown-layout ──────────────────────────────────────────────────────
test('认识格式 + layout 陌生 → unknown-layout + warn（仍解包）', () => {
  const r = assessArchiveExtractCompat(goodHeader({ layout: 'full-fs-with-git' }));
  assert.strictEqual(r.status, STATUS_UNKNOWN_LAYOUT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.warn, true);
  assert.strictEqual(r.severity, 'warn');
  assert.match(r.message, /目录布局形制陌生|布局形制陌生|layout/);
});

// ── unverifiable ──────────────────────────────────────────────────────────────
test('header=null → unverifiable + none（绝不谎报 supported）', () => {
  const r = assessArchiveExtractCompat(null);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.warn, false);
});

test('header=[]（数组，typeof===object 陷阱）→ unverifiable', () => {
  const r = assessArchiveExtractCompat([]);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
});

test('plaintextFormat 缺失 → unverifiable', () => {
  const h = goodHeader();
  delete h.plaintextFormat;
  const r = assessArchiveExtractCompat(h);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
});

test('plaintextFormat 非字符串（数字 / 空串 / 数组）→ unverifiable', () => {
  for (const bad of [123, '', [], {}, null]) {
    const r = assessArchiveExtractCompat(goodHeader({ plaintextFormat: bad }));
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE, `plaintextFormat=${JSON.stringify(bad)} 应 unverifiable`);
  }
});

// ── 绝不抛 + severity 互斥 ─────────────────────────────────────────────────────
test('各种畸形入参绝不抛，恒返回带 status 的对象', () => {
  const weird = [undefined, 0, '', 'str', 42, [], {}, { plaintextFormat: [] }, { plaintextFormat: 'tar.gz', layout: 99 }];
  for (const w of weird) {
    let r;
    assert.doesNotThrow(() => { r = assessArchiveExtractCompat(w); });
    assert.strictEqual(typeof r.status, 'string');
    assert.strictEqual(typeof r.message, 'string');
  }
});

test('layout 非字符串（数字）→ 视同缺省，仍 supported（不 warn）', () => {
  const r = assessArchiveExtractCompat(goodHeader({ layout: 99 }));
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.layout, null);
});

test('ok/block/warn 三者互斥，且只在对应 status 时为真', () => {
  const supported = assessArchiveExtractCompat(goodHeader());
  const blocked = assessArchiveExtractCompat(goodHeader({ plaintextFormat: 'zip' }));
  const warned = assessArchiveExtractCompat(goodHeader({ layout: 'weird' }));
  const unver = assessArchiveExtractCompat(null);
  for (const v of [supported, blocked, warned, unver]) {
    const flags = [v.ok, v.block, v.warn].filter(Boolean);
    assert.ok(flags.length <= 1, `severity 标志应互斥，实得 ${JSON.stringify(v)}`);
  }
  assert.strictEqual(supported.ok, true);
  assert.strictEqual(blocked.block, true);
  assert.strictEqual(warned.warn, true);
  assert.strictEqual(unver.ok, false);
  assert.strictEqual(unver.block, false);
  assert.strictEqual(unver.warn, false);
});

test('注入 supportedFormats/supportedLayouts 覆盖默认支持集', () => {
  // 模拟未来解包器支持了 tar.zst：注入后应放行。
  const r = assessArchiveExtractCompat(goodHeader({ plaintextFormat: 'tar.zst', layout: 'git-archive' }),
    { supportedFormats: ['tar.gz', 'tar.zst'] });
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

test('裁决输出不携带任何密钥字段（只含归档形制事实）', () => {
  const r = assessArchiveExtractCompat(goodHeader({ crypto: { salt: 'SECRET', iv: 'SECRET', authTag: 'SECRET' } }));
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /SECRET/);
  assert.strictEqual(r.status, STATUS_SUPPORTED);
});
