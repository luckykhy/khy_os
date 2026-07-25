'use strict';

/**
 * opencodeAdapter 配置自愈单测(node:test)。
 *
 * 复现用户现场:opencode.json 里 provider.opencode.models 被写成 khy 内部形状
 * `{default:"agnes-2.0-flash", list:["agnes-2.0-flash"]}`,导致 opencode 报
 * `Expected object, got "agnes-2.0-flash"` 拒启动,且旧 add() 永久保留损坏键。
 *
 * 断言:
 *   - repair() 把损坏形状迁成合法 {modelId:{name}} 映射 + 顶层 model,并落盘;
 *   - 无损坏 → repair() no-op(不落盘);
 *   - add() 经自愈后写出的配置不含 default/list 损坏键;
 *   - 门 KHY_OPENCODE_CONFIG_HEAL=off → 逐字节回退(不自愈,repair 报 disabled);
 *   - 纯函数 _healProviderModels / _healDoc 直测;fail-soft 不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../../../src/services/externalApps/opencodeAdapter');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-${prefix}-`));
}

function envFor(dir) {
  return { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') };
}

function writeBroken(env, doc) {
  const file = A.configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

const BROKEN = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      name: 'opencode',
      options: { baseURL: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-real-xyz' },
      models: { default: 'agnes-2.0-flash', list: ['agnes-2.0-flash'] },
    },
  },
};

test('repair: 迁移损坏 models{default,list} → {id:{name}} + 顶层 model', () => {
  const dir = mkTmp('opencode-heal');
  const env = envFor(dir);
  const file = writeBroken(env, JSON.parse(JSON.stringify(BROKEN)));

  const r = A.repair(env);
  assert.equal(r.success, true);
  assert.equal(r.changed, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = doc.provider.opencode.models;
  assert.equal(models.default, undefined, 'default 键必须被移除');
  assert.equal(models.list, undefined, 'list 键必须被移除');
  assert.deepEqual(models['agnes-2.0-flash'], { name: 'agnes-2.0-flash' });
  assert.equal(doc.model, 'opencode/agnes-2.0-flash', '顶层 model 从 default 补出');
  // 未破坏无关字段
  assert.equal(doc.provider.opencode.options.apiKey, 'sk-real-xyz');
  assert.equal(doc.provider.opencode.options.baseURL, 'https://apihub.agnes-ai.com/v1');
});

test('repair: 合法配置 → no-op(不落盘、changed=false)', () => {
  const dir = mkTmp('opencode-noop');
  const env = envFor(dir);
  const clean = {
    model: 'opencode/agnes-2.0-flash',
    provider: {
      opencode: {
        npm: '@ai-sdk/openai-compatible',
        name: 'opencode',
        options: { baseURL: 'https://x/v1', apiKey: 'sk-1' },
        models: { 'agnes-2.0-flash': { name: 'agnes-2.0-flash' } },
      },
    },
  };
  const file = writeBroken(env, clean);
  const before = fs.readFileSync(file, 'utf8');

  const r = A.repair(env);
  assert.equal(r.success, true);
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '合法配置字节不变');
});

test('list/add 经消费侧自愈:损坏配置也能读到干净视图 + add 不留损坏键', () => {
  const dir = mkTmp('opencode-add-heal');
  const env = envFor(dir);
  const file = writeBroken(env, JSON.parse(JSON.stringify(BROKEN)));

  // list 走 _load → 门开时内存自愈
  const listed = A.list(env);
  assert.equal(listed.success, true);
  assert.deepEqual(listed.providers[0].models, ['agnes-2.0-flash']);

  // add 新模型后落盘,损坏键必须已消失
  const added = A.add({ provider: 'opencode', model: 'agnes-2.0-pro', endpoint: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-real-xyz' }, env);
  assert.equal(added.success, true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.provider.opencode.models.default, undefined);
  assert.equal(doc.provider.opencode.models.list, undefined);
  assert.ok(doc.provider.opencode.models['agnes-2.0-flash']);
  assert.ok(doc.provider.opencode.models['agnes-2.0-pro']);
});

test('门控 KHY_OPENCODE_CONFIG_HEAL=off:逐字节回退(不自愈)', () => {
  const dir = mkTmp('opencode-gateoff');
  const env = { ...envFor(dir), KHY_OPENCODE_CONFIG_HEAL: 'off' };
  const file = writeBroken(env, JSON.parse(JSON.stringify(BROKEN)));
  const before = fs.readFileSync(file, 'utf8');

  const r = A.repair(env);
  assert.equal(r.success, false);
  assert.match(String(r.error), /disabled/);

  // add 关门时不自愈:损坏键原样保留(旧行为)
  A.add({ provider: 'opencode', model: 'agnes-2.0-pro', endpoint: 'https://x/v1' }, env);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.provider.opencode.models.default, 'agnes-2.0-flash', '关门保留损坏 default 键');
  assert.equal(before.length > 0, true);
});

test('_healProviderModels 纯函数:损坏迁移 + 合法零改动 + fail-soft', () => {
  // 损坏
  const p1 = { models: { default: 'm1', list: ['m1', 'm2'] } };
  const r1 = A._healProviderModels(p1);
  assert.equal(r1.changed, true);
  assert.equal(r1.defaultModelId, 'm1');
  assert.deepEqual(p1.models, { m1: { name: 'm1' }, m2: { name: 'm2' } });

  // 合法零改动
  const clean = { models: { m1: { name: 'M1' } } };
  const r2 = A._healProviderModels(clean);
  assert.equal(r2.changed, false);
  assert.deepEqual(clean.models, { m1: { name: 'M1' } });

  // models 缺失 → 不动
  const noModels = { name: 'x' };
  assert.equal(A._healProviderModels(noModels).changed, false);

  // fail-soft:坏入参不抛
  assert.doesNotThrow(() => A._healProviderModels(null));
  assert.doesNotThrow(() => A._healProviderModels(undefined));
  assert.doesNotThrow(() => A._healProviderModels(42));
});

test('_healDoc:多 provider + 顶层 model 已有则不覆盖', () => {
  const doc = {
    model: 'other/keep-me',
    provider: {
      a: { models: { default: 'ma' } },
      b: { models: { mb: { name: 'MB' } } },
    },
  };
  const r = A._healDoc(doc);
  assert.equal(r.changed, true);
  assert.deepEqual(doc.provider.a.models, { ma: { name: 'ma' } });
  assert.equal(doc.model, 'other/keep-me', '顶层 model 已有则保留不覆盖');
});
