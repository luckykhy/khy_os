'use strict';
/**
 * configTool.keyConfigRedirect.test.js �?stop the Config tool from being mis-grabbed
 * for「配置模型密钥�?
 *
 * The Config tool's searchHint literally contained the word `model` and its
 * description headline was "configuration settings", so a weak model picked it for
 * "配置模型密钥" and did a no-op `get language`. Fix: drop `model` from the searchHint
 * and append a disclaimer that this tool does NOT configure API keys �?point to
 * `khy gateway config`. The behavioral get/set contract is unchanged.
 */
const ConfigTool = require('../../src/tools/ConfigTool');
describe('ConfigTool no longer advertises itself for model-key config', () => {
  test('searchHint does not contain the misleading word "model"', () => {
    expect(typeof ConfigTool.searchHint === 'string').toBeTruthy();
    expect(ConfigTool.searchHint).not.toMatch(/\bmodel\b/i);
  });
});

describe('Config Tool key Config Redirect', () => {
  test('prompt() disclaims API-key/gateway config and points to khy gateway config', async () => {
        const tool = new ConfigTool();
        const p = tool.prompt();
        expect(p).toMatch(/does NOT configure model API keys/i);
        expect(p).toMatch(/khy gateway config/);
        expect(p).toMatch(/\/apikey/);
  });

  test('get behavior is preserved (a plain language read still works)', async () => {
        const tool = new ConfigTool();
        const res = await tool.execute({ setting: 'language' });
        expect(res.success).toBe(true);
        expect(res.operation).toBe('get');
        expect(res.setting).toBe('language');
        expect('value' in res).toBeTruthy();
  });

  test('unknown setting still errors clearly', async () => {
        const tool = new ConfigTool();
        const res = await tool.execute({ setting: 'apiKey' });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/Unknown setting/);
  });

});

