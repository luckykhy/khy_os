'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ModelMesh,
  authorize,
  matches,
  serializableOptions,
  parseRestrictedModels,
  ipAllowed,
  locallyServes,
  localCapabilities,
} = require('../../src/services/modelMesh');

test('model mesh authenticates and matches exact model/capability', () => {
  assert.equal(authorize('mesh-secret', { KHY_MESH_TOKEN: 'mesh-secret' }), true);
  assert.equal(authorize('wrong', { KHY_MESH_TOKEN: 'mesh-secret' }), false);
  assert.equal(matches({ models: ['MODEL_A'], capabilities: ['vision'] }, { model: 'model_a' }), true);
  assert.equal(matches({ models: ['MODEL_A'], capabilities: ['vision'] }, { meshCapability: 'vision' }), true);
  assert.equal(matches({ models: ['MODEL_A'], capabilities: [] }, { model: 'model_b' }), false);
});

test('model mesh discovers, selects and forwards one request', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/mesh/capabilities')) {
      return { ok: true, status: 200, async json() { return { id: 'node-b', models: ['MODEL_A'], capabilities: ['vision'] }; } };
    }
    return { ok: true, status: 200, async json() { return { success: true, content: 'remote answer', adapter: 'claude' }; } };
  };
  const mesh = new ModelMesh({
    env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 'mesh-secret', KHY_MESH_PEERS: JSON.stringify([{ id: 'node-b', url: 'http://node-b' }]) },
    fetch,
  });
  const result = await mesh.forward('hello', { model: 'MODEL_A', onChunk() {} });
  assert.equal(result.content, 'remote answer');
  assert.deepEqual(result.mesh, { peerId: 'node-b', remote: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['x-khy-mesh-token'], 'mesh-secret');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.options._meshHop, 1);
});

test('forward is skipped for disabled mesh and forwarded requests', async () => {
  let called = false;
  const mesh = new ModelMesh({ env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 'x' }, fetch: async () => { called = true; } });
  assert.equal(await mesh.forward('hello', { model: 'MODEL_A', _meshHop: 1 }), null);
  assert.equal(called, false);
  assert.deepEqual(serializableOptions({ model: 'x', onChunk() {}, _meshHop: 1 })._meshHop, 2);
});

test('restriction helpers parse rules, match IPs and decide local serving', () => {
  const rules = parseRestrictedModels('gpt-5=10.0.0.5|192.168.1.0/24, claude-opus-5 = *');
  assert.deepEqual(rules['gpt-5'], ['10.0.0.5', '192.168.1.0/24']);
  assert.deepEqual(rules['claude-opus-5'], ['*']);
  assert.equal(ipAllowed(['10.0.0.5'], '10.0.0.5'), true);
  assert.equal(ipAllowed(['10.0.0.5'], '10.0.0.6'), false);
  assert.equal(ipAllowed(['192.168.1.0/24'], '192.168.1.77'), true);
  assert.equal(ipAllowed(['192.168.1.0/24'], '10.0.0.1'), false);
  assert.equal(ipAllowed(['*'], '127.0.0.1'), true);
  assert.equal(ipAllowed([], '127.0.0.1'), true); // no rules -> allow
  // Restricted to '*': reachable nowhere locally.
  assert.equal(locallyServes({ KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' }, 'gpt-5'), false);
  // Restricted to an IP that IS the local override -> served locally.
  assert.equal(locallyServes({ KHY_MESH_RESTRICTED_MODELS: 'gpt-5=10.0.0.5', KHY_MESH_LOCAL_IP: '10.0.0.5' }, 'gpt-5'), true);
  // Unlisted model -> always served locally.
  assert.equal(locallyServes({ KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' }, 'other-model'), true);
});

test('forwarding honors IP restrictions but still syncs unrestricted models to a peer', async () => {
  const peer = { id: 'node-b', url: 'http://node-b' };
  const fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (url.endsWith('/api/mesh/capabilities')) return { id: 'node-b', models: ['gpt-5', 'claude-5'], capabilities: [] };
      return { success: true, content: 'x', adapter: 'claude' };
    },
  });

  // Restricted-to-* model with a matching peer -> local cannot serve it, forward.
  const forwardable = new ModelMesh({
    env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 't', KHY_MESH_PEERS: JSON.stringify([peer]), KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' },
    fetch,
  });
  assert.ok(await forwardable.select({ model: 'gpt-5' }));
  assert.ok(await forwardable.forward('hi', { model: 'gpt-5' }));

  // Unrestricted model (not named in RESTRICTED_MODELS) with a matching peer ->
  // still syncs to the peer even though restrictions are declared.
  const eager = new ModelMesh({
    env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 't', KHY_MESH_PEERS: JSON.stringify([peer]), KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' },
    fetch,
  });
  assert.ok(await eager.select({ model: 'claude-5' }), 'unrestricted model forwards to a matching peer');
  assert.ok(await eager.forward('hi', { model: 'claude-5' }));

  // Restricted to a local IP -> this node serves it, no forward.
  const servedLocally = new ModelMesh({
    env: {
      KHY_MODEL_MESH: 'true',
      KHY_MESH_TOKEN: 't',
      KHY_MESH_PEERS: JSON.stringify([peer]),
      KHY_MESH_RESTRICTED_MODELS: 'gpt-5=10.0.0.5',
      KHY_MESH_LOCAL_IP: '10.0.0.5',
    },
    fetch,
  });
  assert.equal(await servedLocally.select({ model: 'gpt-5' }), null);

  // Legacy mode (no RESTRICTED_MODELS) still forwards eagerly on match.
  const legacy = new ModelMesh({
    env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 't', KHY_MESH_PEERS: JSON.stringify([peer]), KHY_MESH_MODELS: 'gpt-5' },
    fetch,
  });
  assert.ok(await legacy.select({ model: 'gpt-5' }));
});

test('peer advertising the requested model as restricted is excluded from selection', async () => {
  const peer = { id: 'node-b', url: 'http://node-b' };
  const fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (url.endsWith('/api/mesh/capabilities')) return { id: 'node-b', models: ['gpt-5'], restrictedModels: ['gpt-5'] };
      return { success: true, content: 'x' };
    },
  });
  // Restricted-to-* here so the model WOULD be forwarded if a usable peer existed.
  const mesh = new ModelMesh({
    env: { KHY_MODEL_MESH: 'true', KHY_MESH_TOKEN: 't', KHY_MESH_PEERS: JSON.stringify([peer]), KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' },
    fetch,
  });
  assert.equal(await mesh.select({ model: 'gpt-5' }), null);
  assert.equal(await mesh.forward('hi', { model: 'gpt-5' }), null);
});

test('localCapabilities advertises restrictedModels the node cannot serve', () => {
  const caps = localCapabilities({ KHY_MESH_NODE_ID: 'node-a', KHY_MESH_MODELS: 'gpt-5', KHY_MESH_RESTRICTED_MODELS: 'gpt-5=*' });
  assert.deepEqual(caps.restrictedModels, ['gpt-5']);
  const served = localCapabilities({ KHY_MESH_RESTRICTED_MODELS: 'gpt-5=10.0.0.5', KHY_MESH_LOCAL_IP: '10.0.0.5' });
  assert.deepEqual(served.restrictedModels, []);
});
