'use strict';
/**
 * prompts.keyConfigExecute.test.js — the core profile now teaches BOTH the
 * "point to the steps" answer AND the in-chat execute path: gather fields →
 * restate with the key REDACTED → call the configureModelProvider tool. The
 * RULE still forbids hand-editing .env / writing code / calling Config, with the
 * single sanctioned exception being the configureModelProvider tool.
 */
const prompts = require('../../src/constants/prompts');
function section(mode) {
  return prompts.getKhySpecificSection({ mode });
}
describe('core profile carries the in-chat execute path', () => {
  for (const mode of ['auto', 'chat', 'coding', 'quant']) {
  }
});

describe('Prompts key Config Execute', () => {
  test('mode=${mode} names the configureModelProvider tool + redaction', () => {
          const s = section(mode);
          expect(s).toMatch(/configureModelProvider/);
          expect(s).toMatch(/脱敏/);
          // The text-only guidance is still present.
          expect(s).toMatch(/khy gateway config/);
          expect(s).toMatch(/\/apikey/);
  });

  test('guidance is not duplicated (single khy gateway config mention)', () => {
        const s = section('quant');
        expect((s.match(/khy gateway config/g) || []).length).toBe(1);
  });

  test('RULE still forbids .env/code/Config but permits the sanctioned tool', () => {
        const s = section('auto');
        expect(s).toMatch(/RULE:/);
        expect(s).toMatch(/configureModelProvider/);
        expect(s).toMatch(/\.env/);
        expect(s).toMatch(/Config/);
  });

});
