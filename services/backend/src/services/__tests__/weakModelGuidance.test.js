'use strict';

/**
 * weakModelGuidance.test.js — 弱模型就地护栏引擎纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表委托)、bannerFor(各位点非空、未知 key
 * 返空串、与 GUARD_SITES 同源)、buildWeakModelDirective(稳定、含关键不变量)、toolCallHint(非空单句)、
 * listGuardSites(全 7 位点)、GUARD_SITES 冻结(纯叶子不可变)。
 * 零 IO、确定性——每个断言显式传 env,不依赖进程环境。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const wmg = require('../weakModelGuidance');

const EXPECTED_SITES = [
  'tool-funnel',
  'pretooluse-hardfloor',
  'exec-approved-stamp',
  'flag-registry',
  'leaf-authoring',
  'wiring',
  'tool-description',
];

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(wmg.isEnabled({}), true);
  assert.equal(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: '1' }), true);
  assert.equal(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  // 注册表自门控 KHY_FLAG_REGISTRY=0 → 走本文件私有 _off。默认仍开,仅 falsy 关。
  assert.equal(wmg.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(wmg.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_WEAK_MODEL_GUIDANCE: 'off' }), false);
});

test('GUARD_SITES:恰好 7 个位点,键集稳定', () => {
  const keys = Object.keys(wmg.GUARD_SITES);
  assert.equal(keys.length, EXPECTED_SITES.length);
  for (const k of EXPECTED_SITES) {
    assert.ok(wmg.GUARD_SITES[k], `missing site ${k}`);
  }
});

test('GUARD_SITES:每个位点有 title/where/danger/directive/exemplar 且非空', () => {
  for (const [key, site] of Object.entries(wmg.GUARD_SITES)) {
    for (const field of ['title', 'where', 'danger', 'directive', 'exemplar']) {
      assert.equal(typeof site[field], 'string', `${key}.${field} type`);
      assert.ok(site[field].length > 0, `${key}.${field} empty`);
    }
  }
});

test('GUARD_SITES:冻结(纯叶子不可变),元素也冻结', () => {
  assert.ok(Object.isFrozen(wmg.GUARD_SITES));
  for (const site of Object.values(wmg.GUARD_SITES)) {
    assert.ok(Object.isFrozen(site));
  }
});

test('bannerFor:各位点返回非空横幅,前缀统一 [AI-弱模型],内容与 site 同源', () => {
  for (const key of EXPECTED_SITES) {
    const banner = wmg.bannerFor(key);
    assert.ok(banner.startsWith('[AI-弱模型] '), key);
    const site = wmg.GUARD_SITES[key];
    assert.ok(banner.includes(site.title), `${key} title`);
    assert.ok(banner.includes(site.directive), `${key} directive`);
    assert.ok(banner.includes(site.exemplar), `${key} exemplar`);
  }
});

test('bannerFor:未知/坏输入返回空串,绝不抛(纯叶子安全默认)', () => {
  assert.equal(wmg.bannerFor('nope'), '');
  assert.equal(wmg.bannerFor(''), '');
  assert.equal(wmg.bannerFor(undefined), '');
  assert.equal(wmg.bannerFor(null), '');
  assert.equal(wmg.bannerFor(123), '');
});

test('buildWeakModelDirective:非空、稳定(两次调用逐字节相同)、含关键不变量', () => {
  const a = wmg.buildWeakModelDirective();
  const b = wmg.buildWeakModelDirective();
  assert.equal(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.includes('executeTool'));
  assert.ok(a.includes('PreToolUse'));
  assert.ok(a.includes('pure leaf'));
  assert.ok(a.includes('goalStopGate'));
  assert.ok(a.includes('flagRegistry'));
});

test('toolCallHint:非空单句,含关键要点', () => {
  const hint = wmg.toolCallHint();
  assert.ok(hint.length > 0);
  assert.ok(!hint.includes('\n'), '应为单句(无换行)');
  assert.ok(hint.includes('schema'));
});

test('listGuardSites:返回全部 7 位点,每项带 key 且携带原字段', () => {
  const list = wmg.listGuardSites();
  assert.equal(list.length, EXPECTED_SITES.length);
  const keys = list.map(s => s.key);
  for (const k of EXPECTED_SITES) assert.ok(keys.includes(k), k);
  for (const item of list) {
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.directive, 'string');
  }
});

// ── 反例→正例成对示范(WEAK_MODEL_EXEMPLARS / buildWeakModelExemplars)────────────────────
test('WEAK_MODEL_EXEMPLARS:非空、冻结(纯叶子不可变),每条 id/topic/bad/good/why 非空', () => {
  assert.ok(Array.isArray(wmg.WEAK_MODEL_EXEMPLARS));
  assert.ok(wmg.WEAK_MODEL_EXEMPLARS.length >= 5);
  assert.ok(Object.isFrozen(wmg.WEAK_MODEL_EXEMPLARS));
  const ids = new Set();
  for (const ex of wmg.WEAK_MODEL_EXEMPLARS) {
    assert.ok(Object.isFrozen(ex), 'exemplar frozen');
    for (const field of ['id', 'topic', 'bad', 'good', 'why']) {
      assert.equal(typeof ex[field], 'string', `${ex.id}.${field} type`);
      assert.ok(ex[field].length > 0, `${ex.id}.${field} empty`);
    }
    assert.ok(!ids.has(ex.id), `duplicate id ${ex.id}`);
    ids.add(ex.id);
  }
});

test('WEAK_MODEL_EXEMPLARS:覆盖关键死循环反例(超时重试/无输出重跑/手写全盘扫描)', () => {
  const ids = wmg.WEAK_MODEL_EXEMPLARS.map(e => e.id);
  for (const k of ['retry-timeout', 'repeat-after-no-output', 'handwrite-disk-scan']) {
    assert.ok(ids.includes(k), `missing exemplar ${k}`);
  }
});

test('buildWeakModelExemplars:门开非空、确定性、含 BAD/GOOD/WHY 与关键反例文案', () => {
  const a = wmg.buildWeakModelExemplars({});
  const b = wmg.buildWeakModelExemplars({});
  assert.equal(a, b);                                  // 确定性
  assert.ok(a.length > 0);
  assert.ok(a.includes('BAD:'));
  assert.ok(a.includes('GOOD:'));
  assert.ok(a.includes('WHY:'));
  assert.ok(a.includes('Common weak-model mistakes'));
  assert.ok(a.includes('DiskAnalyze'));                // 手写全盘扫描反例的正解
  assert.ok(a.includes('clamped to 60000'));           // 超时重试反例
});

test('buildWeakModelExemplars:门关(含大小写/空白 falsy)→ 空串(逐字节回退)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(wmg.buildWeakModelExemplars({ KHY_WEAK_MODEL_GUIDANCE: v }), '', v);
  }
});

test('buildWeakModelExemplars:坏输入不抛,返回字符串(纯叶子安全默认)', () => {
  for (const bad of [null, undefined, 42, 'str']) {
    assert.doesNotThrow(() => wmg.buildWeakModelExemplars(bad));
    assert.equal(typeof wmg.buildWeakModelExemplars(bad), 'string');
  }
});

// ── 「看似 bug 实为刻意设计」清单(INTENTIONAL_DESIGNS / buildIntentionalDesigns)──────────
test('INTENTIONAL_DESIGNS:非空、冻结(纯叶子不可变),每条 id/looksLikeBug/actualDesign/where/why 非空', () => {
  assert.ok(Array.isArray(wmg.INTENTIONAL_DESIGNS));
  assert.ok(wmg.INTENTIONAL_DESIGNS.length >= 5);
  assert.ok(Object.isFrozen(wmg.INTENTIONAL_DESIGNS));
  const ids = new Set();
  for (const d of wmg.INTENTIONAL_DESIGNS) {
    assert.ok(Object.isFrozen(d), 'design frozen');
    for (const field of ['id', 'looksLikeBug', 'actualDesign', 'where', 'why']) {
      assert.equal(typeof d[field], 'string', `${d.id}.${field} type`);
      assert.ok(d[field].length > 0, `${d.id}.${field} empty`);
    }
    assert.ok(!ids.has(d.id), `duplicate id ${d.id}`);
    ids.add(d.id);
  }
});

test('INTENTIONAL_DESIGNS:覆盖被反复误判的关键刻意设计(默认口令/动态版本/sha256 留空)', () => {
  const ids = wmg.INTENTIONAL_DESIGNS.map(d => d.id);
  for (const k of ['default-source-secret', 'dynamic-version', 'snapshot-sha256-blank']) {
    assert.ok(ids.includes(k), `missing intentional design ${k}`);
  }
});

test('buildIntentionalDesigns:门开非空、确定性、含 LOOKS-LIKE-BUG/BY-DESIGN/WHY 与关键条目文案', () => {
  const a = wmg.buildIntentionalDesigns({});
  const b = wmg.buildIntentionalDesigns({});
  assert.equal(a, b);                                  // 确定性
  assert.ok(a.length > 0);
  assert.ok(a.includes('LOOKS-LIKE-BUG:'));
  assert.ok(a.includes('BY-DESIGN:'));
  assert.ok(a.includes('WHY:'));
  assert.ok(a.includes('INTENTIONAL'));
  assert.ok(a.includes('check-version-sync'));         // dynamic-version 条目
});

test('buildIntentionalDesigns:门关(含大小写/空白 falsy)→ 空串(逐字节回退)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(wmg.buildIntentionalDesigns({ KHY_WEAK_MODEL_GUIDANCE: v }), '', v);
  }
});

test('buildIntentionalDesigns:坏输入不抛,返回字符串(纯叶子安全默认)', () => {
  for (const bad of [null, undefined, 42, 'str']) {
    assert.doesNotThrow(() => wmg.buildIntentionalDesigns(bad));
    assert.equal(typeof wmg.buildIntentionalDesigns(bad), 'string');
  }
});

test('listIntentionalDesigns:返回全部条目,每项带 id 且携带原字段', () => {
  const list = wmg.listIntentionalDesigns();
  assert.equal(list.length, wmg.INTENTIONAL_DESIGNS.length);
  for (const item of list) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.actualDesign, 'string');
  }
});
