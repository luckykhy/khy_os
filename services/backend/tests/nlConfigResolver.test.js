'use strict';

/**
 * nlConfigResolver — pure-leaf NL→config intent tests (node:test).
 *
 * Deterministic, no IO. Verifies: gate default-on/off, NL→toggle intent for
 * friendly aliases (zh/en), raw KHY_ key + assignment, zero false positives
 * (needs BOTH an action word AND a capability reference, ignores code spans),
 * env-patch building, the authority directive content, and the route entry.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/services/config/nlConfigResolver');

test('isEnabled: default on; {0,false,off,no} disable', () => {
  assert.equal(r.isEnabled({}), true);
  assert.equal(r.isEnabled({ KHY_NL_CONFIG: 'off' }), false);
  assert.equal(r.isEnabled({ KHY_NL_CONFIG: '0' }), false);
  assert.equal(r.isEnabled({ KHY_NL_CONFIG: '1' }), true);
});

test('resolveConfigIntent: zh "关闭改动监视" → toggle off KHY_CHANGE_WATCH', () => {
  const it = r.resolveConfigIntent('帮我关闭改动监视');
  assert.ok(it);
  assert.equal(it.kind, 'toggle');
  assert.equal(it.envKey, 'KHY_CHANGE_WATCH');
  assert.equal(it.action, 'off');
  assert.equal(it.value, 'off');
});

test('resolveConfigIntent: zh "打开省 token 模式" → toggle on KHY_RTK_MODE', () => {
  const it = r.resolveConfigIntent('打开省 token 模式');
  assert.ok(it);
  assert.equal(it.envKey, 'KHY_RTK_MODE');
  assert.equal(it.action, 'on');
  assert.equal(it.value, 'true');
});

test('resolveConfigIntent: en "enable ground truth" → on KHY_GROUND_TRUTH', () => {
  const it = r.resolveConfigIntent('please enable ground truth for me');
  assert.ok(it);
  assert.equal(it.envKey, 'KHY_GROUND_TRUTH');
  assert.equal(it.action, 'on');
});

test('resolveConfigIntent: raw assignment KHY_FOO=bar → raw intent', () => {
  const it = r.resolveConfigIntent('把 KHY_SOME_FLAG=bar');
  assert.ok(it);
  assert.equal(it.kind, 'raw');
  assert.equal(it.envKey, 'KHY_SOME_FLAG');
  assert.equal(it.value, 'bar');
});

test('resolveConfigIntent: known envKey assignment maps to its capability', () => {
  const it = r.resolveConfigIntent('把 KHY_CHANGE_WATCH 设为 off');
  assert.ok(it);
  assert.equal(it.kind, 'toggle');
  assert.equal(it.capabilityId, 'change-watch');
  assert.equal(it.action, 'off');
});

test('resolveConfigIntent: action word + bare KHY_ key (unknown) → toggle on that key', () => {
  const it = r.resolveConfigIntent('开启 KHY_EXPERIMENTAL_X');
  assert.ok(it);
  assert.equal(it.kind, 'toggle');
  assert.equal(it.envKey, 'KHY_EXPERIMENTAL_X');
  assert.equal(it.action, 'on');
  assert.equal(it.capabilityId, null);
});

test('zero false positive: action word but no capability → null', () => {
  assert.equal(r.resolveConfigIntent('帮我打开这个文件'), null);
  assert.equal(r.resolveConfigIntent('把灯关掉'), null);
});

test('zero false positive: capability named but no action word → null', () => {
  assert.equal(r.resolveConfigIntent('改动监视是什么意思'), null);
  assert.equal(r.resolveConfigIntent('ground truth 这个功能怎么样'), null);
});

test('zero false positive: KHY_ key only inside a code span is ignored', () => {
  assert.equal(r.resolveConfigIntent('看看 `KHY_CHANGE_WATCH=off` 这行代码对不对'), null);
  assert.equal(r.resolveConfigIntent('关闭这段 ```\nKHY_GROUND_TRUTH\n``` 注释'), null);
});

test('gate off → resolveConfigIntent null', () => {
  assert.equal(r.resolveConfigIntent('关闭改动监视', { KHY_NL_CONFIG: 'off' }), null);
});

test('buildEnvPatch: toggle off → {envKey: "off"}', () => {
  const patch = r.buildEnvPatch({ envKey: 'KHY_CHANGE_WATCH', action: 'off', value: 'off' });
  assert.deepEqual(patch, { envMap: { KHY_CHANGE_WATCH: 'off' }, unsetKeys: [] });
});

test('buildEnvPatch: missing envKey → empty patch (fail-soft)', () => {
  assert.deepEqual(r.buildEnvPatch(null), { envMap: {}, unsetKeys: [] });
});

test('describeCapabilities: returns the registry as a list of {id,envKey,summary,aliases}', () => {
  const list = r.describeCapabilities();
  assert.ok(Array.isArray(list) && list.length >= 5);
  const cw = list.find((c) => c.id === 'change-watch');
  assert.equal(cw.envKey, 'KHY_CHANGE_WATCH');
  assert.ok(Array.isArray(cw.aliases) && cw.aliases.length > 0);
});

test('findCapability: by id, by envKey, by alias', () => {
  assert.equal(r.findCapability('change-watch').envKey, 'KHY_CHANGE_WATCH');
  assert.equal(r.findCapability('KHY_RTK_MODE').id, 'rtk');
  assert.equal(r.findCapability('地面真值').id, 'ground-truth');
  assert.equal(r.findCapability('不存在的能力xyz'), null);
});

test('buildConfigDirective: always carries the user-authority principle', () => {
  const d = r.buildConfigDirective(null);
  assert.match(d, /用户是最高权限/);
  assert.match(d, /绝不把开关甩回给用户/);
  assert.match(d, /Configure/);
});

test('buildConfigDirective: with toggle intent names the capability + action', () => {
  const it = r.resolveConfigIntent('关闭改动监视');
  const d = r.buildConfigDirective(it);
  assert.match(d, /关闭能力/);
  assert.match(d, /KHY_CHANGE_WATCH/);
  assert.match(d, /state=off/);
});

test('routeConfigIntent: returns directive even with no concrete intent (principle still injected)', () => {
  const res = r.routeConfigIntent({ text: '今天天气怎么样' });
  assert.ok(res && res.directive);
  assert.equal(res.intent, null);
  assert.match(res.directive, /用户是最高权限/);
});

test('routeConfigIntent: gate off → null', () => {
  assert.equal(r.routeConfigIntent({ text: '关闭改动监视', env: { KHY_NL_CONFIG: 'off' } }), null);
});

// ── GLM 识图能力(KHY_GLM_VISION_MODEL)——NL 开关(布尔行) + 改模型走原生 raw 形 ──
test('resolveConfigIntent: zh "关闭 GLM 识图" → toggle off KHY_GLM_VISION_MODEL', () => {
  const it = r.resolveConfigIntent('帮我关闭 glm识图');
  assert.ok(it);
  assert.equal(it.kind, 'toggle');
  assert.equal(it.capabilityId, 'glm-vision-model');
  assert.equal(it.envKey, 'KHY_GLM_VISION_MODEL');
  assert.equal(it.action, 'off');
});

test('resolveConfigIntent: en "enable glm vision" → on KHY_GLM_VISION_MODEL', () => {
  const it = r.resolveConfigIntent('please enable glm vision');
  assert.ok(it);
  assert.equal(it.envKey, 'KHY_GLM_VISION_MODEL');
  assert.equal(it.action, 'on');
});

test('resolveConfigIntent: 改识图模型走原生 raw 形「把 KHY_VISION_FALLBACK_MODEL 设为 X」', () => {
  const it = r.resolveConfigIntent('把 KHY_VISION_FALLBACK_MODEL 设为 glm/glm-4.6v-flash');
  assert.ok(it);
  // 未在 CAPABILITIES 注册 → raw 意图,原样落 env(Part 2c 会尊重该 env-pin)。
  assert.equal(it.kind, 'raw');
  assert.equal(it.envKey, 'KHY_VISION_FALLBACK_MODEL');
  assert.equal(it.value, 'glm/glm-4.6v-flash');
});

test('findCapability: GLM vision by alias / envKey / id', () => {
  assert.equal(r.findCapability('KHY_GLM_VISION_MODEL').id, 'glm-vision-model');
  assert.equal(r.findCapability('glm-4.6v-flash').id, 'glm-vision-model');
});
