'use strict';
/**
 * keyUpdateFlow.test.js �?API Key 失效→询问→无模型也能更�?纯叶子契�?node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表回退)、looksLikeBareKey(sk- 家族 /
 * id.secret / 孤立长串 / 标签+key / 厂商+key / 拒普通句 / 过长�?/ 门关 {isKey:false})�? * extractProviderHint(智谱→glm �?/ 无→'')、decideProvider(hint 优先 / 唯一已配置自�?/
 * 多个或零→needsProvider / 门关 needsProvider)、buildKeyUpdateInvite(含邀请语 + 无模型措�?/
 * 带厂�?/ 门关 '')。零 IO、确定性——每断言显式�?env�? */
const kuf = require('../keyUpdateFlow');
test('extractProviderHint:识别常见厂商;识别不到 �?""', () => {
  expect(kuf.extractProviderHint('智谱�?key', {})).toBe('glm');
  expect(kuf.extractProviderHint('glm sk-xxx', {})).toBe('glm');
  expect(kuf.extractProviderHint('deepseek �?key', {})).toBe('deepseek');
  expect(kuf.extractProviderHint('通义千问', {})).toBe('qwen');
  expect(kuf.extractProviderHint('sk-abcdef123456', {})).toBe(''); // 无厂商词
  expect(kuf.extractProviderHint('智谱', { KHY_KEY_UPDATE_FLOW: 'off' })).toBe(''); // 门关
});
test('inferProviderFromKeyShape:智谱 hex32.secret �?glm;其它形�?�?""', () => {
  // 真实智谱形�?32 �?hex id + . + secret)�?  assert.equal(
    kuf.inferProviderFromKeyShape('0123456789abcdef0123456789abcdef.FaKeSeCrEt123', {}),
    'glm'
  );
  // sk- 前缀不是智谱形�?�?不猜�?  expect(kuf.inferProviderFromKeyShape('sk-abcdef123456', {})).toBe('');
  // �?id.secret(�?32 hex 前缀)�?不猜(避免把普�?a.b 误判)�?  expect(kuf.inferProviderFromKeyShape('abcdef123456.7890abcdef', {})).toBe('');
  // 门关 �?''�?  assert.equal(
    kuf.inferProviderFromKeyShape('0123456789abcdef0123456789abcdef.FaKeSeCrEt123', {
      KHY_KEY_UPDATE_FLOW: 'off',
    }),
    ''
  );
  // junk �?'' 且不抛�?  expect(kuf.inferProviderFromKeyShape(null, {})).toBe('');
});
test('buildShapeConfirmInvite:含厂商猜�?+ 改厂商引�?�?shapeGuess/门关 �?""', () => {
  const d = kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, {});
  expect(d).toContain('glm');
  expect(d.includes('确认') || d).toContain('归属');
  expect(d.includes('换成') || d).toContain('别家');
  // 全程不含 key 本体�?  expect(!d).toContain('FaKeSeCrEt');
  // �?shapeGuess �?''�?  expect(kuf.buildShapeConfirmInvite({}, {})).toBe('');
  // 子门�?�?''�?  assert.equal(
    kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, { KHY_KEY_SHAPE_CONFIRM: 'off' }),
    ''
  );
  // 父门�?�?''(子必�?�?  assert.equal(
    kuf.buildShapeConfirmInvite({ shapeGuess: 'glm' }, { KHY_KEY_UPDATE_FLOW: 'off' }),
    ''
  );
});
test('buildKeyUpdateInvite:含邀请语 + 无模型措�?带厂�?门关 ""', () => {
  const d = kuf.buildKeyUpdateInvite({}, {});
  expect(d).toContain('API Key');
  expect(d).toContain('更新');
  expect(d.includes('无需任何模型') || d).toContain('无需');
  const withProv = kuf.buildKeyUpdateInvite({ provider: '智谱 GLM' }, {});
  expect(withProv).toContain('智谱 GLM');
  expect(kuf.buildKeyUpdateInvite({}, { KHY_KEY_UPDATE_FLOW: 'off' })).toBe('');
});

