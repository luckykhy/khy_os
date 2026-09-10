'use strict';
/**
 * prompts.keyConfigGuidance.test.js �?「答不对：问配置模型密钥却去�?language」修复�?
 *
 * Real session: user asked「我想配置模型密钥，怎么做�? A casual ask routes to the
 * auto/chat profile, which previously carried NO guidance on how API keys are
 * actually configured �?that guidance lived only in the quant profile. The model
 * had no idea the real flow is `khy gateway config` / `/apikey`, so it grabbed the
 * `Config` tool and did a no-op `get language`.
 *
 * Fix: the key-config guidance now lives in the shared core profile, so EVERY
 * mode (auto / chat / coding / quant) tells the model the real steps. These tests
 * pin that the guidance is present across modes and was de-duplicated out of quant.
 */
const prompts = require('../../src/constants/prompts');
function section(mode) {
  return prompts.getKhySpecificSection({ mode });
}
describe('key-config guidance lives in the shared core profile', () => {
  for (const mode of ['auto', 'chat', 'coding', 'quant']) {
  }
});

describe('Prompts key Config Guidance', () => {
  test('mode=${mode} names the real gateway key-config flow', () => {
          const s = section(mode);
          expect(s).toMatch(/khy gateway config/);
          expect(s).toMatch(/\/apikey/);
          // Steers the model away from the Config-tool mis-grab.
          expect(s).toMatch(/模型密钥|API key/i);
  });

  test('an undefined mode (default �?chat/auto) still carries the guidance', () => {
        const s = prompts.getKhySpecificSection({});
        expect(s).toMatch(/khy gateway config/);
  });

  test('the guidance is not duplicated (single source in core, not also quant block)', () => {
        const s = section('quant');
        // The old standalone "## API key / gateway configuration" heading is gone;
        // the single Chinese core block is the only key-config guidance now.
        const occurrences = (s.match(/khy gateway config/g) || []).length;
        expect(occurrences).toBe(1);
        expect(s).not.toMatch(/## API key \/ gateway configuration/);
  });

});

