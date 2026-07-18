/**
 * Unit tests for useModelPivots by-key bucketing + the synthetic bucket labels
 * that the MyGateway header uses to classify groups (system / no-key / own-key).
 * Zero deps — run with the built-in Node test runner (apps/ai-frontend is
 * type:module):
 *   node --test src/composables/useModelPivots.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pivotEdges,
  SYSTEM_KEY_BUCKET,
  NO_KEY_BUCKET,
} from './useModelPivots.js';

function findGroup(groups, key) {
  return groups.find(g => g.groupKey === key) || null;
}

test('bucket constants have the exact labels the grouping emits', () => {
  assert.equal(SYSTEM_KEY_BUCKET, '(系统密钥)');
  assert.equal(NO_KEY_BUCKET, '(无 Key)');
});

test('by-key: system-* edge with no own key id lands in the (系统密钥) bucket', () => {
  const edges = [
    { provider: 'sensenova', model: 'deepseek-v4-flash', keyIds: [], capability: 'text', status: 'system-ready', connectionMode: 'system', source: 'system' },
    { provider: 'relay', model: 'gpt-4o-mini', keyIds: [], capability: 'text', status: 'system-ready', connectionMode: 'system', source: 'system' },
  ];
  const groups = pivotEdges(edges, 'by-key');
  const sys = findGroup(groups, SYSTEM_KEY_BUCKET);
  assert.ok(sys, 'system bucket exists');
  assert.equal(sys.edges.length, 2);
  // No real key id ever leaks into the bucket key (tenant isolation).
  assert.equal(findGroup(groups, NO_KEY_BUCKET), null);
});

test('by-key: a user-owned key id forms its OWN group (not the system bucket)', () => {
  const edges = [
    { provider: 'deepseek', model: 'deepseek-chat', keyIds: ['user-key-42'], capability: 'text', status: 'active', connectionMode: 'direct', source: 'provider' },
    { provider: 'deepseek', model: 'deepseek-reasoner', keyIds: ['user-key-42'], capability: 'text', status: 'active', connectionMode: 'direct', source: 'provider' },
  ];
  const groups = pivotEdges(edges, 'by-key');
  const own = findGroup(groups, 'user-key-42');
  assert.ok(own, 'own-key group keyed by the user key id');
  assert.equal(own.edges.length, 2);
  // Single provider → the header can resolve a target for + 添加模型 / edit jump.
  assert.deepEqual([...new Set(own.edges.map(e => e.provider))], ['deepseek']);
  assert.equal(findGroup(groups, SYSTEM_KEY_BUCKET), null);
});

test('by-key: a keyless non-system edge falls into the (无 Key) bucket', () => {
  const edges = [
    { provider: 'custom', model: 'mystery', keyIds: [], capability: 'text', status: 'needs-key', connectionMode: 'direct', source: 'provider' },
  ];
  const groups = pivotEdges(edges, 'by-key');
  const none = findGroup(groups, NO_KEY_BUCKET);
  assert.ok(none, 'no-key bucket exists');
  assert.equal(none.edges.length, 1);
  assert.equal(findGroup(groups, SYSTEM_KEY_BUCKET), null);
});

test('by-key: system, own-key and no-key buckets coexist without conflation', () => {
  const edges = [
    { provider: 'sensenova', model: 'deepseek-v4-flash', keyIds: [], status: 'system-ready', source: 'system' },
    { provider: 'deepseek', model: 'deepseek-chat', keyIds: ['user-key-7'], status: 'active', source: 'provider' },
    { provider: 'custom', model: 'mystery', keyIds: [], status: 'needs-key', source: 'provider' },
  ];
  const groups = pivotEdges(edges, 'by-key');
  assert.ok(findGroup(groups, SYSTEM_KEY_BUCKET), 'system bucket');
  assert.ok(findGroup(groups, 'user-key-7'), 'own-key bucket');
  assert.ok(findGroup(groups, NO_KEY_BUCKET), 'no-key bucket');
});