describe('Key Update Flow', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(kuf.isEnabled({})).toBe(true);
      expect(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: '1' })).toBe(true);
      expect(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(kuf.isEnabled({ KHY_KEY_UPDATE_FLOW: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      expect(kuf.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      expect(kuf.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_KEY_UPDATE_FLOW: 'off' })).toBe(false);
  });

  test('looksLikeBareKey:sk- 家族(�?/ 带厂�?/ 带动�?命中并抽�?key', () => {
      assert.deepEqual(kuf.looksLikeBareKey('sk-abcdef123456', {}), {
        isKey: true,
        key: 'sk-abcdef123456',
      });
      assert.deepEqual(kuf.looksLikeBareKey('glm sk-proj-ABC123xyz789', {}), {
        isKey: true,
        key: 'sk-proj-ABC123xyz789',
      });
      assert.deepEqual(kuf.looksLikeBareKey('�?key 换成 sk-newKey998877', {}), {
        isKey: true,
        key: 'sk-newKey998877',
      });
  });

  test('looksLikeBareKey:id.secret / 孤立长串 / 标签+key 命中', () => {
      expect(kuf.looksLikeBareKey('abcdef123456.7890abcdef', {})).toBe(.isKey, true)); // id.secret
      expect(kuf.looksLikeBareKey('A1b2C3d4E5f6G7h8I9j0K1l2', {})).toBe(.isKey, true)); // 24 字符孤立长串
      const r = kuf.looksLikeBareKey('密钥 A1b2C3d4E5f6G7h8I9j0K1l2', {});
      expect(r.isKey).toBe(true);
      expect(r.key).toBe('A1b2C3d4E5f6G7h8I9j0K1l2'); // key 逐字节保留大小写(secret 段大小写敏感,�?keyUpdateFlowCasePreserve.test.js)
  });

  test('looksLikeBareKey:普通句�?/ �?/ 过长 �?不误�?, () => {
      expect(kuf.looksLikeBareKey('你好，帮我看看今天天气怎么�?, {})).toBe(.isKey, false);
      assert.equal(
        kuf.looksLikeBareKey('这段代码里有个很长的变量�?someVeryLongVariableName 需要重命名�?, {})
          .isKey,
        false
      );
      expect(kuf.looksLikeBareKey('', {})).toBe(.isKey, false);
      expect(kuf.looksLikeBareKey(null, {})).toBe(.isKey, false);
      expect(kuf.looksLikeBareKey('x'.repeat(300), {})).toBe(.isKey, false);
  });

  test('looksLikeBareKey:门关 �?{isKey:false}(逐字节回退)', () => {
      assert.deepEqual(kuf.looksLikeBareKey('sk-abcdef123456', { KHY_KEY_UPDATE_FLOW: 'off' }), {
        isKey: false,
        key: '',
      });
  });

  test('decideProvider:hint 优先 > 唯一已配置自�?> 多个/零→needsProvider', () => {
      assert.deepEqual(
        kuf.decideProvider({ hint: 'glm', configuredPoolKeys: ['deepseek', 'glm'] }, {}),
        { provider: 'glm' }
      );
      assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: ['glm'] }, {}), {
        provider: 'glm',
      });
      assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: ['glm', 'deepseek'] }, {}), {
        needsProvider: true,
      });
      assert.deepEqual(kuf.decideProvider({ hint: '', configuredPoolKeys: [] }, {}), {
        needsProvider: true,
      });
  });

  test('decideProvider:�?hint �?key 形态可辨识(智谱)�?带猜测反问确�?不静默拍�?glm),即使多池已配�?, () => {
      // 用户在识图失败后**只粘一把智谱形�?key**(不带「glm」字�?。同形态未必真属智�?可能是别家兼�?      // key)�?不静默归�?返回 { needsProvider:true, shapeGuess:'glm' } 交反问流带猜测确认�?      assert.deepEqual(
        kuf.decideProvider(
          {
            hint: '',
            key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123',
            configuredPoolKeys: ['sensenova', 'glm'],
          },
          {}
        ),
        { needsProvider: true, shapeGuess: 'glm' }
      );
      // 显式 hint 仍优先于形�?用户已明说厂�?不再多问)�?      assert.deepEqual(
        kuf.decideProvider(
          {
            hint: 'deepseek',
            key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123',
            configuredPoolKeys: [],
          },
          {}
        ),
        { provider: 'deepseek' }
      );
      // �?hint、形态不可辨识、多�?�?仍反�?不猜)�?      assert.deepEqual(
        kuf.decideProvider(
          { hint: '', key: 'sk-abcdef123456', configuredPoolKeys: ['glm', 'deepseek'] },
          {}
        ),
        { needsProvider: true }
      );
  });

  test('decideProvider:KHY_KEY_SHAPE_CONFIRM 子门�?�?形态命中逐字节回退旧行�?直接归属 glm)', () => {
      // 子门单独�?父门仍开)�?形态可辨识时直�?{ provider:'glm' },与引入确认前逐字节等价�?      assert.deepEqual(
        kuf.decideProvider(
          {
            hint: '',
            key: '0123456789abcdef0123456789abcdef.FaKeSeCrEt123',
            configuredPoolKeys: ['sensenova', 'glm'],
          },
          { KHY_KEY_SHAPE_CONFIRM: 'off' }
        ),
        { provider: 'glm' }
      );
  });

  test('decideProvider:门关 �?needsProvider(安全默认,不自动写)', () => {
      assert.deepEqual(
        kuf.decideProvider(
          { hint: 'glm', configuredPoolKeys: ['glm'] },
          { KHY_KEY_UPDATE_FLOW: 'off' }
        ),
        { needsProvider: true }
      );
  });

});

