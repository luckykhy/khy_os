'use strict';

/**
 * nlExternalAppImportResolver — 反向 NL 解析叶子单测(node:test)。
 * 覆盖:6 app × {用/使用/导入} 命中 import;只读发现命中 discover;「导入所有外部软件的模型」→ all:true;
 * 零假阳性(正向配置句、无模型域句、纯谈软件句 → null);门控关 → null;
 * 交叉核验(反向句喂正向 resolver → 不接管;正向句喂反向 resolver → 不接管)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../../src/services/config/nlExternalAppImportResolver');
const FWD = require('../../../src/services/config/nlExternalAppResolver');

const ON = { KHY_NL_EXTERNAL_APP_IMPORT: 'true' };

// ── import 命中(每 app 一句反向动词)──────────────────────────────────────────
test('import: 用 opencode 里的模型', () => {
  assert.deepEqual(R.resolve('我想用 opencode 里的模型', ON), { app: 'opencode', action: 'import' });
});
test('import: 使用 openclaw 中的模型', () => {
  assert.deepEqual(R.resolve('使用 openclaw 中的模型', ON), { app: 'openclaw', action: 'import' });
});
test('import: 导入 reasonix 的模型', () => {
  assert.deepEqual(R.resolve('把 deepseek-reasonix 的模型导入进来', ON), { app: 'reasonix', action: 'import' });
});
test('import: 复用 deepseek-tui 的模型', () => {
  assert.deepEqual(R.resolve('复用 deepseek-tui 里的大模型', ON), { app: 'deepseek-tui', action: 'import' });
});
test('import: 导入 coze 的模型', () => {
  assert.deepEqual(R.resolve('导入扣子里配置好的模型', ON), { app: 'coze', action: 'import' });
});
test('import: 用 claude-code 的模型', () => {
  assert.deepEqual(R.resolve('我要用 claude code 里的模型', ON), { app: 'claude-code', action: 'import' });
});

// ── discover 现由正向 list 服务:反向叶子对纯"列出"phrasing 不接管(import-only)──────
test('import-only: 列出/有哪些 phrasing 不接管(交给正向 list) → null', () => {
  assert.equal(R.resolve('opencode 里有哪些可用的模型', ON), null);
  assert.equal(R.resolve('列出 openclaw 配置的模型', ON), null);
});

// ── 弱反向动词 使用/用 让位正向配置动作 ──────────────────────────────────────────
test('weak-use defers to forward when a config verb is present', () => {
  // 「配置 opencode 使用 deepseek 模型」= 正向(把 deepseek 配进 opencode),反向不接管。
  assert.equal(R.resolve('配置 opencode 使用 deepseek 模型', ON), null);
  assert.equal(R.resolve('设置 openclaw 用 deepseek 模型', ON), null);
});
test('strong-import verb overrides an incidental 配置 定语', () => {
  // 「复用 claude code 配置的模型」= 反向(配置 是定语),强反向动词 复用 命中即接管。
  assert.deepEqual(R.resolve('复用 claude code 配置的模型', ON), { app: 'claude-code', action: 'import' });
});

// ── all:所有外部软件 ─────────────────────────────────────────────────────────
test('all: 导入所有外部软件的模型', () => {
  assert.deepEqual(R.resolve('把所有外部软件里的模型都导入进来', ON), { action: 'import', all: true });
});
test('all: needs import verb (bare "所有外部软件的模型" → null)', () => {
  assert.equal(R.resolve('所有外部软件的模型', ON), null);
});

// ── 零假阳性 ──────────────────────────────────────────────────────────────────
test('reject: 正向配置句(给 opencode 配置 deepseek 模型)', () => {
  assert.equal(R.resolve('给 opencode 配置 deepseek 模型', ON), null);
});
test('reject: 正向删除句(删除 opencode 里的 deepseek)', () => {
  assert.equal(R.resolve('删除 opencode 里的 deepseek 模型', ON), null);
});
test('reject: 无模型域(怎么使用 opencode 这个软件)', () => {
  assert.equal(R.resolve('怎么使用 opencode 这个软件', ON), null);
});
test('reject: 有模型域但无 app 名且非 all(用一下这个模型)', () => {
  assert.equal(R.resolve('用一下这个模型', ON), null);
});
test('reject: 无反向动词(opencode 的模型很强)', () => {
  assert.equal(R.resolve('opencode 的模型很强', ON), null);
});
test('reject: empty / oversized', () => {
  assert.equal(R.resolve('', ON), null);
  assert.equal(R.resolve('用模型'.repeat(200), ON), null);
});

// ── 门控关 → null ──────────────────────────────────────────────────────────────
test('gate off: KHY_NL_EXTERNAL_APP_IMPORT=off → null', () => {
  assert.equal(R.resolve('用 opencode 里的模型', { KHY_NL_EXTERNAL_APP_IMPORT: 'off' }), null);
});

// ── 交叉核验:两叶子互不接管 ─────────────────────────────────────────────────────
test('cross: reverse sentence does NOT trigger forward resolver', () => {
  // 反向「用 opencode 里的模型」喂正向 → 正向无 add/remove/list/get 动词 → null。
  assert.equal(FWD.resolve('我想用 opencode 里的模型', { KHY_NL_EXTERNAL_APP: 'true' }), null);
});
test('cross: forward config sentence does NOT trigger reverse resolver', () => {
  // 正向「给 opencode 配置 deepseek 模型」喂反向 → 无反向动词 → null。
  assert.equal(R.resolve('给 opencode 配置 deepseek 模型', ON), null);
});
test('cross: forward add sentence still resolves in forward resolver', () => {
  const r = FWD.resolve('给 opencode 配置 deepseek 模型', { KHY_NL_EXTERNAL_APP: 'true' });
  assert.ok(r && r.app === 'opencode' && r.action === 'add');
});

// ── never throws ────────────────────────────────────────────────────────────────
test('never throws on malformed input', () => {
  assert.doesNotThrow(() => R.resolve(null, ON));
  assert.doesNotThrow(() => R.resolve(undefined, ON));
  assert.doesNotThrow(() => R.resolve(12345, ON));
  assert.doesNotThrow(() => R.resolve({}, ON));
});
