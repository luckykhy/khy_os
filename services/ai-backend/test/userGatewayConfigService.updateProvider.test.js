/**
 * userGatewayConfigService.updateProviderEntry — edit a provider entry in place.
 *
 * Covers the richer-than-key-rotation edit path added for the interactive config
 * wizard:
 *   - metadata patch (displayName / baseUrl / apiFormat) updates the row;
 *   - an empty/omitted key keeps the current secret; a non-empty key rotates it;
 *   - a provider RENAME re-points the entry AND migrates the user's models to the
 *     new name, de-duplicating against any model the target already serves;
 *   - guard rails: 404 unknown id, 400 bad provider/apiFormat, 409 (provider,key)
 *     collision with another of the user's entries.
 *
 * All assertions are tenant-scoped (userA only) and use the decrypted key, which
 * is server-side only and never returned by mapProviderRow (keyMasked instead).
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-usergw-update-${process.pid}.db`);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-user-update';
process.env.NODE_ENV = 'test';

const { sequelize, User, UserProvider } = require('@khy/shared/models');
const svc = require('../src/services/userGatewayConfigService');

let userA;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  userA = await User.create({ username: 'upd-a', email: 'upd-a@test.local', password: 'pw-a-123456', status: 'active' });
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

// Fresh decrypted key for an entry id (mapProviderRow masks it, so read the row).
async function rawKey(id) {
  const row = await UserProvider.findOne({ where: { userId: userA.id, id } });
  return row ? row.key : null;
}

describe('updateProviderEntry — metadata + key rotation', () => {
  test('patches metadata while keeping the current key when key is empty', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'acme', key: 'sk-acme-1', baseUrl: 'https://api.acme.com/v1' });
    const out = await svc.updateProviderEntry(userA.id, entry.id, {
      displayName: 'Acme Cloud',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.acme.com/v2',
      key: '', // keep current
    });
    expect(out).toMatchObject({ provider: 'acme', displayName: 'Acme Cloud', apiFormat: 'anthropic', baseUrl: 'https://api.acme.com/v2' });
    expect(await rawKey(entry.id)).toBe('sk-acme-1'); // unchanged
  });

  test('rotates the key when a non-empty key is supplied', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'rotate', key: 'sk-old' });
    await svc.updateProviderEntry(userA.id, entry.id, { key: 'sk-new' });
    expect(await rawKey(entry.id)).toBe('sk-new');
  });

  test('404 for an unknown entry id', async () => {
    await expect(svc.updateProviderEntry(userA.id, 999999, { displayName: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('400 for an invalid apiFormat', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'fmt', key: 'sk-fmt' });
    await expect(svc.updateProviderEntry(userA.id, entry.id, { apiFormat: 'not-a-format' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('400 for an invalid provider rename target', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'renamebad', key: 'sk-rb' });
    await expect(svc.updateProviderEntry(userA.id, entry.id, { provider: 'A!!' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('409 when the resulting (provider, key) collides with a sibling', async () => {
    await svc.addProviderEntry(userA.id, { provider: 'dup', key: 'sk-keep' });
    const second = await svc.addProviderEntry(userA.id, { provider: 'dup', key: 'sk-other' });
    // Rotating second's key to the first's value collides within provider 'dup'.
    await expect(svc.updateProviderEntry(userA.id, second.id, { key: 'sk-keep' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('updateProviderEntry — provider rename migrates models', () => {
  test('renaming re-points the entry and migrates its models to the new name', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'oldname', key: 'sk-rn-1' });
    await svc.addModel(userA.id, { provider: 'oldname', model: 'm-1' });
    await svc.addModel(userA.id, { provider: 'oldname', model: 'm-2' });

    const out = await svc.updateProviderEntry(userA.id, entry.id, { provider: 'newname' });
    expect(out.provider).toBe('newname');

    const oldModels = await svc.listModels(userA.id, { provider: 'oldname' });
    const newModels = await svc.listModels(userA.id, { provider: 'newname' });
    expect(oldModels).toHaveLength(0);
    expect(newModels.map(m => m.model).sort()).toEqual(['m-1', 'm-2']);
  });

  test('rename de-duplicates models the target provider already serves', async () => {
    const entry = await svc.addProviderEntry(userA.id, { provider: 'src', key: 'sk-src' });
    await svc.addModel(userA.id, { provider: 'src', model: 'shared' });
    await svc.addModel(userA.id, { provider: 'src', model: 'unique' });
    // The target already has 'shared' — the migrated clash must be dropped, not error.
    await svc.addProviderEntry(userA.id, { provider: 'dst', key: 'sk-dst' });
    await svc.addModel(userA.id, { provider: 'dst', model: 'shared' });

    await svc.updateProviderEntry(userA.id, entry.id, { provider: 'dst' });
    const dstModels = await svc.listModels(userA.id, { provider: 'dst' });
    expect(dstModels.map(m => m.model).sort()).toEqual(['shared', 'unique']);
    expect(await svc.listModels(userA.id, { provider: 'src' })).toHaveLength(0);
  });
});
