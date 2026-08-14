'use strict';

/**
 * ocSkillBridge — pins the pure leaf that maps OpenClaw's on-disk skill root so
 * khy can reuse OpenClaw's skills. Zero-IO: homedir + env are injected, so the
 * suite is deterministic (POSIX path assertions). Covers: gate default-ON +
 * falsy set, state-home override wiring, homedir optionality, and fail-soft on
 * junk input (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require('../src/skills/ocSkillBridge');

test('isOcSkillBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(bridge.isOcSkillBridgeEnabled({}), true);
  assert.strictEqual(bridge.isOcSkillBridgeEnabled({ KHY_OPENCLAW_SKILL_BRIDGE: undefined }), true);
  assert.strictEqual(bridge.isOcSkillBridgeEnabled({ KHY_OPENCLAW_SKILL_BRIDGE: 'true' }), true);
  assert.strictEqual(bridge.isOcSkillBridgeEnabled({ KHY_OPENCLAW_SKILL_BRIDGE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bridge.isOcSkillBridgeEnabled({ KHY_OPENCLAW_SKILL_BRIDGE: v }), false, `expected off for ${v}`);
  }
});

test('ocSkillSearchPaths: default home → <home>/.openclaw/skills, oc-* source', () => {
  const paths = bridge.ocSkillSearchPaths({ homedir: '/home/u', env: {} });
  assert.deepStrictEqual(paths, [
    { dir: path.join('/home/u', '.openclaw', 'skills'), source: 'oc-user' },
  ]);
  assert.ok(paths.every((p) => p.source.startsWith('oc-')));
});

test('ocSkillSearchPaths: KHY_OPENCLAW_DATA_HOME overrides the root', () => {
  const paths = bridge.ocSkillSearchPaths({ homedir: '/home/u', env: { KHY_OPENCLAW_DATA_HOME: '/custom/oc' } });
  assert.deepStrictEqual(paths, [
    { dir: path.join('/custom/oc', 'skills'), source: 'oc-user' },
  ]);
});

test('ocSkillSearchPaths: OPENCLAW_STATE_DIR overrides the root', () => {
  const paths = bridge.ocSkillSearchPaths({ homedir: '/home/u', env: { OPENCLAW_STATE_DIR: '/oc/state' } });
  assert.deepStrictEqual(paths, [
    { dir: path.join('/oc/state', 'skills'), source: 'oc-user' },
  ]);
});

test('ocSkillSearchPaths: no home & no override → empty', () => {
  assert.deepStrictEqual(bridge.ocSkillSearchPaths({ env: {} }), []);
  assert.deepStrictEqual(bridge.ocSkillSearchPaths({}), []);
});

test('ocSkillSearchPaths: never throws on junk input', () => {
  assert.doesNotThrow(() => bridge.ocSkillSearchPaths({ homedir: {}, env: [] }));
  assert.ok(Array.isArray(bridge.ocSkillSearchPaths({ homedir: 123, env: null })));
});
