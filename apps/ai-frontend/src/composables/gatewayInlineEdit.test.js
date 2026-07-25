/**
 * Unit tests for gatewayInlineEdit pure helpers. Zero deps — run with the
 * built-in Node test runner (apps/ai-frontend is type:module):
 *   node --test src/composables/gatewayInlineEdit.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  userEdgeRowId,
  userEdgeEditable,
  userEdgeReadonlyTag,
  ownKeyRowForGroup,
  poolKeyForGroup,
  adminQualifiedId,
  adminEdgeEditable,
  adminEdgeTarget,
  applyApiOverridesToEdges,
} from './gatewayInlineEdit.js';

// ── user plane ──────────────────────────────────────────────────────────────

test('userEdgeRowId: exact + case-insensitive match', () => {
  const models = [
    { id: 7, provider: 'deepseek', model: 'deepseek-chat' },
    { id: 9, provider: 'relay', model: 'gpt-4o-mini' },
  ];
  assert.equal(userEdgeRowId({ provider: 'deepseek', model: 'deepseek-chat', source: 'provider' }, models), 7);
  assert.equal(userEdgeRowId({ provider: 'DeepSeek', model: 'DEEPSEEK-CHAT', source: 'provider' }, models), 7);
  assert.equal(userEdgeRowId({ provider: 'relay', model: 'gpt-4o-mini', source: 'relay' }, models), 9);
});

test('userEdgeRowId: empty model / no row → null', () => {
  const models = [{ id: 1, provider: 'deepseek', model: 'deepseek-chat' }];
  assert.equal(userEdgeRowId({ provider: 'deepseek', model: '', source: 'provider' }, models), null);
  assert.equal(userEdgeRowId({ provider: 'openai', model: 'gpt-4o', source: 'provider' }, models), null);
});

test('userEdgeEditable: provider/relay with row = true; system/local/rowless = false', () => {
  const models = [{ id: 1, provider: 'deepseek', model: 'deepseek-chat' }];
  assert.equal(userEdgeEditable({ provider: 'deepseek', model: 'deepseek-chat', source: 'provider' }, models), true);
  assert.equal(userEdgeEditable({ provider: 'deepseek', model: 'deepseek-chat', source: 'system' }, models), false);
  assert.equal(userEdgeEditable({ provider: 'local', model: 'llama3', source: 'local' }, models), false);
  // provider edge but no backing row (e.g. placeholder)
  assert.equal(userEdgeEditable({ provider: 'deepseek', model: '', source: 'provider' }, models), false);
});

test('userEdgeReadonlyTag: source → label', () => {
  assert.equal(userEdgeReadonlyTag({ source: 'system' }), '系统/全局');
  assert.equal(userEdgeReadonlyTag({ source: 'local' }), '本地 Ollama');
  assert.equal(userEdgeReadonlyTag({ source: 'relay' }), '只读');
});

// ── ownKeyRowForGroup (by-key own-key → masked preview join) ──────────────────

test('ownKeyRowForGroup: group key (own key id) → masked provider row', () => {
  const providers = [
    { id: 7, provider: 'deepseek', displayName: 'DeepSeek', keyMasked: 'sk-…1234', label: '我的主号', isActive: true },
    { id: 9, provider: 'openai', displayName: '', keyMasked: 'sk-…abcd', label: '', isActive: true },
  ];
  // The user-plane catalog uses String(row.id) as the own-key group key.
  const row = ownKeyRowForGroup('7', providers);
  assert.ok(row);
  assert.equal(row.keyMasked, 'sk-…1234');
  assert.equal(row.provider, 'deepseek');
  // Numeric group key also matches (String() coercion on both sides).
  assert.equal(ownKeyRowForGroup(9, providers).provider, 'openai');
});

test('ownKeyRowForGroup: synthetic buckets / unknown id / empty inputs → null', () => {
  const providers = [{ id: 7, provider: 'deepseek', keyMasked: 'sk-…1234' }];
  // The synthetic by-key buckets are never row ids → no match (no system secret).
  assert.equal(ownKeyRowForGroup('(系统密钥)', providers), null);
  assert.equal(ownKeyRowForGroup('(无 Key)', providers), null);
  assert.equal(ownKeyRowForGroup('999', providers), null);
  assert.equal(ownKeyRowForGroup('', providers), null);
  assert.equal(ownKeyRowForGroup(null, providers), null);
  assert.equal(ownKeyRowForGroup('7', null), null);
});

// ── poolKeyForGroup (admin by-key group → masked preview join) ────────────────

test('poolKeyForGroup: group key (pool key id) → masked preview + label + provider', () => {
  const pool = {
    sensenova: [
      { keyId: 'k-aaa', keyPreview: 'sk-…1234', label: '主号', status: 'active' },
      { keyId: 'k-bbb', keyPreview: 'sk-…5678', label: '', status: 'cooldown' },
    ],
    relay: [{ keyId: 'k-ccc', keyPreview: 'sk-…9999', label: '中转', status: 'active' }],
  };
  assert.deepEqual(poolKeyForGroup('k-aaa', pool), { keyId: 'k-aaa', keyPreview: 'sk-…1234', label: '主号', provider: 'sensenova' });
  assert.equal(poolKeyForGroup('k-ccc', pool).provider, 'relay');
  assert.equal(poolKeyForGroup('k-bbb', pool).label, ''); // missing label → ''
});

test('poolKeyForGroup: synthetic buckets / unknown id / empty inputs → null', () => {
  const pool = { sensenova: [{ keyId: 'k-aaa', keyPreview: 'sk-…1234' }] };
  assert.equal(poolKeyForGroup('(无 Key)', pool), null);
  assert.equal(poolKeyForGroup('(系统密钥)', pool), null);
  assert.equal(poolKeyForGroup('k-zzz', pool), null);
  assert.equal(poolKeyForGroup('', pool), null);
  assert.equal(poolKeyForGroup(null, pool), null);
  assert.equal(poolKeyForGroup('k-aaa', null), null);
  assert.equal(poolKeyForGroup('k-aaa', {}), null);
});

// ── admin plane ─────────────────────────────────────────────────────────────

test('adminQualifiedId / adminEdgeEditable', () => {
  assert.equal(adminQualifiedId({ provider: 'sensenova', model: 'SenseNova-V6', source: 'chat' }), 'api:sensenova:SenseNova-V6');
  assert.equal(adminEdgeEditable({ provider: 'sensenova', model: 'x', source: 'chat' }), true);
  assert.equal(adminEdgeEditable({ provider: 'dalle', model: 'dall-e-3', source: 'image' }), false);
  assert.equal(adminEdgeEditable({ provider: 'x', model: '', source: 'chat' }), false);
});

test('adminEdgeTarget: chat → qualified id + custom flag; image/video → null', () => {
  const overrides = { api: { added: [{ id: 'api:deepseek:my-model', name: 'Mine' }] } };
  const t1 = adminEdgeTarget({ provider: 'deepseek', model: 'my-model', source: 'chat' }, overrides);
  assert.deepEqual(t1, { adapter: 'api', qualifiedId: 'api:deepseek:my-model', custom: true });
  const t2 = adminEdgeTarget({ provider: 'deepseek', model: 'deepseek-chat', source: 'chat' }, overrides);
  assert.equal(t2.custom, false);
  assert.equal(adminEdgeTarget({ provider: 'v', model: 'sora', source: 'video' }, overrides), null);
});

// ── applyApiOverridesToEdges ─────────────────────────────────────────────────

const baseEdges = () => [
  { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', keyIds: ['k1'], keyCount: 1, capability: 'text', tier: 'T1', status: 'active', connectionMode: 'account-pool', isDefault: false, source: 'chat' },
  { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-reasoner', keyIds: ['k1'], keyCount: 1, capability: 'text', tier: 'T0', status: 'active', connectionMode: 'account-pool', isDefault: false, source: 'chat' },
  { provider: 'dalle', providerLabel: 'dalle (image)', model: 'dall-e-3', keyIds: [], keyCount: 0, capability: 'image', tier: 'T3', status: 'active', connectionMode: 'direct', isDefault: false, source: 'image' },
];

test('applyApiOverridesToEdges: hidden removed, renamed relabeled, default re-derived', () => {
  const overrides = { api: {
    hidden: ['api:deepseek:deepseek-reasoner'],
    renamed: { 'api:deepseek:deepseek-chat': 'DeepSeek Chat ✨' },
    defaultModel: 'api:deepseek:deepseek-chat',
  } };
  const out = applyApiOverridesToEdges(baseEdges(), overrides);
  // reasoner hidden
  assert.equal(out.some(e => e.model === 'deepseek-reasoner'), false);
  const chat = out.find(e => e.model === 'deepseek-chat');
  assert.equal(chat.displayName, 'DeepSeek Chat ✨');
  assert.equal(chat.isDefault, true);
  assert.equal(chat.editable, true);
  assert.equal(chat.qualifiedId, 'api:deepseek:deepseek-chat');
  // image edge: read-only, untouched
  const img = out.find(e => e.model === 'dall-e-3');
  assert.equal(img.editable, false);
});

test('applyApiOverridesToEdges: added injected once, custom, keyIds:[] (no key leak)', () => {
  const overrides = { api: { added: [{ id: 'api:deepseek:deepseek-v4', name: 'DS V4' }] } };
  const out = applyApiOverridesToEdges(baseEdges(), overrides);
  const added = out.filter(e => e.model === 'deepseek-v4');
  assert.equal(added.length, 1, 'injected exactly once');
  assert.equal(added[0].custom, true);
  assert.equal(added[0].displayName, 'DS V4');
  assert.deepEqual(added[0].keyIds, []);
  // cloned pivot dims from sibling deepseek edge
  assert.equal(added[0].providerLabel, 'DeepSeek');
  assert.equal(added[0].connectionMode, 'account-pool');
});

test('applyApiOverridesToEdges: added already present is not duplicated', () => {
  const overrides = { api: { added: [{ id: 'api:deepseek:deepseek-chat', name: 'x' }] } };
  const out = applyApiOverridesToEdges(baseEdges(), overrides);
  assert.equal(out.filter(e => e.model === 'deepseek-chat').length, 1);
  // the live edge is flagged custom because it's in added
  assert.equal(out.find(e => e.model === 'deepseek-chat').custom, true);
});

test('applyApiOverridesToEdges: no overrides → chat editable, inputs not mutated', () => {
  const edges = baseEdges();
  const out = applyApiOverridesToEdges(edges, {});
  assert.equal(out.find(e => e.model === 'deepseek-chat').editable, true);
  assert.equal(out.find(e => e.model === 'dall-e-3').editable, false);
  // original input untouched
  assert.equal('editable' in edges[0], false);
});
