'use strict';

/**
 * builtinGlmKey.test.js — 纯叶子契约 + apiKeyPool 并入接线:GLM 占位 key(pip 安装后开箱可用,
 * 可经 NL/Web 替换)。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、builtinGlmKeyEntries(开门返 glm 条目·
 * 关门返 {} 逐字节回退·priority 0·端点/label)、常量稳定;apiKeyPool 冷启动含占位 GLM key、
 * 真 key(priority 10)盖过占位(占位永不被选中)、门关不并入。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const leaf = require(path.join(__dirname, '../src/services/builtinGlmKey'));

// Isolate every apiKeyPool load to a throwaway data home so tests never read/write
// the developer's real ~/.khy/api_keys.json (which may hold real keys + the
// historically-persisted placeholder).
const _TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-glm-test-'));

test('builtinGlmKeyEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.builtinGlmKeyEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.builtinGlmKeyEnabled({ KHY_BUILTIN_GLM_KEY: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.builtinGlmKeyEnabled({ KHY_BUILTIN_GLM_KEY: 'disable' }), true); // 非 CANON → 开
});

test('builtinGlmKeyEntries: gate ON → glm placeholder at priority 0, marked placeholder', () => {
  const m = leaf.builtinGlmKeyEntries({});
  assert.ok(m.glm, 'glm entry present');
  assert.strictEqual(m.glm.key, leaf.GLM_PLACEHOLDER_KEY);
  assert.strictEqual(m.glm.endpoint, leaf.GLM_ENDPOINT);
  assert.strictEqual(m.glm.priority, 0); // 最低优先 → 真 key 恒盖过
  assert.strictEqual(m.glm.placeholder, true); // 占位:从可用性/选择路径排除
  assert.strictEqual(typeof m.glm.label, 'string');
});

test('builtinGlmKeyEntries: gate OFF → {} (byte-revert, not merged)', () => {
  assert.deepStrictEqual(leaf.builtinGlmKeyEntries({ KHY_BUILTIN_GLM_KEY: '0' }), {});
});

test('builtinGlmKeyEntries: returns fresh object (caller-mutation safe)', () => {
  const a = leaf.builtinGlmKeyEntries({});
  a.glm.priority = 99;
  const b = leaf.builtinGlmKeyEntries({});
  assert.strictEqual(b.glm.priority, 0);
});

test('constants stable: poolKey glm, id.secret-shaped placeholder, v4 endpoint', () => {
  assert.strictEqual(leaf.GLM_POOL_KEY, 'glm');
  assert.ok(leaf.GLM_PLACEHOLDER_KEY.includes('.'), 'id.secret shape');
  assert.ok(/open\.bigmodel\.cn\/api\/paas\/v4/.test(leaf.GLM_ENDPOINT));
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.builtinGlmKeyEntries(undefined));
  assert.doesNotThrow(() => leaf.builtinGlmKeyEnabled(null));
});

// ── apiKeyPool 并入接线(整模块加载,真跑 init/reload)─────────────────────────────
// 每个用例注入一个全新的临时 KHY_DATA_HOME,并清掉 dataHome/apiKeyPool 的 require 缓存,
// 确保 pool 从空目录冷启动、与真实 ~/.khy 完全隔离。
let _homeSeq = 0;
function withEnv(mut, fn) {
  const freshHome = path.join(_TMP_HOME, `h${_homeSeq++}`);
  fs.mkdirSync(freshHome, { recursive: true });
  const full = { KHY_DATA_HOME: freshHome, ...mut };
  const saved = {};
  for (const k of Object.keys(full)) { saved[k] = process.env[k]; if (full[k] == null) delete process.env[k]; else process.env[k] = full[k]; }
  try {
    delete require.cache[require.resolve('../src/utils/dataHome')];
    delete require.cache[require.resolve('../src/services/apiKeyPool')];
    return fn();
  } finally {
    for (const k of Object.keys(full)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('apiKeyPool: gate ON → GLM placeholder visible in status but NOT counted available', () => {
  withEnv({ KHY_BUILTIN_GLM_KEY: undefined, GLM_API_KEY: undefined }, () => {
    delete require.cache[require.resolve('../src/services/apiKeyPool')];
    const pool = require('../src/services/apiKeyPool');
    pool.init();
    const status = pool.getPoolStatus('glm');
    const placeholder = status.find(e => e.label === 'built-in' && e.priority === 0);
    assert.ok(placeholder, 'built-in GLM placeholder present at priority 0 (still "configured")');
    // 占位 key 不是可用凭据:hasAvailableKeys=false(避免误路由+误判「有模型」)、pick=null。
    assert.strictEqual(pool.hasAvailableKeys('glm'), false, 'placeholder alone → not available');
    assert.strictEqual(pool.pick('glm'), null, 'placeholder is never picked/sent upstream');
  });
});

test('apiKeyPool: real GLM key present → available, and only the real key is picked', () => {
  withEnv({ KHY_BUILTIN_GLM_KEY: undefined, GLM_API_KEY: 'realglmkey.secretpart123' }, () => {
    delete require.cache[require.resolve('../src/services/apiKeyPool')];
    const pool = require('../src/services/apiKeyPool');
    pool.init();
    assert.strictEqual(pool.hasAvailableKeys('glm'), true, 'real key → available');
    // pick 多次都必须落到真 key,绝不轮询到占位假 key(同为 priority 0 的历史缺陷)。
    for (let i = 0; i < 6; i++) {
      const sel = pool.pick('glm');
      assert.ok(sel, 'pick returns a key');
      assert.strictEqual(sel.key, 'realglmkey.secretpart123', 'never the placeholder');
    }
  });
});

test('apiKeyPool: gate OFF → GLM placeholder not merged (byte-revert)', () => {
  withEnv({ KHY_BUILTIN_GLM_KEY: '0', GLM_API_KEY: undefined }, () => {
    delete require.cache[require.resolve('../src/services/apiKeyPool')];
    const pool = require('../src/services/apiKeyPool');
    pool.init();
    const status = pool.getPoolStatus('glm');
    const placeholder = status.find(e => e.label === 'built-in' && e.priority === 0);
    assert.strictEqual(placeholder, undefined, 'placeholder must be absent when gated off');
  });
});

// Regression for the real-world state: a prior save() persisted the placeholder into
// api_keys.json (label:'built-in', priority 0). On reload it comes back as a plain JSON
// entry WITHOUT the placeholder flag. Value-based recognition must still exclude it, and
// a subsequent save() must strip it so it stops being persisted.
test('apiKeyPool: disk-persisted placeholder is excluded by value + stripped on save', () => {
  withEnv({ KHY_BUILTIN_GLM_KEY: '0', GLM_API_KEY: undefined }, () => {
    const home = process.env.KHY_DATA_HOME;
    const poolFile = path.join(home, 'api_keys.json');
    fs.writeFileSync(poolFile, JSON.stringify({
      glm: [
        { key: leaf.GLM_PLACEHOLDER_KEY, endpoint: leaf.GLM_ENDPOINT, priority: 0, label: 'built-in' },
      ],
    }), 'utf-8');

    delete require.cache[require.resolve('../src/services/apiKeyPool')];
    const pool = require('../src/services/apiKeyPool');
    pool.init();

    // Loaded from JSON without an explicit placeholder flag, yet recognized by value:
    assert.strictEqual(pool.hasAvailableKeys('glm'), false, 'disk placeholder → not available');
    assert.strictEqual(pool.pick('glm'), null, 'disk placeholder → never picked');
    // Still visible as "configured" in introspection.
    assert.ok(pool.getPoolStatus('glm').some(e => e.label === 'built-in'), 'still shown');

    // save() must drop it → file no longer carries the fake key.
    pool.save();
    const onDisk = JSON.parse(fs.readFileSync(poolFile, 'utf-8'));
    const glmKeys = (onDisk.glm || []).map(e => e.key);
    assert.ok(!glmKeys.includes(leaf.GLM_PLACEHOLDER_KEY), 'placeholder stripped from disk');
  });
});
