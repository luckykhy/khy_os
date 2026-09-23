'use strict';
/**
 * verifyAndroidSignature 纯叶子契约测试:判定语义(GO/NO-GO/SKIP)、指纹归一化、
 * 各 fail-soft 分支。只测纯函数,不跑 apksigner/keytool,因此确定性、快速、无副作用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { verifyAndroidSignature, REASONS } = require('../release/lib/verifyAndroidSignature');

test('缺 apksigner 输出 => skip(工具链缺失,fail-soft,不阻断双渠道)', () => {
  const r = verifyAndroidSignature({});
  assert.strictEqual(r.status, 'skip');
  assert.ok(r.reasons.includes(REASONS.MISSING_APKSIGNER));
  assert.match(r.message, /SKIP/);
});

test('签名无效(无 signer 证书指纹且无 Verifies) => fail', () => {
  const r = verifyAndroidSignature({ apksignerOutput: 'nothing useful here' });
  assert.strictEqual(r.status, 'fail');
  assert.ok(r.reasons.includes(REASONS.INVALID_SIG));
  assert.match(r.message, /NO-GO/);
});

test('签名有效但期望 release 且无 keystore 指纹 => skip(降级,留痕非上架可用)', () => {
  const r = verifyAndroidSignature({
    apksignerOutput: 'Signer #1 certificate SHA-256 digest: aaa\n',
    apkSha256: 'aaa',
    expectRelease: true,
  });
  assert.strictEqual(r.status, 'skip');
  assert.match(r.message, /SKIP/);
});

test('指纹一致 => pass(GO,可上架)', () => {
  const r = verifyAndroidSignature({
    apksignerOutput: 'x',
    apkSha256: 'CB:16:F1:4C:57:A3:62',
    keystoreSha256: 'cb16f14c57a362',
    expectRelease: true,
  });
  assert.strictEqual(r.status, 'pass');
  assert.ok(r.reasons.includes(REASONS.OK));
  assert.match(r.message, /GO/);
});

test('指纹不一致 => fail(NO-GO,禁上传 Play)', () => {
  const r = verifyAndroidSignature({
    apksignerOutput: 'x',
    apkSha256: 'cb16f14c57a362',
    keystoreSha256: 'deadbeef0000',
    expectRelease: true,
  });
  assert.strictEqual(r.status, 'fail');
  assert.ok(r.reasons.includes(REASONS.MISMATCH));
  assert.match(r.message, /NO-GO/);
});

test('指纹归一化:冒号/空格/大小写差异不影响比对', () => {
  const r = verifyAndroidSignature({
    apksignerOutput: 'x',
    // apksigner 风格:小写无冒号
    apkSha256: 'cb16f14c57a362',
    // keytool 风格:大写带冒号+空格
    keystoreSha256: 'CB:16:F1:4C:57:A3:62',
    expectRelease: true,
  });
  assert.strictEqual(r.status, 'pass', '两种指纹格式归一后应判为一致');
});

test('不期望 release(仅 DEBUG 凭据)且签名有效 => pass(降级,留痕非上架可用)', () => {
  const r = verifyAndroidSignature({
    apksignerOutput: 'Signer #1 certificate SHA-256 digest: aaa\n',
    apkSha256: 'aaa',
    expectRelease: false,
  });
  assert.strictEqual(r.status, 'pass');
  assert.ok(r.reasons.includes(REASONS.NO_RELEASE_EXPECTED));
  assert.match(r.message, /降级/);
});
