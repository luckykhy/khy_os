'use strict';

/**
 * restoreReadiness.test.js — 还原自检纯叶子的 node:test 覆盖。
 * 跑法：node --test scripts/tests/restoreReadiness.test.js（勿用 jest 前缀）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  assessRestoreReadiness,
  _RULES,
  _normalizeFacts,
  _fixIsSafe,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
} = require('../lib/restoreReadiness');

// 一台理想机器：全部就位。
const READY = {
  nodeOk: true,
  npmOk: true,
  tarOk: true,
  bundlePresent: true,
  nodeModulesPresent: true,
  registryReachable: true,
  versionsSynced: true,
  channel: 'both',
  writableInstall: true,
};

function idsOf(list) {
  return list.map((x) => x.id);
}

test('理想机器：ready=true，无拦路项无提醒', () => {
  const r = assessRestoreReadiness(READY);
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.blockers.length, 0);
  assert.strictEqual(r.warnings.length, 0);
  assert.match(r.summary, /就绪/);
});

test('node 缺失 → node-missing 拦路项', () => {
  const r = assessRestoreReadiness({ ...READY, nodeOk: false });
  assert.strictEqual(r.ready, false);
  assert.ok(idsOf(r.blockers).includes('node-missing'));
});

test('npm 缺失 → npm-missing 拦路项', () => {
  const r = assessRestoreReadiness({ ...READY, npmOk: false });
  assert.ok(idsOf(r.blockers).includes('npm-missing'));
});

test('bundled 缺失 → bundle-missing 拦路项', () => {
  const r = assessRestoreReadiness({ ...READY, bundlePresent: false });
  assert.ok(idsOf(r.blockers).includes('bundle-missing'));
});

test('离线且依赖未 hydrate → offline-no-modules 拦路项(而非仅提醒)', () => {
  const r = assessRestoreReadiness({
    ...READY,
    nodeModulesPresent: false,
    registryReachable: false,
  });
  assert.ok(idsOf(r.blockers).includes('offline-no-modules'));
  // 离线时不应再重复出现「首启会联网」的乐观提醒
  assert.ok(!idsOf(r.warnings).includes('modules-not-hydrated'));
});

test('版本漂移 → versions-drift 拦路项', () => {
  const r = assessRestoreReadiness({ ...READY, versionsSynced: false });
  assert.ok(idsOf(r.blockers).includes('versions-drift'));
});

test('tar 缺失 → tar-missing 仅提醒(能装但快照难解)', () => {
  const r = assessRestoreReadiness({ ...READY, tarOk: false });
  assert.strictEqual(r.ready, true); // tar 只是 warning，不拦还原主路径
  assert.ok(idsOf(r.warnings).includes('tar-missing'));
});

test('有网但依赖未 hydrate → modules-not-hydrated 仅提醒', () => {
  const r = assessRestoreReadiness({
    ...READY,
    nodeModulesPresent: false,
    registryReachable: true,
  });
  assert.strictEqual(r.ready, true);
  assert.ok(idsOf(r.warnings).includes('modules-not-hydrated'));
});

test('只读安装目录 → install-readonly 提醒', () => {
  const r = assessRestoreReadiness({ ...READY, writableInstall: false });
  assert.ok(idsOf(r.warnings).includes('install-readonly'));
});

test('仅单渠道 → single-channel 提醒；both 不触发', () => {
  const pipOnly = assessRestoreReadiness({ ...READY, channel: 'pip' });
  assert.ok(idsOf(pipOnly.warnings).includes('single-channel'));
  const both = assessRestoreReadiness({ ...READY, channel: 'both' });
  assert.ok(!idsOf(both.warnings).includes('single-channel'));
});

test('多拦路项：数量与 summary 计数一致', () => {
  const r = assessRestoreReadiness({
    nodeOk: false,
    npmOk: false,
    bundlePresent: false,
    tarOk: false,
    versionsSynced: false,
  });
  assert.strictEqual(r.ready, false);
  assert.ok(r.blockers.length >= 3);
  assert.match(r.summary, new RegExp(`${r.blockers.length} 条拦路项`));
});

test('checked === 规则总数', () => {
  const r = assessRestoreReadiness(READY);
  assert.strictEqual(r.checked, _RULES.length);
});

test('确定性 + 幂等：同输入多次调用结果一致', () => {
  const a = assessRestoreReadiness({ ...READY, nodeOk: false });
  const b = assessRestoreReadiness({ ...READY, nodeOk: false });
  assert.deepStrictEqual(a, b);
});

test('畸形输入绝不抛，恒返回结构完整对象', () => {
  for (const bad of [null, undefined, 42, 'x', [], NaN, { nodeOk: 'yes' }]) {
    const r = assessRestoreReadiness(bad);
    assert.ok(r && typeof r === 'object');
    assert.ok(Array.isArray(r.blockers));
    assert.ok(Array.isArray(r.warnings));
    assert.strictEqual(typeof r.summary, 'string');
    assert.strictEqual(typeof r.ready, 'boolean');
  }
});

test('未知字段(null)不误报：空 facts 不产生拦路项', () => {
  // 未知 ≠ 损坏：只有明确的 false 才算问题。这是刻意的保守取舍。
  const r = assessRestoreReadiness({});
  assert.strictEqual(r.blockers.length, 0);
});

test('谓词内部异常被隔离：when 抛错不冒泡', () => {
  // 通过传入会让字符串型字段进入布尔谓词的畸形值，验证不抛。
  const r = assessRestoreReadiness({ channel: { toString() { throw new Error('x'); } } });
  assert.ok(r && Array.isArray(r.warnings));
});

test('每条规则的 level 合法，fix 安全(不含 commit/push/rm/curl/publish)', () => {
  for (const rule of _RULES) {
    assert.ok(
      rule.level === LEVEL_BLOCKER || rule.level === LEVEL_WARNING,
      `规则 ${rule.id} level 非法`
    );
    assert.ok(typeof rule.title === 'string' && rule.title.length > 0);
    assert.ok(_fixIsSafe(rule.fix), `规则 ${rule.id} 的修法含危险动作`);
    assert.strictEqual(typeof rule.when, 'function');
  }
});

test('规则 id 唯一', () => {
  const ids = _RULES.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('_normalizeFacts 把非法值规整为 null，真布尔保留', () => {
  const f = _normalizeFacts({ nodeOk: 'true', npmOk: true, tarOk: 0 });
  assert.strictEqual(f.nodeOk, null); // 'true' 字符串非真布尔 → null
  assert.strictEqual(f.npmOk, true);
  assert.strictEqual(f.tarOk, null); // 0 非布尔 → null
});

test('还原清单 OPS-MAN-068 已落盘且与生成器输出一致(防手改漂移)', () => {
  const fs = require('node:fs');
  const { buildDoc, DOC_PATH } = require('../restore-check');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  const generated = buildDoc();
  assert.strictEqual(
    onDisk,
    generated,
    '落盘的 OPS-MAN-068 与生成器输出不一致，请跑 node scripts/restore-check.js --gen-doc 重新生成'
  );
  // 内容锚点：真实包名、双渠道、红线均在
  assert.ok(generated.includes('@khy-os/khy-os'));
  assert.ok(generated.includes('pip install khy-os'));
  assert.ok(generated.includes('commit/push'));
  // 表格行数 === 规则数（每条规则一行）
  const rows = generated.split('\n').filter((l) => /^\| `[a-z-]+` \|/.test(l));
  assert.strictEqual(rows.length, _RULES.length);
});
