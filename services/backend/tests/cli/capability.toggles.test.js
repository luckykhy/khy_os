'use strict';

/**
 * Capability toggle subcommands tests (node:test).
 *
 * Exercises the CLI parity path `khy capability toggles | on | off | set`,
 * which performs the change itself via config._writeEnvPatch instead of telling
 * the user to edit a file. The persister is stubbed on the cached config module
 * so no real .env is touched, and printers are captured to assert output.
 *
 * Printers are wrapped BEFORE the handler is required, because the handler
 * destructures them at load time — a later property swap would be missed.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const configModule = require('../../src/cli/handlers/config');
const formatters = require('../../src/cli/formatters');

// Install capturing wrappers before requiring the handler.
let logs = [];
const origPrinters = {};
for (const name of ['printInfo', 'printError', 'printTable', 'printSuccess', 'printWarn']) {
  origPrinters[name] = formatters[name];
  formatters[name] = (...a) => { logs.push({ name, a }); };
}

const { handleCapability } = require('../../src/cli/handlers/capability');

let writes;
const origWrite = configModule._writeEnvPatch;

beforeEach(() => {
  writes = [];
  logs = [];
  configModule._writeEnvPatch = (envMap, unsetKeys) => {
    writes.push({ envMap, unsetKeys });
    return '/tmp/test/.env';
  };
});

afterEach(() => {
  configModule._writeEnvPatch = origWrite;
});

test.after(() => {
  for (const name of Object.keys(origPrinters)) formatters[name] = origPrinters[name];
});

function joined() {
  return logs.map((l) => JSON.stringify(l.a)).join(' | ');
}

test('off by friendly name → persists KHY_CHANGE_WATCH=off', () => {
  handleCapability({ subCommand: 'off', args: ['改动监视'] });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].envMap, { KHY_CHANGE_WATCH: 'off' });
  assert.match(joined(), /已关闭/);
});

test('on by id → persists KHY_RTK_MODE=true', () => {
  handleCapability({ subCommand: 'on', args: ['rtk'] });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].envMap, { KHY_RTK_MODE: 'true' });
});

test('raw KHY_* key toggles even when not in registry', () => {
  handleCapability({ subCommand: 'on', args: ['KHY_EXPERIMENTAL_X'] });
  assert.deepEqual(writes[0].envMap, { KHY_EXPERIMENTAL_X: 'true' });
});

test('set with raw value passes exact value through', () => {
  handleCapability({ subCommand: 'set', args: ['KHY_SOME_LIMIT', '42'] });
  assert.deepEqual(writes[0].envMap, { KHY_SOME_LIMIT: '42' });
});

test('unknown capability → no write, never "edit a file"', () => {
  handleCapability({ subCommand: 'on', args: ['不存在的能力xyz'] });
  assert.equal(writes.length, 0);
  assert.match(joined(), /未识别/);
  assert.doesNotMatch(joined(), /去文件里改|手动修改|编辑文件/);
});

test('toggles → lists registry, writes nothing', () => {
  handleCapability({ subCommand: 'toggles', args: [] });
  assert.equal(writes.length, 0);
  assert.match(joined(), /KHY_CHANGE_WATCH/);
});
