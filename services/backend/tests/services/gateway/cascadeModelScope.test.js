'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const scope = require('../../../src/services/gateway/cascadeModelScope');

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('isEnabled: 默认开;CANON off-words 关', () => {
  assert.strictEqual(scope.isEnabled({}), true, '默认必须开');
  assert.strictEqual(scope.isEnabled({ KHY_CASCADE_MODEL_SCOPE: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.strictEqual(scope.isEnabled({ KHY_CASCADE_MODEL_SCOPE: off }), false, `期望 ${off} 关`);
  }
});

// ── 规则 ─────────────────────────────────────────────────────────────────────

test('候选通道就是首选通道 → 带上模型名', () => {
  assert.strictEqual(scope.shouldCarryPreferredModel('codex', 'codex'), true);
  assert.strictEqual(scope.shouldCarryPreferredModel('relay_api', 'relay_api'), true);
});

test('回落到非首选通道 → 丢弃模型名(本次修复的核心)', () => {
  // 用户实测的那一枪:首选 codex(未安装)→ 回落 relay_api → 带着 codex 的模型名打
  // api.stepfun.com → HTTP 404 model_invalid。
  assert.strictEqual(scope.shouldCarryPreferredModel('relay_api', 'codex'), false);
  assert.strictEqual(scope.shouldCarryPreferredModel('api', 'codex'), false);
  assert.strictEqual(scope.shouldCarryPreferredModel('claude', 'codex'), false);
});

test('未设首选 / auto → 一律带上(不代调用方撤销显式钉的模型)', () => {
  for (const p of ['', '  ', null, undefined, 'auto', 'AUTO', ' Auto ']) {
    assert.strictEqual(scope.shouldCarryPreferredModel('relay_api', p), true, `preferred=${String(p)} 应携带`);
  }
});

test('与既有 ollama 特例同解:本规则是它的一般化', () => {
  // 既有代码:preferredAdapter === 'ollama' && entry !== 'ollama' → model: null
  assert.strictEqual(scope.shouldCarryPreferredModel('relay_api', 'ollama'), false, '与既有特例同解');
  assert.strictEqual(scope.shouldCarryPreferredModel('ollama', 'ollama'), true);
});

test('大小写敏感:preferredAdapter 传入前已归一,不在本叶子二次猜测', () => {
  // aiGatewayGenerateMethod 已把输入 match 成注册表里的真实 key(或 localLLM)。
  assert.strictEqual(scope.shouldCarryPreferredModel('localLLM', 'localLLM'), true);
  // 未归一的大小写不应被当成同一个通道——那会让「回落」被误判成「首选」。
  assert.strictEqual(scope.shouldCarryPreferredModel('LocalLLM', 'localLLM'), false);
});

test('纯叶子契约:任何异常输入都不抛,且回落到「维持今日行为」', () => {
  for (const [e, p] of [[null, null], [undefined, undefined], [{}, {}], [123, 456], [[], []]]) {
    assert.doesNotThrow(() => scope.shouldCarryPreferredModel(e, p));
  }
  // 对象类 preferred 会被 String() 成 '[object Object]',与同样字符串化的 entry 相等 → true。
  // 关键是不抛、且不会把「该丢」误判成「该带」之外的第三种状态。
  assert.strictEqual(typeof scope.shouldCarryPreferredModel({}, {}), 'boolean');
});

test('确定性:同输入恒同输出', () => {
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(scope.shouldCarryPreferredModel('relay_api', 'codex'), false);
    assert.strictEqual(scope.shouldCarryPreferredModel('codex', 'codex'), true);
  }
});

test('自描述可用,且申明了默认开与关门语义', () => {
  const d = scope.describeCascadeModelScope();
  assert.strictEqual(d.gate, 'KHY_CASCADE_MODEL_SCOPE');
  assert.strictEqual(d.defaultOn, true);
  assert.ok(d.summary && d.summary.length > 20);
  assert.ok(/回退今日行为/.test(d.off), '必须写明关门后是逐字节回退');
});

// ── 门关时必须逐字节等价于今日行为 ───────────────────────────────────────────

test('门关 → 级联点恒携带模型名(等价于改动前)', () => {
  // 复刻 aiGatewayGenerateMethod 级联点的判定式,验证门关时结果恒为 true。
  const decide = (entryKey, preferredAdapter, env) =>
    !scope.isEnabled(env) || scope.shouldCarryPreferredModel(entryKey, preferredAdapter);

  const off = { KHY_CASCADE_MODEL_SCOPE: 'off' };
  for (const [e, p] of [['relay_api', 'codex'], ['api', 'codex'], ['claude', 'ollama'], ['x', 'y']]) {
    assert.strictEqual(decide(e, p, off), true, `门关时 ${e}/${p} 必须携带`);
  }
  // 门开时才丢弃
  assert.strictEqual(decide('relay_api', 'codex', {}), false);
});

test('flagRegistry 已登记该门(否则 off 开关会被恒 true 无视)', () => {
  const reg = require('../../../src/services/flagRegistry');
  assert.strictEqual(
    reg.isFlagEnabled('KHY_CASCADE_MODEL_SCOPE', { KHY_CASCADE_MODEL_SCOPE: 'off' }),
    false,
    '未登记的 flag 会被 isFlagEnabled 恒判为 true,关门开关将失效',
  );
  assert.strictEqual(reg.isFlagEnabled('KHY_CASCADE_MODEL_SCOPE', {}), true, '默认开');
});
