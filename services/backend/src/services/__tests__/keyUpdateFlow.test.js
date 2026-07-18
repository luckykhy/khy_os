'use strict';

/**
 * keyUpdateFlow.test.js — API Key 失效→询问→无模型也能更新 纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表回退)、looksLikeBareKey(sk- 家族 /
 * id.secret / 孤立长串 / 标签+key / 厂商+key / 拒普通句 / 过长拒 / 门关 {isKey:false})、
 * extractProviderHint(智谱→glm 等 / 无→'')、decideProvider(hint 优先 / 唯一已配置自动 /
 * 多个或零→needsProvider / 门关 needsProvider)、buildKeyUpdateInvite(含邀请语 + 无模型措辞 /
 * 带厂商 / 门关 '')。零 IO、确定性——每断言显式传 env。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const kuf = require('../keyUpdateFlow');

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(kuf.isEnabled({}), true);
  assert.equal(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: '1' }), true);
  assert.equal(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  assert.equal(kuf.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(kuf.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_KEY_UPDATE_FLOW: 'off' }), false);
});

test('looksLikeBareKey:sk- 家族(裸 / 带厂商 / 带动词)命中并抽出 key', () => {
  assert.deepEqual(kuf.looksLikeBareKey('sk-abcdef123456', {}), { isKey: true, key: 'sk-abcdef123456' });
  assert.deepEqual(kuf.looksLikeBareKey('glm sk-proj-ABC123xyz789', {}), { isKey: true, key: 'sk-proj-ABC123xyz789' });
  assert.deepEqual(kuf.looksLikeBareKey('把 key 换成 sk-newKey998877', {}), { isKey: true, key: 'sk-newKey998877' });
});

test('looksLikeBareKey:id.secret / 孤立长串 / 标签+key 命中', () => {
  assert.equal(kuf.looksLikeBareKey('abcdef123456.7890abcdef', {}).isKey, true); // id.secret
  assert.equal(kuf.looksLikeBareKey('A1b2C3d4E5f6G7h8I9j0K1l2', {}).isKey, true); // 24 字符孤立长串
  const r = kuf.looksLikeBareKey('密钥 A1b2C3d4E5f6G7h8I9j0K1l2', {});
  assert.equal(r.isKey, true);
  assert.equal(r.key, 'A1b2C3d4E5f6G7h8I9j0K1l2'); // key 逐字节保留大小写(secret 段大小写敏感,见 keyUpdateFlowCasePreserve.test.js)
});

test('looksLikeBareKey:普通句子 / 空 / 过长 → 不误判', () => {
  assert.equal(kuf.looksLikeBareKey('你好，帮我看看今天天气怎么样', {}).isKey, false);
  assert.equal(kuf.looksLikeBareKey('这段代码里有个很长的变量名 someVeryLongVariableName 需要重命名吗', {}).isKey, false);
  assert.equal(kuf.looksLikeBareKey('', {}).isKey, false);
  assert.equal(kuf.looksLikeBareKey(null, {}).isKey, false);
  assert.equal(kuf.looksLikeBareKey('x'.repeat(300), {}).isKey, false);
});

test('looksLikeBareKey:门关 → {isKey:false}(逐字节回退)', () => {
  assert.deepEqual(kuf.looksLikeBareKey('sk-abcdef123456', { KHY_KEY_UPDATE_FLOW: 'off' }), { isKey: false, key: '' });
});

test('extractProviderHint:识别常见厂商;识别不到 → ""', () => {
  assert.equal(kuf.extractProviderHint('智谱的 key', {}), 'glm');
  assert.equal(kuf.extractProviderHint('glm sk-xxx', {}), 'glm');
  assert.equal(kuf.extractProviderHint('deepseek 换 key', {}), 'deepseek');
  assert.equal(kuf.extractProviderHint('通义千问', {}), 'qwen');
  assert.equal(kuf.extractProviderHint('sk-abcdef123456', {}), ''); // 无厂商词
  assert.equal(kuf.extractProviderHint('智谱', { KHY_KEY_UPDATE_FLOW: 'off' }), ''); // 门关
});

test('decideProvider:hint 优先 > 唯一已配置自动 > 多个/零→needsProvider', () => {
  assert.deepEqual(kuf.decideProvider({ hint: 'glm', configuredPoolKeys: ['deepseek', 'glm'] }, {}), { provider: 'glm' });
  assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: ['glm'] }, {}), { provider: 'glm' });
  assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: ['glm', 'deepseek'] }, {}), { needsProvider: true });
  assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: [] }, {}), { needsProvider: true });
});

test('inferProviderFromKeyShape:智谱 hex32.secret → glm;其它形态 → ""', () => {
  // 真实智谱形态(32 位 hex id + . + secret)。
  assert.equal(kuf.inferProviderFromKeyShape('0123456789abcdef0123456789abcdef.FaKeSeCrEt123', {}), 'glm');
  // sk- 前缀不是智谱形态 → 不猜。
  assert.equal(kuf.inferProviderFromKeyShape('sk-abcdef123456', {}), '');
  // 短 id.secret(非 32 hex 前缀)→ 不猜(避免把普通 a.b 误判)。
  assert.equal(kuf.inferProviderFromKeyShape('abcdef123456.7890abcdef', {}), '');
  // 门关 → ''。
  assert.equal(kuf.inferProviderFromKeyShape('0123456789abcdef0123456789abcdef.FaKeSeCrEt123', { KHY_KEY_UPDATE_FLOW: 'off' }), '');
  // junk → '' 且不抛。
  assert.equal(kuf.inferProviderFromKeyShape(null, {}), '');
});

test('decideProvider:无 hint 但 key 形态可辨识(智谱)→ 带猜测反问确认(不静默拍板 glm),即使多池已配置', () => {
  // 用户在识图失败后**只粘一把智谱形态 key**(不带「glm」字样)。同形态未必真属智谱(可能是别家兼容
  // key)→ 不静默归属,返回 { needsProvider:true, shapeGuess:'glm' } 交反问流带猜测确认。
  assert.deepEqual(
    kuf.decideProvider({ hint: '', key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123', configuredPoolKeys: ['sensenova', 'glm'] }, {}),
    { needsProvider: true, shapeGuess: 'glm' });
  // 显式 hint 仍优先于形态(用户已明说厂商,不再多问)。
  assert.deepEqual(
    kuf.decideProvider({ hint: 'deepseek', key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123', configuredPoolKeys: [] }, {}),
    { provider: 'deepseek' });
  // 无 hint、形态不可辨识、多池 → 仍反问(不猜)。
  assert.deepEqual(
    kuf.decideProvider({ hint: '', key: 'sk-abcdef123456', configuredPoolKeys: ['glm', 'deepseek'] }, {}),
    { needsProvider: true });
});

test('decideProvider:KHY_KEY_SHAPE_CONFIRM 子门关 → 形态命中逐字节回退旧行为(直接归属 glm)', () => {
  // 子门单独关(父门仍开)→ 形态可辨识时直接 { provider:'glm' },与引入确认前逐字节等价。
  assert.deepEqual(
    kuf.decideProvider(
      { hint: '', key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123', configuredPoolKeys: ['sensenova', 'glm'] },
      { KHY_KEY_SHAPE_CONFIRM: 'off' }),
    { provider: 'glm' });
});

test('buildShapeConfirmInvite:含厂商猜测 + 改厂商引导;无 shapeGuess/门关 → ""', () => {
  const d = kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, {});
  assert.ok(d.includes('glm'));
  assert.ok(d.includes('确认') || d.includes('归属'));
  assert.ok(d.includes('换成') || d.includes('别家'));
  // 全程不含 key 本体。
  assert.ok(!d.includes('FaKeSeCrEt'));
  // 无 shapeGuess → ''。
  assert.equal(kuf.buildShapeConfirmInvite({}, {}), '');
  // 子门关 → ''。
  assert.equal(kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, { KHY_KEY_SHAPE_CONFIRM: 'off' }), '');
  // 父门关 → ''(子必关)。
  assert.equal(kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, { KHY_KEY_UPDATE_FLOW: 'off' }), '');
});

test('decideProvider:门关 → needsProvider(安全默认,不自动写)', () => {
  assert.deepEqual(kuf.decideProvider({ hint: 'glm', configuredPoolKeys: ['glm'] }, { KHY_KEY_UPDATE_FLOW: 'off' }), { needsProvider: true });
});

test('buildKeyUpdateInvite:含邀请语 + 无模型措辞;带厂商;门关 ""', () => {
  const d = kuf.buildKeyUpdateInvite({}, {});
  assert.ok(d.includes('API Key'));
  assert.ok(d.includes('更新'));
  assert.ok(d.includes('无需任何模型') || d.includes('无需') );
  const withProv = kuf.buildKeyUpdateInvite({ provider: '智谱 GLM' }, {});
  assert.ok(withProv.includes('智谱 GLM'));
  assert.equal(kuf.buildKeyUpdateInvite({}, { KHY_KEY_UPDATE_FLOW: 'off' }), '');
});
