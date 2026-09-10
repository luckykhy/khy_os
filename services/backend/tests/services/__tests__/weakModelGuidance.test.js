'use strict';
/**
 * weakModelGuidance.test.js �?弱模型就地护栏引擎纯叶子契约(node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表委�?、bannerFor(各位点非空、未�?key
 * 返空串、与 GUARD_SITES 同源)、buildWeakModelDirective(稳定、含关键不变�?、toolCallHint(非空单句)�? * listGuardSites(�?7 位点)、GUARD_SITES 冻结(纯叶子不可变)�? * �?IO、确定性——每个断言显式�?env,不依赖进程环境�? */
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
// ── 反例→正例成对示�?WEAK_MODEL_EXEMPLARS / buildWeakModelExemplars)────────────────────
// ── 「看�?bug 实为刻意设计」清�?INTENTIONAL_DESIGNS / buildIntentionalDesigns)──────────

describe('Weak Model Guidance', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(wmg.isEnabled({})).toBe(true);
      expect(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: '1' })).toBe(true);
      expect(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(wmg.isEnabled({ KHY_WEAK_MODEL_GUIDANCE: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      // 注册表自门控 KHY_FLAG_REGISTRY=0 �?走本文件私有 _off。默认仍开,�?falsy 关�?      expect(wmg.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      expect(wmg.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_WEAK_MODEL_GUIDANCE: 'off' })).toBe(false);
  });

  test('GUARD_SITES:恰好 7 个位�?键集稳定', () => {
      const keys = Object.keys(wmg.GUARD_SITES);
      expect(keys.length).toBe(EXPECTED_SITES.length);
      for (const k of EXPECTED_SITES) {
        expect(wmg.GUARD_SITES[k]).toBeTruthy();
      }
  });

  test('GUARD_SITES:每个位点�?title/where/danger/directive/exemplar 且非�?, () => {
      for (const [key, site] of Object.entries(wmg.GUARD_SITES)) {
        for (const field of ['title', 'where', 'danger', 'directive', 'exemplar']) {
          expect(typeof site[field]).toBe('string');
          expect(site[field].length > 0).toBeTruthy();
        }
      }
  });

  test('GUARD_SITES:冻结(纯叶子不可变),元素也冻�?, () => {
      expect(Object.isFrozen(wmg.GUARD_SITES).toBeTruthy());
      for (const site of Object.values(wmg.GUARD_SITES)) {
        expect(Object.isFrozen(site).toBeTruthy());
      }
  });

  test('bannerFor:各位点返回非空横�?前缀统一 [AI-弱模型],内容�?site 同源', () => {
      for (const key of EXPECTED_SITES) {
        const banner = wmg.bannerFor(key);
        expect(banner.startsWith('[AI-弱模型] ')).toBeTruthy();
        const site = wmg.GUARD_SITES[key];
        expect(banner.includes(site.title)).toBeTruthy();
        expect(banner.includes(site.directive)).toBeTruthy();
        expect(banner.includes(site.exemplar)).toBeTruthy();
      }
  });

  test('bannerFor:未知/坏输入返回空�?绝不�?纯叶子安全默�?', () => {
      expect(wmg.bannerFor('nope')).toBe('');
      expect(wmg.bannerFor('')).toBe('');
      expect(wmg.bannerFor(undefined)).toBe('');
      expect(wmg.bannerFor(null)).toBe('');
      expect(wmg.bannerFor(123)).toBe('');
  });

  test('buildWeakModelDirective:非空、稳�?两次调用逐字节相�?、含关键不变�?, () => {
      const a = wmg.buildWeakModelDirective();
      const b = wmg.buildWeakModelDirective();
      expect(a).toBe(b);
      expect(a.length > 0).toBeTruthy();
      expect(a).toContain('executeTool');
      expect(a).toContain('PreToolUse');
      expect(a).toContain('pure leaf');
      expect(a).toContain('goalStopGate');
      expect(a).toContain('flagRegistry');
  });

  test('toolCallHint:非空单句,含关键要�?, () => {
      const hint = wmg.toolCallHint();
      expect(hint.length > 0).toBeTruthy();
      expect(!hint.includes('\n')).toBeTruthy();
      expect(hint).toContain('schema');
  });

  test('listGuardSites:返回全部 7 位点,每项�?key 且携带原字段', () => {
      const list = wmg.listGuardSites();
      expect(list.length).toBe(EXPECTED_SITES.length);
      const keys = list.map((s) => s.key);
      for (const k of EXPECTED_SITES) {
        expect(keys.includes(k)).toBeTruthy();
      }
      for (const item of list) {
        expect(typeof item.title).toBe('string');
        expect(typeof item.directive).toBe('string');
      }
  });

  test('WEAK_MODEL_EXEMPLARS:非空、冻�?纯叶子不可变),每条 id/topic/bad/good/why 非空', () => {
      expect(Array.isArray(wmg.WEAK_MODEL_EXEMPLARS).toBeTruthy());
      expect(wmg.WEAK_MODEL_EXEMPLARS.length >= 5).toBeTruthy();
      expect(Object.isFrozen(wmg.WEAK_MODEL_EXEMPLARS).toBeTruthy());
      const ids = new Set();
      for (const ex of wmg.WEAK_MODEL_EXEMPLARS) {
        expect(Object.isFrozen(ex)).toBeTruthy();
        for (const field of ['id', 'topic', 'bad', 'good', 'why']) {
          expect(typeof ex[field]).toBe('string');
          expect(ex[field].length > 0).toBeTruthy();
        }
        expect(!ids.has(ex.id)).toBeTruthy();
        ids.add(ex.id);
      }
  });

  test('WEAK_MODEL_EXEMPLARS:覆盖关键死循环反�?超时重试/无输出重�?手写全盘扫描)', () => {
      const ids = wmg.WEAK_MODEL_EXEMPLARS.map((e) => e.id);
      for (const k of ['retry-timeout', 'repeat-after-no-output', 'handwrite-disk-scan']) {
        expect(ids.includes(k)).toBeTruthy();
      }
  });

  test('buildWeakModelExemplars:门开非空、确定性、含 BAD/GOOD/WHY 与关键反例文�?, () => {
      const a = wmg.buildWeakModelExemplars({});
      const b = wmg.buildWeakModelExemplars({});
      expect(a).toBe(b); // 确定�?      expect(a.length > 0).toBeTruthy();
      expect(a).toContain('BAD:');
      expect(a).toContain('GOOD:');
      expect(a).toContain('WHY:');
      expect(a).toContain('Common weak-model mistakes');
      expect(a).toContain('DiskAnalyze'); // 手写全盘扫描反例的正�?      expect(a).toContain('clamped to 60000'); // 超时重试反例
  });

  test('buildWeakModelExemplars:门关(含大小写/空白 falsy)�?空串(逐字节回退)', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(wmg.buildWeakModelExemplars({ KHY_WEAK_MODEL_GUIDANCE: v })).toBe('');
      }
  });

  test('buildWeakModelExemplars:坏输入不�?返回字符�?纯叶子安全默�?', () => {
      for (const bad of [null, undefined, 42, 'str']) {
        expect(() => wmg.buildWeakModelExemplars(bad).not.toThrow());
        expect(typeof wmg.buildWeakModelExemplars(bad)).toBe('string');
      }
  });

  test('INTENTIONAL_DESIGNS:非空、冻�?纯叶子不可变),每条 id/looksLikeBug/actualDesign/where/why 非空', () => {
      expect(Array.isArray(wmg.INTENTIONAL_DESIGNS).toBeTruthy());
      expect(wmg.INTENTIONAL_DESIGNS.length >= 5).toBeTruthy();
      expect(Object.isFrozen(wmg.INTENTIONAL_DESIGNS).toBeTruthy());
      const ids = new Set();
      for (const d of wmg.INTENTIONAL_DESIGNS) {
        expect(Object.isFrozen(d)).toBeTruthy();
        for (const field of ['id', 'looksLikeBug', 'actualDesign', 'where', 'why']) {
          expect(typeof d[field]).toBe('string');
          expect(d[field].length > 0).toBeTruthy();
        }
        expect(!ids.has(d.id)).toBeTruthy();
        ids.add(d.id);
      }
  });

  test('INTENTIONAL_DESIGNS:覆盖被反复误判的关键刻意设计(默认口令/动态版�?sha256 留空)', () => {
      const ids = wmg.INTENTIONAL_DESIGNS.map((d) => d.id);
      for (const k of ['default-source-secret', 'dynamic-version', 'snapshot-sha256-blank']) {
        expect(ids.includes(k)).toBeTruthy();
      }
  });

  test('buildIntentionalDesigns:门开非空、确定性、含 LOOKS-LIKE-BUG/BY-DESIGN/WHY 与关键条目文�?, () => {
      const a = wmg.buildIntentionalDesigns({});
      const b = wmg.buildIntentionalDesigns({});
      expect(a).toBe(b); // 确定�?      expect(a.length > 0).toBeTruthy();
      expect(a).toContain('LOOKS-LIKE-BUG:');
      expect(a).toContain('BY-DESIGN:');
      expect(a).toContain('WHY:');
      expect(a).toContain('INTENTIONAL');
      expect(a).toContain('check-version-sync'); // dynamic-version 条目
  });

  test('buildIntentionalDesigns:门关(含大小写/空白 falsy)�?空串(逐字节回退)', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(wmg.buildIntentionalDesigns({ KHY_WEAK_MODEL_GUIDANCE: v })).toBe('');
      }
  });

  test('buildIntentionalDesigns:坏输入不�?返回字符�?纯叶子安全默�?', () => {
      for (const bad of [null, undefined, 42, 'str']) {
        expect(() => wmg.buildIntentionalDesigns(bad).not.toThrow());
        expect(typeof wmg.buildIntentionalDesigns(bad)).toBe('string');
      }
  });

  test('listIntentionalDesigns:返回全部条目,每项�?id 且携带原字段', () => {
      const list = wmg.listIntentionalDesigns();
      expect(list.length).toBe(wmg.INTENTIONAL_DESIGNS.length);
      for (const item of list) {
        expect(typeof item.id).toBe('string');
        expect(typeof item.actualDesign).toBe('string');
      }
  });

});

