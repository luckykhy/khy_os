'use strict';

// docMarkerSync 叶子契约测试(node:test)。
// Layer 3:只替换成对且 key 已知的标记块内部;未知 key 留原样;不平衡跳过;幂等;free prose 不动。
const test = require('node:test');
const assert = require('node:assert');

const {
  docMarkerSyncEnabled,
  syncManagedRegions,
  buildValueMap,
  NOTICE,
} = require('../../src/services/docsFreshness/docMarkerSync');

const B = (key, extra = '') => `<!-- khy-docs-sync:begin key=${key}${extra ? ' ' + extra : ''} -->`;
const E = (key) => `<!-- khy-docs-sync:end key=${key} -->`;

test('docMarkerSyncEnabled 默认开,{0,false,off,no} 关', () => {
  assert.strictEqual(docMarkerSyncEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(docMarkerSyncEnabled({ KHY_DOCS_MARKER_SYNC: off }), false);
  }
});

test('已知 key:填充块内部为 NOTICE + 值,标记行逐字保留', () => {
  const doc = [
    '# Doc',
    B('ai-backend-port', 'source=serviceDefaults'),
    '(旧内容)',
    '1234',
    E('ai-backend-port'),
    '正文继续',
  ].join('\n');
  const r = syncManagedRegions(doc, new Map([['ai-backend-port', '9090']]));
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.changedRegions, [{ key: 'ai-backend-port' }]);
  const expect = [
    '# Doc',
    B('ai-backend-port', 'source=serviceDefaults'),
    NOTICE,
    '9090',
    E('ai-backend-port'),
    '正文继续',
  ].join('\n');
  assert.strictEqual(r.text, expect);
});

test('幂等:对已同步文本再跑一次 → changed=false,文本不变', () => {
  const map = new Map([['ai-backend-port', '9090']]);
  const doc = ['x', B('ai-backend-port'), '(旧)', E('ai-backend-port'), 'y'].join('\n');
  const once = syncManagedRegions(doc, map);
  const twice = syncManagedRegions(once.text, map);
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.text, once.text);
});

test('多行值(如 slash-commands)按行展开', () => {
  const doc = [B('slash-commands'), 'old', E('slash-commands')].join('\n');
  const r = syncManagedRegions(doc, new Map([['slash-commands', '- `/a`\n- `/b`']]));
  assert.strictEqual(r.text, [B('slash-commands'), NOTICE, '- `/a`', '- `/b`', E('slash-commands')].join('\n'));
});

test('未知 key:整块原样保留 + 上报 unknownKeys', () => {
  const doc = ['head', B('mystery'), 'keep-me', E('mystery'), 'tail'].join('\n');
  const r = syncManagedRegions(doc, new Map([['ai-backend-port', '9090']]));
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.unknownKeys, ['mystery']);
  assert.strictEqual(r.text, doc); // 逐字不变
});

test('不平衡(begin 无 end)→ 跳过,文本不变 + 上报 skipped', () => {
  const doc = ['a', B('k'), 'orphan begin no end'].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v']]));
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, doc);
  assert.strictEqual(r.skipped[0].reason, 'unbalanced');
});

test('嵌套(begin 内又见 begin)→ 跳过', () => {
  const doc = [B('k'), B('k2'), E('k2'), E('k')].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v'], ['k2', 'w']]));
  // 外层 k 因中间又出现 begin → 视为 nested 跳过。
  assert.ok(r.skipped.some((s) => s.reason === 'nested'));
});

test('end key 与 begin key 不匹配 → 跳过该块', () => {
  const doc = [B('k'), 'body', E('other')].join('\n');
  const r = syncManagedRegions(doc, new Map([['k', 'v']]));
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.skipped[0].reason, 'unbalanced');
});

test('无标记的 free prose 绝不动', () => {
  const doc = '# 纯正文\n没有任何标记\n`services/x.js` 引用\n结束';
  const r = syncManagedRegions(doc, new Map([['ai-backend-port', '9090']]));
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, doc);
});

test('接受普通对象作为 valueMap', () => {
  const doc = [B('khy-version'), 'x', E('khy-version')].join('\n');
  const r = syncManagedRegions(doc, { 'khy-version': '0.1.148' });
  assert.strictEqual(r.text, [B('khy-version'), NOTICE, '0.1.148', E('khy-version')].join('\n'));
});

test('垃圾/空输入不抛', () => {
  assert.strictEqual(syncManagedRegions(null, new Map()).text, '');
  assert.strictEqual(syncManagedRegions(42, new Map()).changed, false);
  assert.doesNotThrow(() => syncManagedRegions('x', null));
});

test('buildValueMap:注入 SSOT 依赖 → 已知 key;frontend-port 拒绝', () => {
  const m = buildValueMap({
    slashCommands: [{ cmd: '/a', desc: 'A' }, { cmd: '/b', label: 'B' }, { nope: 1 }],
    aiBackendPort: 9090,
    khyVersion: '0.1.148',
  });
  assert.strictEqual(m.get('ai-backend-port'), '9090');
  assert.strictEqual(m.get('khy-version'), '0.1.148');
  assert.ok(m.get('slash-commands').includes('- `/a` — A'));
  assert.ok(m.get('slash-commands').includes('- `/b` — B'));
  assert.strictEqual(m.has('frontend-port'), false); // 无 SSOT,拒绝
});

test('buildValueMap:缺依赖 → 不入表(不杜撰)', () => {
  const m = buildValueMap({});
  assert.strictEqual(m.size, 0);
  assert.doesNotThrow(() => buildValueMap(null));
});

test('端到端:buildValueMap + syncManagedRegions 同步 ai-backend-port', () => {
  const map = buildValueMap({ aiBackendPort: 9090 });
  const doc = [B('ai-backend-port'), '旧', E('ai-backend-port')].join('\n');
  const r = syncManagedRegions(doc, map);
  assert.ok(r.text.includes('9090'));
  assert.strictEqual(r.changed, true);
});
