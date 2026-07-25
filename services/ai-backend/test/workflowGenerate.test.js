/**
 * workflowGenerateService — natural-language → workflow graph.
 *
 * The LLM call is injected via opts._chatFn, so these tests run fully offline and
 * exercise the real pipeline: JSON extraction → graph coercion → strict
 * validateGraph → one repair round → auto-layout, never returning a half-built
 * graph. A throwaway SQLite DB is bound before any @khy/shared model loads so the
 * persist path can hit workflowService.create.
 */
'use strict';

const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `khy-wf-generate-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-generate';
process.env.NODE_ENV = 'test';

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/workflowGenerateService');
const userGateway = require('../src/services/userGatewayConfigService');
const { extractFirstJson, autoLayout } = svc;

// A minimal valid graph the model "returns". start → toolCall → end.
function validGraphObj(extra = {}) {
  return {
    name: 'Summarize a URL',
    description: 'fetch then summarize',
    nodes: [
      { id: 'n1', type: 'start', name: 'Start' },
      { id: 'n2', type: 'http', name: 'Fetch', data: { url: 'https://example.com' } },
      { id: 'n3', type: 'prompt', name: 'Summarize', data: { prompt: 'summarize' } },
      { id: 'n4', type: 'end', name: 'End' },
    ],
    connections: [
      { id: 'c1', from: 'n1', fromPort: 'default', to: 'n2', toPort: 'input' },
      { id: 'c2', from: 'n2', fromPort: 'default', to: 'n3', toPort: 'input' },
      { id: 'c3', from: 'n3', fromPort: 'default', to: 'n4', toPort: 'input' },
    ],
    ...extra,
  };
}

let testUserId;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  const u = await User.create({
    username: 'wfgen',
    email: 'wfgen@test.local',
    password: 'pw-wfgen-123',
    status: 'active',
  });
  testUserId = u.id;
});

afterAll(async () => {
  await sequelize.close();
});

describe('extractFirstJson', () => {
  test('parses a bare JSON object', () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });
  test('strips a ```json fence', () => {
    expect(extractFirstJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  test('scans for a balanced object amid prose', () => {
    expect(extractFirstJson('sure! here:\n{"a":{"b":3}} done')).toEqual({ a: { b: 3 } });
  });
  test('returns null on no object', () => {
    expect(extractFirstJson('no json here')).toBeNull();
  });
});

