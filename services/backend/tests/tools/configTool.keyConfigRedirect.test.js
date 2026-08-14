'use strict';

/**
 * configTool.keyConfigRedirect.test.js — stop the Config tool from being mis-grabbed
 * for「配置模型密钥」.
 *
 * The Config tool's searchHint literally contained the word `model` and its
 * description headline was "configuration settings", so a weak model picked it for
 * "配置模型密钥" and did a no-op `get language`. Fix: drop `model` from the searchHint
 * and append a disclaimer that this tool does NOT configure API keys → point to
 * `khy gateway config`. The behavioral get/set contract is unchanged.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ConfigTool = require('../../src/tools/ConfigTool');

describe('ConfigTool no longer advertises itself for model-key config', () => {
  test('searchHint does not contain the misleading word "model"', () => {
    assert.ok(typeof ConfigTool.searchHint === 'string');
    assert.doesNotMatch(ConfigTool.searchHint, /\bmodel\b/i);
  });

  test('prompt() disclaims API-key/gateway config and points to khy gateway config', () => {
    const tool = new ConfigTool();
    const p = tool.prompt();
    assert.match(p, /does NOT configure model API keys/i);
    assert.match(p, /khy gateway config/);
    assert.match(p, /\/apikey/);
  });

  test('get behavior is preserved (a plain language read still works)', async () => {
    const tool = new ConfigTool();
    const res = await tool.execute({ setting: 'language' });
    assert.equal(res.success, true);
    assert.equal(res.operation, 'get');
    assert.equal(res.setting, 'language');
    assert.ok('value' in res);
  });

  test('unknown setting still errors clearly', async () => {
    const tool = new ConfigTool();
    const res = await tool.execute({ setting: 'apiKey' });
    assert.equal(res.success, false);
    assert.match(res.error, /Unknown setting/);
  });
});
