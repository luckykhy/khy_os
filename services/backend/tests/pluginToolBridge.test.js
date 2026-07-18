'use strict';

/**
 * pluginToolBridge.test.js — the per-user projection + dispatch layer that makes
 * a user's installed Coze-compatible plugins callable from the workflow toolCall
 * node and the chat Agent. Asserts:
 *   1. isPluginTool — only `plugin__<slug>__<op>` names route to the bridge.
 *   2. listUserPluginTools — projects ENABLED installs' operations into tool
 *      descriptors; disabled installs and other users' installs are excluded.
 *   3. executePluginTool — parses the RAW name (hyphens in the slug survive),
 *      resolves the plugin for traceContext.userId, and invokes with that user's
 *      auth; a missing userId / not-installed / disabled plugin fails cleanly.
 *
 * Uses an in-memory sqlite DB via @khy/shared/models. The HTTP-level invoker is
 * exercised separately (pluginInvoker.test.js); here we install a real plugin
 * row and drive the bridge end-to-end against a tiny local catalog.
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = path.join(require('node:os').tmpdir(), `khy_bridge_test_${process.pid}.sqlite`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bridge-test-secret-key-at-least-32-chars-xx';

const models = require('@khy/shared/models');
const bridge = require('../src/services/plugins/pluginToolBridge');

const OPENAPI = {
  openapi: '3.0.0',
  info: { title: 'Hyphen Co', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/now': {
      get: {
        operationId: 'getNow',
        parameters: [{ name: 'city', in: 'query', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

// Slug with a hyphen — guards against the normalizeToolName() corruption that
// would rewrite `my-weather` to `my_weather`.
const SLUG = 'my-weather';

let plugin;

before(async () => {
  await models.sequelize.sync();
  plugin = await models.MarketplacePlugin.create({
    slug: SLUG, name: 'My Weather', description: 'w', category: 'general',
    official: true, version: '1.0.0',
    manifestJson: { name_for_model: 'weather', auth: { type: 'none' } },
    openapiJson: OPENAPI,
  });
  // user 1: enabled. user 2: disabled. user 3: nothing.
  await models.UserInstalledPlugin.create({ userId: 1, pluginId: plugin.id, enabled: true, authConfigJson: { type: 'none' } });
  await models.UserInstalledPlugin.create({ userId: 2, pluginId: plugin.id, enabled: false, authConfigJson: { type: 'none' } });
});

test('isPluginTool gates on the plugin__ prefix', () => {
  assert.strictEqual(bridge.isPluginTool(`plugin__${SLUG}__getNow`), true);
  assert.strictEqual(bridge.isPluginTool('Bash'), false);
  assert.strictEqual(bridge.isPluginTool('plugin__'), false);
});

test('listUserPluginTools projects an enabled install with the hyphenated slug intact', async () => {
  const tools = await bridge.listUserPluginTools(1);
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, `plugin__${SLUG}__getNow`);
  assert.strictEqual(tools[0].slug, SLUG);
  assert.ok(tools[0].input_schema.properties.city, 'param schema is projected');
});

test('disabled install and unknown user expose no tools', async () => {
  assert.strictEqual((await bridge.listUserPluginTools(2)).length, 0, 'disabled hidden');
  assert.strictEqual((await bridge.listUserPluginTools(3)).length, 0, 'no install');
  assert.strictEqual((await bridge.listUserPluginTools(null)).length, 0, 'no user');
});

test('executePluginTool requires a userId in traceContext', async () => {
  const r = await bridge.executePluginTool(`plugin__${SLUG}__getNow`, { city: 'x' }, {});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /user context/i);
});

test('executePluginTool refuses a plugin not installed for the user', async () => {
  const r = await bridge.executePluginTool(`plugin__${SLUG}__getNow`, { city: 'x' }, { userId: 3 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not installed|not enabled/i);
});

test('executePluginTool refuses a disabled plugin', async () => {
  const r = await bridge.executePluginTool(`plugin__${SLUG}__getNow`, { city: 'x' }, { userId: 2 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not installed|not enabled/i);
});

test('executePluginTool resolves + invokes for the owning user', async () => {
  // Monkey-patch the invoker module the bridge uses, so we assert resolution
  // wiring (right openapi/operation/auth) without real HTTP.
  const invoker = require('../src/services/plugins/pluginInvoker');
  const orig = invoker.invoke;
  let seen = null;
  invoker.invoke = async (opts) => { seen = opts; return { ok: true, status: 200, contentType: 'application/json', data: { city: opts.args.city } }; };
  try {
    const r = await bridge.executePluginTool(`plugin__${SLUG}__getNow`, { city: 'beijing' }, { userId: 1 });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, { city: 'beijing' });
    assert.strictEqual(seen.operationId, 'getNow');
    assert.deepStrictEqual(seen.authConfig, { type: 'none' });
    assert.ok(seen.openapi && seen.openapi.paths['/now'], 'the plugin openapi was passed through');
  } finally {
    invoker.invoke = orig;
  }
});
