'use strict';

/**
 * sensitiveHomeCaseFold.test.js — 纯叶子契约 + inputValidators._isSensitiveHomeWrite 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、foldSensitiveRel(门开→小写·关/非串→null)、
 * fail-soft;接线活验:门开封堵 `.SSH/`/`.BASHRC`/`launchagents/` 大小写变体绕过、legacy 精确
 * 大小写命中不回归、门关逐字节回退(变体重新绕过)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const leaf = require(path.join(__dirname, '../src/services/sensitiveHomeCaseFold'));

test('sensitiveHomeCaseFoldEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.sensitiveHomeCaseFoldEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.sensitiveHomeCaseFoldEnabled({ KHY_SENSITIVE_HOME_CASEFOLD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.sensitiveHomeCaseFoldEnabled({ KHY_SENSITIVE_HOME_CASEFOLD: 'yes' }), true);
});

test('foldSensitiveRel: ON → lowercased; OFF/non-string → null', () => {
  assert.strictEqual(leaf.foldSensitiveRel('.SSH/authorized_keys', {}), '.ssh/authorized_keys');
  assert.strictEqual(leaf.foldSensitiveRel('.BASHRC', {}), '.bashrc');
  assert.strictEqual(leaf.foldSensitiveRel('Library/LaunchAgents/x', {}), 'library/launchagents/x');
  assert.strictEqual(leaf.foldSensitiveRel('.ssh/config', { KHY_SENSITIVE_HOME_CASEFOLD: '0' }), null);
  assert.strictEqual(leaf.foldSensitiveRel(null, {}), null);
  assert.strictEqual(leaf.foldSensitiveRel(123, {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.foldSensitiveRel('.ssh/x', undefined));
  assert.doesNotThrow(() => leaf.sensitiveHomeCaseFoldEnabled(null));
});

// ── inputValidators._isSensitiveHomeWrite 接线(真跑;用 home 相对路径构造绝对路径)────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshValidators() {
  delete require.cache[require.resolve('../src/tools/inputValidators')];
  delete require.cache[require.resolve('../src/services/sensitiveHomeCaseFold')];
  return require('../src/tools/inputValidators');
}

const HOME = os.homedir();
const underHome = (rel) => path.join(HOME, ...rel.split('/'));

test('wiring ON: case variants of sensitive paths are blocked (strict superset)', () => {
  withEnv({ KHY_SENSITIVE_HOME_CASEFOLD: undefined, KHY_ALLOW_SENSITIVE_HOME_WRITE: undefined }, () => {
    const v = freshValidators();
    // legacy exact-case still blocked (baseline, not regressed)
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.ssh/authorized_keys')), true);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.bashrc')), true);
    // case variants now blocked via casefold superset
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.SSH/authorized_keys')), true);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.Ssh/authorized_keys')), true);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.BASHRC')), true);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('Library/launchagents/evil.plist')), true);
    // ordinary writes remain allowed
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('Desktop/notes.txt')), false);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('project/src/index.js')), false);
  });
});

test('wiring OFF: byte-revert → case variants bypass again, exact-case still blocked', () => {
  withEnv({ KHY_SENSITIVE_HOME_CASEFOLD: '0', KHY_ALLOW_SENSITIVE_HOME_WRITE: undefined }, () => {
    const v = freshValidators();
    // exact-case legacy match untouched
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.ssh/authorized_keys')), true);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.bashrc')), true);
    // the pre-existing bypass returns (proves gate is a pure superset, off = legacy)
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.SSH/authorized_keys')), false);
    assert.strictEqual(v.isSensitiveHomeWrite(underHome('.BASHRC')), false);
  });
});