describe('generate', () => {
  test('valid model reply → graph passes validation, not persisted by default', async () => {
    const chatFn = async () => JSON.stringify(validGraphObj());
    const out = await svc.generate(testUserId, { prompt: 'summarize a url', _chatFn: chatFn });

    expect(out.graph.nodes).toHaveLength(4);
    expect(out.graph.connections).toHaveLength(3);
    expect(out.report.repaired).toBe(false);
    expect(out.workflow).toBeUndefined();
    // Every node has real coordinates from auto-layout (not all at origin).
    const xs = out.graph.nodes.map((n) => n.position.x);
    expect(new Set(xs).size).toBeGreaterThan(1);
  });

  test('dirty JSON (fences + prose) is repaired/extracted successfully', async () => {
    const chatFn = async () =>
      'Here is your workflow:\n```json\n' + JSON.stringify(validGraphObj()) + '\n```\nEnjoy!';
    const out = await svc.generate(testUserId, { prompt: 'x', _chatFn: chatFn });
    expect(out.graph.nodes).toHaveLength(4);
  });

  test('first reply invalid → second reply valid → one repair round', async () => {
    const replies = [
      // No start node — fails strict validation.
      JSON.stringify({
        nodes: [{ id: 'n1', type: 'end', name: 'End' }],
        connections: [],
      }),
      JSON.stringify(validGraphObj()),
    ];
    let i = 0;
    const chatFn = async () => replies[i++];
    const out = await svc.generate(testUserId, { prompt: 'x', _chatFn: chatFn });
    expect(i).toBe(2); // called twice (repair round)
    expect(out.report.repaired).toBe(true);
    expect(out.graph.nodes).toHaveLength(4);
  });

  test('two invalid replies → structured 422, nothing persisted', async () => {
    const before = await countWorkflows();
    const chatFn = async () =>
      JSON.stringify({ nodes: [{ id: 'n1', type: 'end' }], connections: [] });
    await expect(
      svc.generate(testUserId, { prompt: 'x', persist: true, _chatFn: chatFn }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const after = await countWorkflows();
    expect(after).toBe(before); // never half-built
  });

  test('persist:true creates a workflow and returns it', async () => {
    const chatFn = async () => JSON.stringify(validGraphObj());
    const out = await svc.generate(testUserId, { prompt: 'persist me', persist: true, _chatFn: chatFn });
    expect(out.workflow).toBeTruthy();
    expect(out.workflow.id).toBeTruthy();
    expect(out.workflow.name).toBeTruthy();
  });

  test('empty prompt → 400', async () => {
    await expect(svc.generate(testUserId, { prompt: '  ', _chatFn: async () => '{}' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('autoLayout', () => {
  test('assigns increasing x by topological level', () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'start', position: { x: 0, y: 0 } },
        { id: 'b', type: 'end', position: { x: 0, y: 0 } },
      ],
      connections: [{ id: 'c', from: 'a', fromPort: 'default', to: 'b', toPort: 'input' }],
    };
    autoLayout(graph);
    const a = graph.nodes.find((n) => n.id === 'a');
    const b = graph.nodes.find((n) => n.id === 'b');
    expect(b.position.x).toBeGreaterThan(a.position.x);
  });

  test('orphan / cycle nodes still get coordinates', () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'start', position: { x: 0, y: 0 } },
        { id: 'orphan', type: 'code', position: { x: 0, y: 0 } },
      ],
      connections: [],
    };
    autoLayout(graph);
    for (const n of graph.nodes) {
      expect(typeof n.position.x).toBe('number');
      expect(typeof n.position.y).toBe('number');
    }
  });
});

describe('_presetForProvider', () => {
  test('maps a known provider id to its preset endpoint + default model', () => {
    const p = svc._presetForProvider('deepseek');
    expect(p).toBeTruthy();
    expect(p.baseUrl).toMatch(/^https?:\/\//);
    expect(p.defaultModel).toBeTruthy();
    expect(p.keyField).toBe('authorization_bearer');
  });
  test('is case/space tolerant', () => {
    expect(svc._presetForProvider('  DeepSeek ')).toBeTruthy();
  });
  test('unknown provider → null', () => {
    expect(svc._presetForProvider('not-a-real-provider')).toBeNull();
  });
  test('empty input → null', () => {
    expect(svc._presetForProvider('')).toBeNull();
  });
});

// Snapshot + clear the global relay env so resolver tests are deterministic
// regardless of any ambient .env. Each suite restores the original values.
const RELAY_ENV_KEYS = ['RELAY_API_ENDPOINT', 'RELAY_API_KEY', 'RELAY_API_MODEL', 'RELAY_API_KEY_FIELD'];
function snapshotRelayEnv() {
  const saved = {};
  for (const k of RELAY_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function clearRelayEnv() {
  for (const k of RELAY_ENV_KEYS) delete process.env[k];
}
function restoreRelayEnv(saved) {
  for (const k of RELAY_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe('_resolveSystemRelay (global gateway fallback)', () => {
  let _saved;
  beforeEach(() => { _saved = snapshotRelayEnv(); clearRelayEnv(); });
  afterEach(() => { restoreRelayEnv(_saved); });

  test('no RELAY_API_ENDPOINT → null', () => {
    expect(svc._resolveSystemRelay()).toBeNull();
  });

  test('endpoint + key + model → resolved upstream shape', () => {
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = 'sk-sys-1';
    process.env.RELAY_API_MODEL = 'claude-3.5-sonnet';
    const up = svc._resolveSystemRelay();
    expect(up).toEqual({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-sys-1',
      apiKeyField: 'authorization_bearer',
      model: 'claude-3.5-sonnet',
    });
  });

  test('multi-key value (comma/newline delimited) → first key', () => {
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = 'sk-first, sk-second\nsk-third';
    expect(svc._resolveSystemRelay().apiKey).toBe('sk-first');
  });

  test('JSON-array key value → first usable key (string or {key})', () => {
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = JSON.stringify([{ key: 'sk-obj-1' }, 'sk-obj-2']);
    expect(svc._resolveSystemRelay().apiKey).toBe('sk-obj-1');
  });

  test('RELAY_API_KEY_FIELD=x-api-key is honored', () => {
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = 'sk-x';
    process.env.RELAY_API_KEY_FIELD = 'x-api-key';
    expect(svc._resolveSystemRelay().apiKeyField).toBe('x-api-key');
  });

  test('endpoint set but no key (keyless self-hosted relay) → still resolves with empty key', () => {
    process.env.RELAY_API_ENDPOINT = 'http://localhost:11434/v1';
    const up = svc._resolveSystemRelay();
    expect(up.baseUrl).toBe('http://localhost:11434/v1');
    expect(up.apiKey).toBe('');
  });
});

describe('_resolveUpstream', () => {
  // Resolver tests must see a deterministic (empty) global relay env unless a
  // case sets it explicitly — otherwise an ambient .env would mask the per-user
  // assertions now that _resolveUpstream falls back to the system relay.
  let _savedRelayEnv;
  beforeEach(() => { _savedRelayEnv = snapshotRelayEnv(); clearRelayEnv(); });
  afterEach(() => { restoreRelayEnv(_savedRelayEnv); });

  // A dedicated user per case keeps provider/relay state isolated.
  async function freshUser(name) {
    const u = await User.create({
      username: name,
      email: `${name}@test.local`,
      password: 'pw-resolve-123',
      status: 'active',
    });
    return u.id;
  }

  test('no relay and no providers → null (caller turns this into an actionable 409)', async () => {
    const uid = await freshUser('res-empty');
    expect(await svc._resolveUpstream(uid)).toBeNull();
  });

  test('no per-user config BUT a global relay is set → falls back to the system relay', async () => {
    // The reported bug: normal chat works via the global gateway, but workflow
    // generation only consulted the empty per-user store → "No AI upstream".
    const uid = await freshUser('res-sysfallback');
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = 'sk-global';
    process.env.RELAY_API_MODEL = 'claude-3.5-sonnet';
    const up = await svc._resolveUpstream(uid);
    expect(up).toBeTruthy();
    expect(up.baseUrl).toBe('https://relay.example.com/v1');
    expect(up.apiKey).toBe('sk-global');
    expect(up.model).toBe('claude-3.5-sonnet');
  });

  test('a per-user provider still WINS over the global relay (precedence preserved)', async () => {
    const uid = await freshUser('res-precedence');
    process.env.RELAY_API_ENDPOINT = 'https://relay.example.com/v1';
    process.env.RELAY_API_KEY = 'sk-global';
    await userGateway.addProviderEntry(uid, { provider: 'deepseek', key: 'sk-user-deepseek' });
    const up = await svc._resolveUpstream(uid);
    expect(up.apiKey).toBe('sk-user-deepseek'); // per-user wins
    expect(up.baseUrl).toMatch(/deepseek/);
  });

  test('provider with a key but NO baseUrl resolves via its preset endpoint', async () => {
    const uid = await freshUser('res-preset');
    // The common "pick provider, paste key" flow: only a key is stored.
    await userGateway.addProviderEntry(uid, { provider: 'deepseek', key: 'sk-test-deepseek' });
    const up = await svc._resolveUpstream(uid);
    expect(up).toBeTruthy();
    expect(up.apiKey).toBe('sk-test-deepseek');
    expect(up.baseUrl).toMatch(/deepseek/);
    expect(up.model).toBeTruthy(); // seeded from the preset's default model
  });

  test('an explicit baseUrl on the provider wins over any preset', async () => {
    const uid = await freshUser('res-explicit');
    await userGateway.addProviderEntry(uid, {
      provider: 'deepseek',
      key: 'sk-explicit',
      baseUrl: 'https://proxy.example.com/v1',
    });
    const up = await svc._resolveUpstream(uid);
    expect(up.baseUrl).toBe('https://proxy.example.com/v1');
    expect(up.apiKey).toBe('sk-explicit');
  });

  test('unknown provider with only a key (no preset, no baseUrl) is skipped → null', async () => {
    const uid = await freshUser('res-unknown');
    await userGateway.addProviderEntry(uid, { provider: 'mystery', key: 'sk-mystery' });
    expect(await svc._resolveUpstream(uid)).toBeNull();
  });

  test('generate() without an injected chatFn and no upstream → actionable 409', async () => {
    const uid = await freshUser('res-gate');
    // No relay, no provider, no _chatFn → must surface the configure-first error,
    // not a vague crash, and must never call the network.
    await expect(svc.generate(uid, { prompt: 'do something' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

async function countWorkflows() {
  const { UserWorkflow } = require('@khy/shared/models');
  return UserWorkflow.count({ where: { userId: testUserId } });
}
