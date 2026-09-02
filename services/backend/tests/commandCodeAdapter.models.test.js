'use strict';

/**
 * commandCodeAdapter.models.test.js — verifies the model-list surface that
 * the new `khy provider` command (sprint 17) relies on. No real CLI is
 * spawned; we redirect the adapter's commandCodeHome by writing
 * config.json / providers.json into a temp dir, then point
 * process.env.COMMAND_CODE_HOME at it.
 *
 * Why: the khy provider UI enumerates adapter models via
 * gateway.listModels('commandcode'), which dispatches to
 * commandCodeAdapter._listModels(). If that returns the user's
 * ~/.commandcode/config.json default + all BYOK provider/model pairs, the
 * "use cmdc <model>" path works end-to-end.
 *
 * Coverage:
 *  1. _listModels returns [] when ~/.commandcode/config.json is missing
 *  2. _listModels surfaces the user's pinned defaultModel from config.json
 *  3. _listModels surfaces BYOK entries from providers.json
 *  4. _listModels dedupes when a model id appears in both sources
 *  5. getStatus() reports the adapter name + the KHY_COMMANDCODE gate correctly
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempCmdcHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-cmdc-adapter-'));
  const prevHome = process.env.COMMAND_CODE_HOME;
  const prevGate = process.env.KHY_COMMANDCODE;
  process.env.COMMAND_CODE_HOME = dir;
  process.env.KHY_COMMANDCODE = '1';
  // bust require cache so the adapter re-evaluates commandCodeHome at call time
  delete require.cache[require.resolve('../src/services/gateway/adapters/commandCodeAdapter')];
  const adapter = require('../src/services/gateway/adapters/commandCodeAdapter');
  const restore = () => {
    if (prevHome === undefined) delete process.env.COMMAND_CODE_HOME;
    else process.env.COMMAND_CODE_HOME = prevHome;
    if (prevGate === undefined) delete process.env.KHY_COMMANDCODE;
    else process.env.KHY_COMMANDCODE = prevGate;
    delete require.cache[require.resolve('../src/services/gateway/adapters/commandCodeAdapter')];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  try {
    const ret = fn(adapter, dir);
    if (ret && typeof ret.then === 'function') {
      return ret.finally(restore);
    }
    restore();
    return ret;
  } catch (e) {
    restore();
    throw e;
  }
}

test('listModels returns [] when config.json is missing', async () => {
  await withTempCmdcHome(async (adapter) => {
    const models = await adapter.listModels();
    assert.deepEqual(models, []);
  });
});

test('listModels surfaces defaultModel from config.json', async () => {
  await withTempCmdcHome(async (adapter, dir) => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ model: 'minimax/minimax-m3-free', provider: 'command-code' }, null, 2)
    );
    const models = await adapter.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'minimax/minimax-m3-free');
    assert.equal(models[0].isDefault, true);
    assert.equal(models[0].provider, 'commandcode');
  });
});

test('listModels surfaces BYOK provider/model pairs from providers.json', async () => {
  await withTempCmdcHome(async (adapter, dir) => {
    fs.writeFileSync(
      path.join(dir, 'providers.json'),
      JSON.stringify({
        provider: {
          'my-deepseek': {
            name: 'My DeepSeek',
            models: { 'deepseek-chat': { id: 'deepseek-chat' } },
          },
        },
      }, null, 2)
    );
    const models = await adapter.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'my-deepseek/deepseek-chat');
    assert.equal(models[0].name, 'My DeepSeek / deepseek-chat');
  });
});

test('listModels merges default + BYOK with dedup', async () => {
  await withTempCmdcHome(async (adapter, dir) => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ model: 'minimax/minimax-m3-free' }, null, 2)
    );
    fs.writeFileSync(
      path.join(dir, 'providers.json'),
      JSON.stringify({
        provider: {
          'my-x': { name: 'MyX', models: { 'foo': { id: 'foo' } } },
        },
      }, null, 2)
    );
    const models = await adapter.listModels();
    const ids = models.map((m) => m.id).sort();
    assert.deepEqual(ids, ['minimax/minimax-m3-free', 'my-x/foo']);
  });
});

test('getStatus returns adapter name and availability flag', () => {
  withTempCmdcHome((adapter) => {
    const status = adapter.getStatus();
    assert.equal(status.name, 'CommandCode');
    assert.equal(status.type, 'commandcode');
    assert.equal(typeof status.available, 'boolean');
  });
});
