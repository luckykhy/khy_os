'use strict';

/**
 * installIntegrity.test.js — 已装副本完整性纯叶子的 node:test 覆盖。
 * 跑法：node --test scripts/tests/installIntegrity.test.js（勿用 jest 前缀）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  assessInstallIntegrity,
  CRITICAL_BUNDLE_PATHS,
  _PATH_HINTS,
  _normalizeProbes,
  _GENERIC_FIX,
} = require('../lib/installIntegrity');

const ALL_PRESENT = Object.fromEntries(CRITICAL_BUNDLE_PATHS.map((p) => [p, true]));

function missPaths(r) {
  return r.missing.map((m) => m.path);
}

test('全部就位 → intact=true，无缺失', () => {
  const r = assessInstallIntegrity(ALL_PRESENT);
  assert.strictEqual(r.intact, true);
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.present.length, CRITICAL_BUNDLE_PATHS.length);
  assert.match(r.summary, /完整/);
});

test('缺 auth.js → intact=false，缺失清单含它', () => {
  const probes = { ...ALL_PRESENT };
  delete probes['services/ai-backend/src/middleware/auth.js'];
  const r = assessInstallIntegrity(probes);
  assert.strictEqual(r.intact, false);
  assert.ok(missPaths(r).includes('services/ai-backend/src/middleware/auth.js'));
  // 该项修法非空且是通用重装建议
  const item = r.missing.find((m) => m.path.endsWith('auth.js'));
  assert.ok(item.reason.length > 0);
  assert.strictEqual(item.fix, _GENERIC_FIX);
});

test('bundle 未定位 → intact=false，summary 明说定位失败', () => {
  const r = assessInstallIntegrity(ALL_PRESENT, { bundleResolved: false });
  assert.strictEqual(r.intact, false);
  assert.match(r.summary, /无法定位/);
});

test('bundle 已定位但全缺 → 8/8 缺失', () => {
  const r = assessInstallIntegrity({}, { bundleResolved: true });
  assert.strictEqual(r.intact, false);
  assert.strictEqual(r.missing.length, CRITICAL_BUNDLE_PATHS.length);
});

test('checked === 关键路径总数', () => {
  assert.strictEqual(assessInstallIntegrity(ALL_PRESENT).checked, CRITICAL_BUNDLE_PATHS.length);
});

test('多缺失：数量与 summary 计数一致', () => {
  const probes = { ...ALL_PRESENT };
  delete probes['services/backend/bin/khy.js'];
  delete probes['apps/ai-frontend/src/main.js'];
  const r = assessInstallIntegrity(probes);
  assert.strictEqual(r.missing.length, 2);
  assert.match(r.summary, new RegExp(`缺失 ${r.missing.length}/`));
});

test('确定性 + 幂等：同输入多次调用结果一致', () => {
  const probes = { ...ALL_PRESENT };
  delete probes['kernel/Makefile'];
  assert.deepStrictEqual(assessInstallIntegrity(probes), assessInstallIntegrity(probes));
});

test('畸形输入绝不抛，恒返回结构完整对象', () => {
  for (const bad of [null, undefined, 42, 'x', [], NaN, { foo: 'bar' }]) {
    const r = assessInstallIntegrity(bad);
    assert.ok(r && typeof r === 'object');
    assert.ok(Array.isArray(r.missing) && Array.isArray(r.present));
    assert.strictEqual(typeof r.summary, 'string');
    assert.strictEqual(typeof r.intact, 'boolean');
  }
});

test('只有明确 true 才算存在：真值字符串不算数', () => {
  const probes = {};
  for (const p of CRITICAL_BUNDLE_PATHS) probes[p] = 'yes'; // 非布尔 true
  const r = assessInstallIntegrity(probes);
  assert.strictEqual(r.intact, false);
  assert.strictEqual(r.missing.length, CRITICAL_BUNDLE_PATHS.length);
});

test('opts 缺省视为 bundleResolved=true', () => {
  const r = assessInstallIntegrity(ALL_PRESENT); // 不传 opts
  assert.strictEqual(r.intact, true);
});

test('CRITICAL_BUNDLE_PATHS 非空、无重复、皆为相对路径', () => {
  assert.ok(CRITICAL_BUNDLE_PATHS.length >= 6);
  assert.strictEqual(new Set(CRITICAL_BUNDLE_PATHS).size, CRITICAL_BUNDLE_PATHS.length);
  for (const p of CRITICAL_BUNDLE_PATHS) {
    assert.ok(!p.startsWith('/'), `${p} 不应是绝对路径`);
    assert.ok(!p.includes('..'), `${p} 不应含 ..`);
  }
});

test('每条关键路径都有对应 _PATH_HINTS 文案', () => {
  for (const p of CRITICAL_BUNDLE_PATHS) {
    assert.ok(typeof _PATH_HINTS[p] === 'string' && _PATH_HINTS[p].length > 0, `${p} 缺 hint`);
  }
});

test('通用修法安全：不含 commit/push/rm/curl/publish', () => {
  const s = _GENERIC_FIX.toLowerCase();
  for (const t of ['git commit', 'git push', 'rm ', 'curl ', 'wget ', 'npm publish', 'twine']) {
    assert.ok(!s.includes(t), `修法含危险动作 ${t}`);
  }
});

test('_normalizeProbes 只保留关键路径键，值收敛为布尔', () => {
  const n = _normalizeProbes({ 'services/backend/bin/khy.js': true, 'junk/x': true });
  assert.strictEqual(n['services/backend/bin/khy.js'], true);
  assert.ok(!('junk/x' in n), '未知键应被忽略');
  assert.strictEqual(Object.keys(n).length, CRITICAL_BUNDLE_PATHS.length);
});

// ── 反漂移护栏：CRITICAL_BUNDLE_PATHS 每项必须由发布门权威清单背书 ──────────────
// 两条离机渠道各有权威 bundle 清单：pip 的 REQUIRED_WHEEL_PATHS（khy_os/bundled/ 前缀）
// 与 npm 的 REQUIRED_PATHS（package/bundled/ 前缀）。任一背书即视为不漂移——
// 否则这条关键路径根本不会进包，自检也就无从谈起。
test('反漂移：每条 CRITICAL_BUNDLE_PATHS 都被 pip 或 npm 权威清单背书', () => {
  const pipFile = path.resolve(__dirname, '..', 'release', 'pip_packaging_rules.py');
  const pipSrc = fs.readFileSync(pipFile, 'utf8');
  const pipBlock = /REQUIRED_WHEEL_PATHS\s*=\s*_ordered_unique\(\[([\s\S]*?)\]\)/.exec(pipSrc);
  assert.ok(pipBlock, '未能在 pip 权威文件中定位 REQUIRED_WHEEL_PATHS 块');
  const pipList = pipBlock[1];

  const npmFile = path.resolve(__dirname, '..', '..', 'packaging', 'npm', 'scripts', 'audit-purity.js');
  const npmSrc = fs.readFileSync(npmFile, 'utf8');
  const npmBlock = /REQUIRED_PATHS\s*=\s*\[([\s\S]*?)\]/.exec(npmSrc);
  assert.ok(npmBlock, '未能在 npm 权威文件中定位 REQUIRED_PATHS 块');
  const npmList = npmBlock[1];

  for (const p of CRITICAL_BUNDLE_PATHS) {
    const inPip = pipList.includes(`khy_os/bundled/${p}`);
    const inNpm = npmList.includes(`package/bundled/${p}`);
    assert.ok(
      inPip || inNpm,
      `漂移：CRITICAL_BUNDLE_PATHS 的 "${p}" 既不在 pip REQUIRED_WHEEL_PATHS ` +
        `（应含 "khy_os/bundled/${p}"）也不在 npm REQUIRED_PATHS（应含 "package/bundled/${p}"）。` +
        `先把它加进 scripts/release/pip_packaging_rules.py 或 packaging/npm/scripts/audit-purity.js 的权威清单。`
    );
  }
});

test('doc 一致性：OPS-MAN-069 落盘 == 生成器输出(防手改漂移)', () => {
  const { buildDoc, DOC_PATH } = require('../install/verify-install');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  assert.strictEqual(
    onDisk,
    buildDoc(),
    '落盘的 OPS-MAN-069 与生成器不一致，请跑 node scripts/verify-install.js --gen-doc 重生成'
  );
  const g = buildDoc();
  assert.ok(g.includes('@khy-os/khy-os'));
  assert.ok(g.includes('pip install'));
  assert.ok(g.includes('commit/push')); // 红线声明在
  // 表格关键路径行数 === 关键路径数
  const rows = g.split('\n').filter((l) => /^\| `[^`]+` \|/.test(l));
  assert.strictEqual(rows.length, CRITICAL_BUNDLE_PATHS.length);
});
