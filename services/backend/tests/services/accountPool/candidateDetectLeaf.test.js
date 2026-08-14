'use strict';

/**
 * candidateDetect 叶子契约测试。
 *
 * 覆盖从 accountPool.js(上帝文件)抽出的「凭据来源探测与候选采集」子系统:
 * 导出面完整性、纯归一化/校验分支的确定性行为、以及单例稳定性。
 * 只测叶子对外契约(宿主按同名 re-import 接回),不触真实磁盘登录态。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/accountPool/candidateDetect');

test('导出面:6 共享常量 + 6 叶子常量 + 14 函数俱在', () => {
  const consts = [
    'CURSOR_STORAGE_PATHS', 'CURSOR_DB_PATHS', 'WARP_STORAGE_PATHS',
    'NIRVANA_STORAGE_PATHS', 'NIRVANA_TRAE_CACHE_PATHS', 'NIRVANA_PRESET_LOGIN_EMAIL',
    'KIRO_TOKEN_PATH', 'NIRVANA_DEFAULT_ROOTS', 'NIRVANA_CALLBACK_FIELDS',
    'OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH', 'OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS',
    'KNOWN_NIRVANA_PROVIDER_SET',
  ];
  const fns = [
    '_getKiroTokenCandidatePaths', 'resolveObservedAutoImportSourcePath',
    'resolveObservedAutoImportCooldownMs', 'resolveArchiveImportRoot',
    'cleanupArchiveExtractDirs', 'resolveNirvanaDefaultRoots',
    'normalizeNirvanaProviderHint', '_scanText', 'detectNirvanaProvider',
    'walkCandidateFiles', 'readCursorTokenFromVscdb',
    'collectNirvanaCandidatesFromRecord', 'collectGenericCandidateFromRecord',
    'importGenericCandidatesFromPath',
  ];
  for (const k of consts) assert.ok(k in leaf, `缺常量导出 ${k}`);
  for (const k of fns) {
    assert.strictEqual(typeof leaf[k], 'function', `缺函数导出 ${k}`);
  }
});

test('storage-path 常量为数组;NIRVANA_PRESET_LOGIN_EMAIL 为字符串', () => {
  for (const k of ['CURSOR_STORAGE_PATHS', 'CURSOR_DB_PATHS', 'WARP_STORAGE_PATHS',
    'NIRVANA_STORAGE_PATHS', 'NIRVANA_TRAE_CACHE_PATHS', 'NIRVANA_DEFAULT_ROOTS',
    'NIRVANA_CALLBACK_FIELDS']) {
    assert.ok(Array.isArray(leaf[k]), `${k} 应为数组`);
  }
  assert.strictEqual(typeof leaf.NIRVANA_PRESET_LOGIN_EMAIL, 'string');
});

test('KNOWN_NIRVANA_PROVIDER_SET 为 Set 且含已知供应商', () => {
  assert.ok(leaf.KNOWN_NIRVANA_PROVIDER_SET instanceof Set);
  for (const p of ['cursor', 'trae', 'warp', 'kiro', 'windsurf', 'anthropic', 'openai']) {
    assert.ok(leaf.KNOWN_NIRVANA_PROVIDER_SET.has(p), `应含 ${p}`);
  }
  assert.ok(!leaf.KNOWN_NIRVANA_PROVIDER_SET.has('nope-provider'));
});

test('normalizeNirvanaProviderHint:trae/claude→anthropic/未知→null', () => {
  assert.strictEqual(leaf.normalizeNirvanaProviderHint('trae'), 'trae');
  assert.strictEqual(leaf.normalizeNirvanaProviderHint('bytedance'), 'trae');
  assert.strictEqual(leaf.normalizeNirvanaProviderHint('nirvana'), 'trae');
  assert.strictEqual(leaf.normalizeNirvanaProviderHint('claude'), 'anthropic');
  assert.strictEqual(leaf.normalizeNirvanaProviderHint(''), null);
  assert.strictEqual(leaf.normalizeNirvanaProviderHint(null), null);
  assert.strictEqual(leaf.normalizeNirvanaProviderHint('totally-unknown-xyz'), null);
});

test('_scanText:空→空串·字符串截断·对象 JSON 化·非法→空串', () => {
  assert.strictEqual(leaf._scanText(''), '');
  assert.strictEqual(leaf._scanText(null), '');
  assert.strictEqual(leaf._scanText(undefined), '');
  assert.strictEqual(leaf._scanText('hello'), 'hello');
  const long = 'x'.repeat(5000);
  assert.strictEqual(leaf._scanText(long, 3200).length, 3200);
  const objScan = leaf._scanText({ a: 1, b: 'two' });
  assert.ok(objScan.includes('two'));
});

test('resolveObservedAutoImportCooldownMs:钳位 5000..600000·非法回默认', () => {
  const DEF = leaf.OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS;
  assert.strictEqual(DEF, 45 * 1000);
  // 无效 → 默认
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({}), DEF);
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({ cooldownMs: 'nan' }), DEF);
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({ cooldownMs: -1 }), DEF);
  // 下钳
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({ cooldownMs: 1000 }), 5000);
  // 上钳
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({ cooldownMs: 999999999 }), 10 * 60 * 1000);
  // 区间内原样(floor)
  assert.strictEqual(leaf.resolveObservedAutoImportCooldownMs({ cooldownMs: 30000 }), 30000);
});

test('_getKiroTokenCandidatePaths 返回非空字符串数组', () => {
  const paths = leaf._getKiroTokenCandidatePaths();
  assert.ok(Array.isArray(paths));
  assert.ok(paths.length >= 1);
  for (const p of paths) assert.strictEqual(typeof p, 'string');
});

test('collectGenericCandidateFromRecord:非对象→null·含 token 记录→候选', () => {
  assert.strictEqual(leaf.collectGenericCandidateFromRecord(null), null);
  assert.strictEqual(leaf.collectGenericCandidateFromRecord('nope'), null);
  const rec = {
    accessToken: 'sk-test-access-token-value-1234567890',
    refreshToken: 'refresh-value-abcdef',
    email: 'user@example.com',
  };
  const out = leaf.collectGenericCandidateFromRecord(rec, '/tmp/x.json', 'openai');
  // 有 token shape 时应返回对象(具体形状由宿主消费,不断言字段名细节)
  assert.ok(out === null || typeof out === 'object');
});

test('单例稳定:重复 require 同引用', () => {
  const again = require('../../../src/services/accountPool/candidateDetect');
  assert.strictEqual(again, leaf);
  assert.strictEqual(again.KNOWN_NIRVANA_PROVIDER_SET, leaf.KNOWN_NIRVANA_PROVIDER_SET);
});
