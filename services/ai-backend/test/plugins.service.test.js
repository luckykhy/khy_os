'use strict';

/**
 * plugins.service.test.js — the multi-tenant plugin marketplace service layer.
 *
 * Covers the three services behind /api/marketplace and /api/plugins:
 *   - pluginImportService: OpenAPI / Coze-manifest / URL normalization, auth
 *     descriptor mapping, duplicate-slug 409, and SSRF rejection of a spec URL
 *     that resolves to a private address.
 *   - marketplaceService: list/search/categories/detail, install (idempotent
 *     re-enable + auth update), uninstall, and the 404/401 guards.
 *   - pluginService: per-user install views with auth ALWAYS masked (no secret
 *     ever leaves the service), enable/auth mutation, one-shot test invoke (with
 *     the runtime invoker stubbed), and cross-user (越权) rejection — a user can
 *     never touch another user's install.
 *
 * A throwaway SQLite DB is bound before any @khy/shared model loads. axios is
 * mocked so URL imports never hit the network; the backend SSRF guard's DNS
 * lookup is stubbed so the guard runs offline.
 */

const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `khy-plugins-svc-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'plugins-service-test-secret-at-least-32-chars';
process.env.NODE_ENV = 'test';

jest.mock('axios', () => jest.fn());
const axios = require('axios');

const { sequelize, User, MarketplacePlugin, UserInstalledPlugin } = require('@khy/shared/models');
const importSvc = require('../src/services/pluginImportService');
const marketplaceSvc = require('../src/services/marketplaceService');
const pluginSvc = require('../src/services/pluginService');
// The SSRF guard lives in the trading backend; import the very same module the
// services use so the DNS stub takes effect on their code path.
const urlSafety = require(path.resolve(__dirname, '../../backend/src/services/urlSafety'));

function openapiDoc(extra = {}) {
  return {
    openapi: '3.0.0',
    info: { title: 'Weather API', version: '2.1.0', description: 'forecasts' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/forecast': {
        get: {
          operationId: 'getForecast',
          summary: 'get forecast',
          parameters: [{ name: 'city', in: 'query', required: true, schema: { type: 'string' } }],
        },
      },
    },
    ...extra,
  };
}

let userA;
let userB;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = (await User.create({ username: 'plug-a', email: 'a@plug.local', password: 'pw-a-12345', status: 'active' })).id;
  userB = (await User.create({ username: 'plug-b', email: 'b@plug.local', password: 'pw-b-12345', status: 'active' })).id;
});

afterAll(async () => {
  await sequelize.close();
});

beforeEach(() => {
  axios.mockReset();
  // Default: every hostname resolves to a public IP so the guard passes.
  urlSafety.__setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  urlSafety.__setDnsLookupForTests(null);
});

// ── pluginImportService ──────────────────────────────────────────────────────

describe('pluginImportService.preview', () => {
  test('normalizes a raw OpenAPI doc into slug + operations + a none-auth manifest', async () => {
    const norm = await importSvc.preview({ openapi: openapiDoc() });
    expect(norm.slug).toBe('weather-api');
    expect(norm.name).toBe('Weather API');
    expect(norm.version).toBe('2.1.0');
    expect(norm.operations).toHaveLength(1);
    expect(norm.operations[0].operationId).toBe('getForecast');
    expect(norm.manifest.auth).toEqual({ type: 'none' });
  });

  test('maps a Coze manifest apiKey auth into khy auth descriptor', async () => {
    const norm = await importSvc.preview({
      openapi: openapiDoc(),
      manifest: {
        name_for_model: 'wx', name_for_human: 'WX',
        description_for_model: 'd', description_for_human: 'd',
        auth: { type: 'service_http', authorization_type: 'custom', in: 'header', name: 'X-Key' },
      },
    });
    expect(norm.manifest.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Key' });
    expect(norm.manifest.name_for_model).toBe('wx');
  });

  test('maps a Coze oauth manifest into an oauth descriptor with grant inference', async () => {
    const norm = await importSvc.preview({
      openapi: openapiDoc(),
      manifest: { auth: { type: 'oauth', authorization_url: 'https://id.example.com/auth', token_url: 'https://id.example.com/token', scope: 'read' } },
    });
    expect(norm.manifest.auth.type).toBe('oauth');
    expect(norm.manifest.auth.grant).toBe('authorization_code');
    expect(norm.manifest.auth.token_url).toBe('https://id.example.com/token');
  });

  test('fetches an OpenAPI doc from a URL (mocked) when the host is public', async () => {
    axios.mockResolvedValue({ status: 200, data: JSON.stringify(openapiDoc()) });
    const norm = await importSvc.preview({ openapiUrl: 'https://specs.example.com/openapi.json' });
    expect(axios).toHaveBeenCalledTimes(1);
    expect(norm.slug).toBe('weather-api');
  });

  test('SSRF: a spec URL resolving to a private address is blocked (no fetch)', async () => {
    urlSafety.__setDnsLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(importSvc.preview({ openapiUrl: 'https://metadata.evil.test/openapi.json' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(axios).not.toHaveBeenCalled();
  });

  test('rejects a non-OpenAPI-3 document', async () => {
    await expect(importSvc.preview({ openapi: { swagger: '2.0', paths: {} } }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('pluginImportService.importPlugin', () => {
  test('persists a catalog row and rejects a duplicate slug with 409', async () => {
    const row = await importSvc.importPlugin(userA, { openapi: openapiDoc(), slug: 'dup-spec' });
    expect(row.id).toBeTruthy();
    expect(row.slug).toBe('dup-spec');
    expect(row.official).toBe(false);
    await expect(importSvc.importPlugin(userA, { openapi: openapiDoc(), slug: 'dup-spec' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

// ── marketplaceService ───────────────────────────────────────────────────────

describe('marketplaceService', () => {
  let pluginId;

  beforeAll(async () => {
    const row = await MarketplacePlugin.create({
      slug: 'mkt-weather', name: 'Market Weather', description: 'sunny forecasts',
      category: 'utility', official: true, version: '1.0.0',
      manifestJson: { auth: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      openapiJson: openapiDoc(),
    });
    pluginId = row.id;
  });

  test('list + search + categories project the catalog', async () => {
    const all = await marketplaceSvc.list();
    expect(all.find((p) => p.slug === 'mkt-weather')).toBeTruthy();
    const hit = await marketplaceSvc.list({ search: 'sunny' });
    expect(hit.map((p) => p.slug)).toContain('mkt-weather');
    const miss = await marketplaceSvc.list({ search: 'no-such-term-xyz' });
    expect(miss.find((p) => p.slug === 'mkt-weather')).toBeFalsy();
    expect(await marketplaceSvc.categories()).toContain('utility');
  });

  test('detail reports operations + per-user install state', async () => {
    const before = await marketplaceSvc.detail(userA, pluginId);
    expect(before.installed).toBe(false);
    expect(before.operations[0].operationId).toBe('getForecast');
    expect(before.auth.type).toBe('apiKey');
  });

  test('install is idempotent: re-install re-enables and updates auth', async () => {
    const first = await marketplaceSvc.install(userA, pluginId, { authConfig: { type: 'apiKey', in: 'header', name: 'X-Key', value: 'k1' } });
    expect(first.installed).toBe(true);
    const installId = first.id;

    // disable, then re-install → re-enabled, same row, new auth.
    await pluginSvc.setEnabled(userA, installId, false);
    const second = await marketplaceSvc.install(userA, pluginId, { authConfig: { type: 'apiKey', in: 'header', name: 'X-Key', value: 'k2' } });
    expect(second.id).toBe(installId);
    expect(second.enabled).toBe(true);

    const row = await UserInstalledPlugin.findByPk(installId);
    expect(row.authConfigJson.value).toBe('k2');
  });

  test('detail reflects an install for the owning user only', async () => {
    const forA = await marketplaceSvc.detail(userA, pluginId);
    const forB = await marketplaceSvc.detail(userB, pluginId);
    expect(forA.installed).toBe(true);
    expect(forB.installed).toBe(false);
  });

  test('uninstall removes the link; a second uninstall is 404', async () => {
    await marketplaceSvc.install(userB, pluginId, {});
    expect((await marketplaceSvc.uninstall(userB, pluginId)).uninstalled).toBe(true);
    await expect(marketplaceSvc.uninstall(userB, pluginId)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('install guards: unknown plugin → 404, missing user → 401', async () => {
    await expect(marketplaceSvc.install(userA, 999999, {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(marketplaceSvc.install(null, pluginId, {})).rejects.toMatchObject({ statusCode: 401 });
  });
});

// ── pluginService (per-user management) ──────────────────────────────────────

describe('pluginService', () => {
  test('_maskAuth never returns secret material', () => {
    expect(pluginSvc._maskAuth({ type: 'apiKey', in: 'header', name: 'X', value: 'SECRET' }))
      .toEqual({ type: 'apiKey', in: 'header', name: 'X', configured: true });
    expect(pluginSvc._maskAuth({ type: 'bearer', token: 'SECRET' }))
      .toEqual({ type: 'bearer', configured: true });
    const oauth = pluginSvc._maskAuth({ type: 'oauth', grant: 'client_credentials', tokenUrl: 'https://t', clientId: 'id', clientSecret: 'SECRET' });
    expect(oauth.configured).toBe(true);
    expect(JSON.stringify(oauth)).not.toContain('SECRET');
  });

  test('importAndInstall publishes + auto-installs; listInstalled masks the auth', async () => {
    const view = await pluginSvc.importAndInstall(userA, {
      openapi: openapiDoc(), slug: 'svc-weather',
      authConfig: { type: 'apiKey', in: 'header', name: 'X-Key', value: 'TOPSECRET' },
    });
    expect(view.enabled).toBe(true);
    expect(view.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Key', configured: true });

    const list = await pluginSvc.listInstalled(userA);
    const found = list.find((p) => p.slug === 'svc-weather');
    expect(found).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain('TOPSECRET');
  });

  test('setEnabled / setAuth mutate an owned install', async () => {
    const view = await pluginSvc.importAndInstall(userA, { openapi: openapiDoc(), slug: 'svc-mutate' });
    const off = await pluginSvc.setEnabled(userA, view.id, false);
    expect(off.enabled).toBe(false);
    const authed = await pluginSvc.setAuth(userA, view.id, { type: 'bearer', token: 'TKN' });
    expect(authed.auth).toEqual({ type: 'bearer', configured: true });
    const row = await UserInstalledPlugin.findByPk(view.id);
    expect(row.authConfigJson.token).toBe('TKN'); // stored, but never surfaced
  });

  test('越权 (cross-user) access to another user\'s install is rejected with 404', async () => {
    const view = await pluginSvc.importAndInstall(userA, { openapi: openapiDoc(), slug: 'svc-private' });
    await expect(pluginSvc.setEnabled(userB, view.id, false)).rejects.toMatchObject({ statusCode: 404 });
    await expect(pluginSvc.setAuth(userB, view.id, { type: 'none' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(pluginSvc.remove(userB, view.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(pluginSvc.test(userB, view.id, { operationId: 'getForecast' })).rejects.toMatchObject({ statusCode: 404 });
    // owner still has it
    expect((await pluginSvc.listInstalled(userA)).find((p) => p.id === view.id)).toBeTruthy();
  });

  test('test() invokes the operation with the stored auth (runtime invoker stubbed)', async () => {
    const invoker = require(path.resolve(__dirname, '../../backend/src/services/plugins/pluginInvoker'));
    const orig = invoker.invoke;
    let seen = null;
    invoker.invoke = async (opts) => { seen = opts; return { ok: true, status: 200, contentType: 'application/json', data: { city: opts.args.city } }; };
    try {
      const view = await pluginSvc.importAndInstall(userA, {
        openapi: openapiDoc(), slug: 'svc-test',
        authConfig: { type: 'bearer', token: 'BTK' },
      });
      const res = await pluginSvc.test(userA, view.id, { operationId: 'getForecast', args: { city: 'paris' } });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ city: 'paris' });
      expect(seen.operationId).toBe('getForecast');
      expect(seen.authConfig).toEqual({ type: 'bearer', token: 'BTK' });
    } finally {
      invoker.invoke = orig;
    }
  });

  test('test() requires operationId', async () => {
    const view = await pluginSvc.importAndInstall(userA, { openapi: openapiDoc(), slug: 'svc-noop' });
    await expect(pluginSvc.test(userA, view.id, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});
