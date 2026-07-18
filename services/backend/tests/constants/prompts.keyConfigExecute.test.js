'use strict';

/**
 * prompts.keyConfigExecute.test.js — the core profile now teaches BOTH the
 * "point to the steps" answer AND the in-chat execute path: gather fields →
 * restate with the key REDACTED → call the configureModelProvider tool. The
 * RULE still forbids hand-editing .env / writing code / calling Config, with the
 * single sanctioned exception being the configureModelProvider tool.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../../src/constants/prompts');

function section(mode) {
  return prompts.getKhySpecificSection({ mode });
}

describe('core profile carries the in-chat execute path', () => {
  for (const mode of ['auto', 'chat', 'coding', 'quant']) {
    test(`mode=${mode} names the configureModelProvider tool + redaction`, () => {
      const s = section(mode);
      assert.match(s, /configureModelProvider/, 'must name the sanctioned tool');
      assert.match(s, /脱敏/, 'must instruct key redaction');
      // The text-only guidance is still present.
      assert.match(s, /khy gateway config/);
      assert.match(s, /\/apikey/);
    });
  }

  test('guidance is not duplicated (single khy gateway config mention)', () => {
    const s = section('quant');
    assert.equal((s.match(/khy gateway config/g) || []).length, 1);
  });

  test('RULE still forbids .env/code/Config but permits the sanctioned tool', () => {
    const s = section('auto');
    assert.match(s, /RULE:/);
    assert.match(s, /configureModelProvider/);
    assert.match(s, /\.env/);
    assert.match(s, /Config/);
  });
});
