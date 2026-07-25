/**
 * Unit tests for the shared, pure device-identity core. Zero deps — run with the
 * built-in Node test runner:
 *   node --test tests/bridge/deviceIdentity.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDevice,
  detectPlatform,
  formatDeviceName,
  autoDeviceName,
  pickRealName,
  isValidDeviceName,
} = require('@khy/shared/deviceIdentity');

// ── classifyDevice ──────────────────────────────────────────────────────────

test('classifyDevice: iPhone → phone', () => {
  const r = classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148');
  assert.deepEqual(r, { type: 'phone', label: '手机', platform: 'ios' });
});

test('classifyDevice: iPad → tablet', () => {
  const r = classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Safari');
  assert.equal(r.type, 'tablet');
  assert.equal(r.label, '平板');
});

test('classifyDevice: Android phone (has Mobile) → phone', () => {
  const r = classifyDevice('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit Mobile Safari');
  assert.equal(r.type, 'phone');
  assert.equal(r.platform, 'android');
});

test('classifyDevice: Android tablet (no Mobile) → tablet', () => {
  const r = classifyDevice('Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit Safari');
  assert.equal(r.type, 'tablet');
});

test('classifyDevice: Android explicit Tablet token → tablet', () => {
  const r = classifyDevice('Mozilla/5.0 (Linux; Android 11; Tablet; Lenovo TB) Mobile Safari');
  assert.equal(r.type, 'tablet');
});

test('classifyDevice: Windows → desktop', () => {
  assert.equal(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)').type, 'desktop');
});

test('classifyDevice: Mac (no touch) → desktop', () => {
  const r = classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
  assert.equal(r.type, 'desktop');
  assert.equal(r.platform, 'macos');
});

test('classifyDevice: iPadOS 13+ pretends to be Mac → tablet only with touch hint', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari';
  assert.equal(classifyDevice(ua).type, 'desktop');
  assert.equal(classifyDevice(ua, { touch: true }).type, 'tablet');
});

test('classifyDevice: Linux → desktop; unknown UA → desktop/unknown', () => {
  assert.equal(classifyDevice('Mozilla/5.0 (X11; Linux x86_64)').type, 'desktop');
  const r = classifyDevice('');
  assert.equal(r.type, 'desktop');
  assert.equal(r.platform, 'unknown');
});

test('classifyDevice: UA-CH mobile hint promotes ambiguous UA to phone', () => {
  assert.equal(classifyDevice('SomeWebView/1.0', { mobile: true }).type, 'phone');
});

test('detectPlatform: UA Client Hints platform wins over UA string', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0)', { platform: 'Android' }), 'android');
});

// ── formatDeviceName ──────────────────────────────────────────────────────────

test('formatDeviceName: basic _xx label', () => {
  assert.equal(formatDeviceName('小明', '手机'), '_小明手机');
});

test('formatDeviceName: strips a leading underscore the user typed', () => {
  assert.equal(formatDeviceName('_小明', '手机'), '_小明手机');
});

test('formatDeviceName: strips a duplicate label suffix', () => {
  assert.equal(formatDeviceName('小明手机', '手机'), '_小明手机');
  assert.equal(formatDeviceName('_小明手机', '手机'), '_小明手机');
});

test('formatDeviceName: removes illegal characters but keeps letters/digits/dash/dot', () => {
  assert.equal(formatDeviceName('a/b\\c<d>e', '电脑'), '_abcde电脑');
  assert.equal(formatDeviceName('Pixel-7.pro', '手机'), '_Pixel-7.pro手机');
});

test('formatDeviceName: clamps overly long names', () => {
  const out = formatDeviceName('x'.repeat(100), '电脑');
  assert.ok(out.length <= 40);
  assert.ok(out.startsWith('_'));
  assert.ok(out.endsWith('电脑'));
});

test('formatDeviceName: empty xx yields _label', () => {
  assert.equal(formatDeviceName('', '平板'), '_平板');
});

// ── autoDeviceName ────────────────────────────────────────────────────────────

test('autoDeviceName: per-platform generic fallback', () => {
  assert.equal(autoDeviceName({ platform: 'windows', label: '电脑' }), '_Windows电脑');
  assert.equal(autoDeviceName({ platform: 'ios', label: '手机' }), '_iPhone手机');
  assert.equal(autoDeviceName({ platform: 'android', label: '平板' }), '_Android平板');
  assert.equal(autoDeviceName({ platform: 'unknown', label: '电脑' }), '_本机电脑');
  assert.equal(autoDeviceName({}), '_本机电脑'); // defaults
});

// ── pickRealName ──────────────────────────────────────────────────────────────

test('pickRealName: hints beat ptr beat ua (priority by array order)', () => {
  const r = pickRealName([
    { source: 'hints', value: 'Pixel 7' },
    { source: 'ptr', value: 'router.local' },
    { source: 'ua', value: 'SM-G991B' },
  ]);
  assert.deepEqual(r, { name: 'Pixel 7', source: 'hints' });
});

test('pickRealName: humanizes hostname sources (strips .local + domain)', () => {
  assert.deepEqual(
    pickRealName([{ source: 'ptr', value: 'XiaoMing-MacBook.local.' }]),
    { name: 'XiaoMing-MacBook', source: 'ptr' },
  );
  assert.deepEqual(
    pickRealName([{ source: 'netbios', value: 'HOMEPC$' }]),
    { name: 'HOMEPC', source: 'netbios' },
  );
});

test('pickRealName: skips uninformative/IP-like values, takes next meaningful', () => {
  const r = pickRealName([
    { source: 'ptr', value: '192.168.1.5' },   // IP-like → skip
    { source: 'mdns', value: 'localhost' },     // uninformative → skip
    { source: 'ua', value: 'OnePlus 9' },
  ]);
  assert.deepEqual(r, { name: 'OnePlus 9', source: 'ua' });
});

test('pickRealName: all empty/invalid → null', () => {
  assert.equal(pickRealName([]), null);
  assert.equal(pickRealName(null), null);
  assert.equal(pickRealName([{ source: 'ptr', value: 'unknown' }, { source: 'ua', value: '' }]), null);
});

// ── isValidDeviceName ─────────────────────────────────────────────────────────

test('isValidDeviceName: accepts normal, rejects empty/too-long/control chars', () => {
  assert.equal(isValidDeviceName('_小明手机'), true);
  assert.equal(isValidDeviceName(''), false);
  assert.equal(isValidDeviceName('x'.repeat(41)), false);
  assert.equal(isValidDeviceName('a\nb'), false);
  assert.equal(isValidDeviceName('ab'), true); // loose check: no leading-underscore requirement
});
