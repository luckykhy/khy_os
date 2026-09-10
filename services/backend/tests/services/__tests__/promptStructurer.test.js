'use strict';
/**
 * promptStructurer.test.js �?用户提示词结构化处理纯叶子契�?node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy �?/ 注册表委�?、TASK_TYPES 冻结(纯叶子不可变)�? * classify(各任务类型命�?/ general 兜底 / 约束抽取 / 疑问 / 含代�?/ 坏输入不�?�? * buildStructuredPrompt(门开产「结�?内容」且**原文逐字保留** / 门关�?null 逐字节回退 /
 * 空输入返 null / 幂等不二次包�?/ 坏输入返 null 不抛)。零 IO、确定性——显式传 env�? */
const ps = require('../promptStructurer');
// ── 关键动作抽取(回归:问候开场不该吞掉真实诉�?──────────────────────────
// bug:「你�?那么我要�?X」旧实现按逗号切句,关键动作被截成「你好�?看着像原文被丢弃
//(实则 ## 内容 原文一字未�?。修:只按句末标点切句 + 跳过纯问候开场句�?// ── 成本感知�?结构化必�?挣回"�?token(没用则保持原�?──────────────────────
// /goal 2026-07-08:结构块是纯附�?token(## 内容 已含完整原文),给「你好�?清晰一句话�?200+ token
// 结构是纯浪费。只在任务够实质、结构前缀能在对话层少走试错时才包�?否则原样(�?null,逐字节回退)�?// ── 精简格式:表头单行 + 只发带正信号的行(缺省/不存在的行是零信息噪�?不发)────────────
// /goal 2026-07-08「优化结构化的格式和方法�?结构块每行都要挣�?token。表头压�?1 �?约束仅有时发�?// 含代码仅含时发、抽象层级仅成类时发;任务类型/关键动作/期望产出恒发。资产透镜只在 category 作用域发�?test('格式:无约束请�?�?不发「约束」行(不发"无显式约�?噪声)', () => {
  const out = ps.buildStructuredPrompt('创建用户表并实现登录接口，同时补上单元测�?, {});
  expect(out).toBeTruthy();
  expect(!out).toContain('- 约束:');
  expect(!out).toContain('无显式约�?);
});
test('格式:含代�?�?发「含代码/引用: 是�?不含 �?该行不出�?不发"�?噪声)', () => {
  // 轻量含代码请�?4 空格缩进码块,长度 <24 �?非复�?�?�?bullet 路径)�?  const withCode = ps.buildStructuredPrompt('帮我看看这段\n    const a = 1', {});
  expect(withCode).toContain('含代�?引用: �?);
  const noCode = ps.buildStructuredPrompt('实现一个登录接口，必须�?JWT，不要存明文密码', {});
  expect(!noCode).toContain('含代�?引用');
});
// ── 结构单一表示:同一份解析绝不出两遍(bullet �?spec 字段完全重合即冗�?──────────────
test('结构单一�?复杂任务只出 ```spec 一种结�?不再另出重复�?bullet', () => {
  const original = '先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖';
  const out = ps.buildStructuredPrompt(original, {});
  expect(out).toContain('```spec');
  expect(!out).toContain('- 任务类型:');
  expect(!out).toContain('- 关键动作:');
  expect(out).toContain('GOAL');
  expect(out).toContain(original);
});
// ── 提示词资产化:抽象层级 + 判断透镜 ─────────────────────────────────────
// ── 回归:遗漏�?instance marker 必须被正确识�?─────────────────────────────
// ── 代码化提示词(复杂任务 �?```spec 声明式规�?────────────────────────────
test('buildCodeSpec:复杂任务 + 门开 �?�?```spec 规格(取自 classify 字段)', () => {
  const spec = ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖', {});
  expect(spec.startsWith('```spec')).toBeTruthy();
  expect(spec.trimEnd().endsWith('```')).toBeTruthy();
  expect(spec).toContain('TASK');
  expect(spec).toContain('CONSTRAINTS');
  expect(spec).toContain('JWT');
  assert.ok(
    spec.includes('冲突�?## 内容 为准') || spec.includes('冲突'),
    'spec 须声明冲突以原文为准'
  );
});
test('buildStructuredPrompt:复杂任务门开 �?结构段即�?```spec(不再另出 bullet,单一表示)', () => {
  const original = '先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖';
  const out = ps.buildStructuredPrompt(original, {});
  expect(out).toContain('## 结构 / Structure');
  expect(out).toContain('```spec');
  expect(!out).toContain('## 代码�?);
  // spec 段落在结构标题之后、内容之�?  expect(out.indexOf('## 结构') < out.indexOf('```spec')).toBeTruthy();
  expect(out.indexOf('```spec') < out.indexOf('## 内容 / Content')).toBeTruthy();
  // 原文逐字保留
  expect(out).toContain(original);
});

describe('Prompt Structurer', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(ps.isEnabled({})).toBe(true);
      expect(ps.isEnabled({ KHY_PROMPT_STRUCTURING: '1' })).toBe(true);
      expect(ps.isEnabled({ KHY_PROMPT_STRUCTURING: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(ps.isEnabled({ KHY_PROMPT_STRUCTURING: v })).toBe(false);
      }
  });

  test('isEnabled:注册表关时回退私有 _off 判定(逐字节等�?', () => {
      expect(ps.isEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      expect(ps.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: 'off' })).toBe(false);
  });

  test('TASK_TYPES:冻结(纯叶子不可变),元素�?patterns 均冻�?, () => {
      expect(Object.isFrozen(ps.TASK_TYPES).toBeTruthy());
      for (const t of ps.TASK_TYPES) {
        expect(Object.isFrozen(t)).toBeTruthy();
        expect(typeof t.key === 'string' && t.label && t.output && Array.isArray(t.patterns).toBeTruthy());
      }
  });

  test('classify:各任务类型按线索命中', () => {
      expect(ps.classify('帮我修复这个报错').taskType).toBe('debug');
      expect(ps.classify('写一个函数实现快�?).taskType).toBe('code');
      expect(ps.classify('调研一下最新的向量数据�?).taskType).toBe('research');
      expect(ps.classify('设计一个方�?).taskType).toBe('plan');
      expect(ps.classify('解释一下什么是闭包').taskType).toBe('explain');
      expect(ps.classify('写一篇文档总结这个模块').taskType).toBe('write');
  });

  test('classify:都不命中 �?general 兜底', () => {
      expect(ps.classify('今天天气不错�?).taskType).toBe('general');
  });

  test('classify:抽取显式约束从句(去重、限�?', () => {
      const info = ps.classify('实现登录；必须用 JWT；不要引入新依赖；必须用 JWT');
      expect(info.constraints.length >= 2).toBeTruthy();
      expect(info.constraints.some((c).toBeTruthy() => /JWT/.test(c)));
      expect(info.constraints.some((c).toBeTruthy() => /不要引入新依�?.test(c)));
      // 去重:同一「必须用 JWT」只出现一�?      const jwtHits = info.constraints.filter((c) => /必须�?JWT/.test(c)).length;
      expect(jwtHits).toBe(1);
  });

  test('classify:疑问 / 含代�?标志�?, () => {
      expect(ps.classify('这段代码为什么会崩？').isQuestion).toBe(true);
      expect(ps.classify('看看这个\n```js\nconst a=1\n```').hasCode).toBe(true);
      expect(ps.classify('普通一句话').hasCode).toBe(false);
  });

  test('classify:坏输入不�?, () => {
      expect(() => ps.classify(undefined).not.toThrow());
      expect(() => ps.classify(null).not.toThrow());
      expect(() => ps.classify(123).not.toThrow());
      expect(ps.classify('').taskType).toBe('general');
  });

  test('classify:关键动作跳过纯问候开�?取首个实质句(不再截成「你好�?', () => {
      const info = ps.classify('你好，那么我要实现一个登录接�?);
      assert.notEqual(info.action, '你好', '关键动作绝不能只剩问候语');
      expect(/实现|登录/.test(info.action)).toBeTruthy();
  });

  test('classify:关键动作不再按逗号截断(取到整个首句)', () => {
      // 无问�?首句含逗号:旧实现会截到第一个逗号�?新实现取到句末标点�?      const info = ps.classify('修复登录报错，顺便清理无用日志�?);
      expect(info.action.includes('清理')).toBeTruthy();
  });

  test('classify:整段皆问�?�?退回首句兜�?不空)', () => {
      const info = ps.classify('你好');
      expect(info.action && info.action !== '(见内�?').toBeTruthy();
  });

  test('classify:问候式问句不被误判为纯问�?实质诉求保留)', () => {
      // 「你好吗?能不能帮我…」——首句是问句而非纯问�?应原样保留为关键动作�?      const info = ps.classify('你好吗？能不能帮我写个函�?);
      assert.ok(
        /你好吗|帮我|函数/.test(info.action),
        `实质问句不该被当纯问候丢�?实得: ${info.action}`
      );
  });

  test('buildStructuredPrompt:问候开场的短请�?�?不出冗余「关键动作」行,但原�?含问�?逐字保留', () => {
      const original = '你好，帮我实现一个登录接口，必须�?JWT，不要存明文密码';
      const out = ps.buildStructuredPrompt(original, {});
      expect(out).toBeTruthy();
      expect(out.includes(original)).toBeTruthy();
      // 短请求的「关键动作�? 下方内容的逐字复述 �?纯冗�?不再发行(问候语更不该作为动作出�?
      expect(!out.includes('- 关键动作:')).toBeTruthy();
      expect(!out.includes('关键动作: 你好')).toBeTruthy();
  });

  test('buildStructuredPrompt:门开 + 值得结构�?�?产「结�?+ 内容」且原文逐字保留', () => {
      const original = '帮我写一个排序函数，必须用递归，不要用内置 sort';
      const out = ps.buildStructuredPrompt(original, {});
      expect(typeof out === 'string').toBeTruthy();
      expect(out.startsWith(ps.STRUCTURE_MARKER).toBeTruthy());
      expect(out).toContain('## 结构 / Structure');
      expect(out).toContain('## 内容 / Content');
      expect(out).toContain('任务类型:');
      expect(out).toContain('期望产出:');
      // 原文逐字包含(绝不改写/删减)
      expect(out.includes(original)).toBeTruthy();
  });

  test('buildStructuredPrompt:门关 �?�?null(接线处逐字节回退,保持原文)', () => {
      expect(ps.buildStructuredPrompt('随便什�?, { KHY_PROMPT_STRUCTURING: 'off' })).toBe(null);
      assert.equal(
        ps.buildStructuredPrompt('随便什�?, { KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' }),
        null
      );
  });

  test('buildStructuredPrompt:空输�?/ 纯空�?�?�?null(无可结构�?', () => {
      expect(ps.buildStructuredPrompt('', {})).toBe(null);
      expect(ps.buildStructuredPrompt('   \n\t ', {})).toBe(null);
  });

  test('buildStructuredPrompt:幂等——已结构化的消息不再二次包裹', () => {
      const once = ps.buildStructuredPrompt('帮我写一个排序函数，必须用递归，不要用内置 sort', {});
      expect(once).toBeTruthy();
      const twice = ps.buildStructuredPrompt(once, {});
      expect(twice).toBe(null);
  });

  test('buildStructuredPrompt:坏输�?�?�?null 不抛', () => {
      expect(() => ps.buildStructuredPrompt(undefined, {}).not.toThrow());
      expect(ps.buildStructuredPrompt(undefined, {})).toBe(null);
      expect(ps.buildStructuredPrompt(42, {})).toBe(null);
  });

  test('isWorthStructuring:纯问�?/ 极短 / 清晰单命�?�?false(不值得,保持原样)', () => {
      for (const t of [
        '你好',
        '您好',
        'hi',
        'hello',
        '谢谢',
        '好的',
        '�?,
        '帮我改个错别�?,
        '写个函数',
      ]) {
        expect(ps.isWorthStructuring(t)).toBe(false);
      }
  });

  test('isWorthStructuring:多约�?/ 多步 / 长请�?/ 含代�?�?true(值得)', () => {
      expect(ps.isWorthStructuring('实现一个登录接口，必须�?JWT，不要存明文密码')).toBe(true);
      assert.equal(
        ps.isWorthStructuring('先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖'),
        true
      );
      assert.equal(
        ps.isWorthStructuring('看看这个\n```js\nconst a=1\n```\n帮我优化一下这段逻辑'),
        true
      );
  });

  test('isWorthStructuring:坏输入不�?一律保守取 false', () => {
      for (const v of [undefined, null, 123, {}, '', '   ']) {
        expect(() => ps.isWorthStructuring(v).not.toThrow());
        expect(ps.isWorthStructuring(v)).toBe(false);
      }
  });

  test('buildStructuredPrompt:不值得结构化的消息 �?�?null(接线处保持用户原�?�?token)', () => {
      // 纯问�?/ 清晰单命�?不套结构,原样发送�?      expect(ps.buildStructuredPrompt('你好', {})).toBe(null);
      expect(ps.buildStructuredPrompt('帮我修复登录报错', {})).toBe(null);
      // 截图里那句随口的元问题也不再被结构化——正是省 token 的期望结果�?      assert.equal(
        ps.buildStructuredPrompt('你好，那么我发送你好，结构化处理后发送给你提示词变成了什么样', {}),
        null
      );
  });

  test('格式:表头压缩为单�?第二行是空行,不再是第二行元解释散�?', () => {
      const out = ps.buildStructuredPrompt('实现一个登录接口，必须�?JWT，不要存明文密码', {});
      const lines = out.split('\n');
      expect(lines[0].startsWith(ps.STRUCTURE_MARKER)).toBeTruthy();
      expect(lines[1]).toBe('');
      assert.ok(
        lines[0].includes('以�?# 内容」原文为�?) || lines[0].includes('原文为准'),
        '表头保留"冲突以原文为�?语义'
      );
  });

  test('格式:instance 请求 �?无「抽象层级」行、无资产透镜(缺省作用域不�?token)', () => {
      const out = ps.buildStructuredPrompt('实现一个登录接口，必须�?JWT，不要存明文密码', {});
      expect(!out.includes('抽象层级:')).toBeTruthy();
      assert.ok(
        !out.includes('## 复用性判�?),
        'instance 作用域不发资产透镜(其首问对一次性请求是噪声)'
      );
      // 但带正信号的行都�?      expect(out.includes('- 约束:')).toBeTruthy();
      expect(out.includes('- 任务类型:') && out.includes('- 期望产出:')).toBeTruthy();
  });

  test('格式:category 请求 �?有「抽象层级」行 + 资产透镜(其核心取舍在此才是活问题)', () => {
      const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', {});
      expect(out.includes('抽象层级:')).toBeTruthy();
      expect(out.includes('可复用类�?猫科动物).toBeTruthy()'));
      expect(out.includes('## 复用性判�?)).toBeTruthy();
  });

  test('格式:轻量请求不出「关键动作」行(= 下方内容的逐字复述,纯冗�?', () => {
      const out = ps.buildStructuredPrompt('实现一个登录接口，必须�?JWT，不要存明文密码', {});
      expect(out).toContain('## 结构');
      expect(!out.includes('- 关键动作:')).toBeTruthy();
      // 派生信号�?原文里本没有�?仍在
      expect(out.includes('- 任务类型:') && out).toContain('- 期望产出:');
  });

  test('格式:代码�?spec 不发「HAS_CODE false」噪�?仅含代码时发 true)', () => {
      const noCode = ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖', {});
      expect(noCode).toContain('```spec');
      expect(!noCode.includes('HAS_CODE')).toBeTruthy();
  });

  test('classify:抽象层级——显式成类线�?�?category(猫科动物)', () => {
      expect(ps.classify('给所有接口统一加限�?).scope).toBe('category');
      expect(ps.classify('以后每个函数都要带类型注�?).scope).toBe('category');
      expect(ps.classify('make this reusable for any input').scope).toBe('category');
  });

  test('classify:抽象层级——一次性线�?或缺�?�?instance(这只�?', () => {
      expect(ps.classify('修复这个函数的报�?).scope).toBe('instance');
      expect(ps.classify('把当前文件格式化一�?).scope).toBe('instance');
      expect(ps.classify('随便写点什�?).scope).toBe('instance'); // 缺省
      // 同时含成类与一次性线索时,一次性线索占�?保守�?instance,不为通用而通用)
      expect(ps.classify('把这个文件里所有函数都改一�?).scope).toBe('instance');
  });

  test('classify:scopeLabel �?scope 一�?, () => {
      expect(ps.classify('给所有模块加日志').scopeLabel).toMatch(/猫科动物/);
      expect(ps.classify('修这一�?).scopeLabel).toMatch(/这只�?);
  });

  test('classify:抽象层级——遗漏的 instance marker 回归(�?这时/我的)', () => {
      // E-001: �?+ 非列表后缀 应被识别�?instance
      expect(ps.classify('修该方法里的所有bug').scope).toBe('instance');
      expect(ps.classify('改该接口的参�?).scope).toBe('instance');
      // E-002: �?+ 非列表后缀 应被识别�?instance
      expect(ps.classify('这时统一加限�?).scope).toBe('instance');
      expect(ps.classify('这样�?).scope).toBe('instance');
      expect(ps.classify('这些文件').scope).toBe('instance');
      // E-003: 我的 应被识别�?instance
      expect(ps.classify('修我的所有代�?).scope).toBe('instance');
  });

  test('assetLensEnabled:默认开;子门�?/ 父门控任一显式�?�?�?, () => {
      expect(ps.assetLensEnabled({})).toBe(true);
      expect(ps.assetLensEnabled({ KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off' })).toBe(false);
      // 父关 �?子必�?注册�?resolver 与手写回退都成�?
      expect(ps.assetLensEnabled({ KHY_PROMPT_STRUCTURING: 'off' })).toBe(false);
      expect(ps.assetLensEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' })).toBe(false);
      assert.equal(
        ps.assetLensEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING_ASSET_LENS: '0' }),
        false
      );
  });

  test('ASSET_LENS:冻结常量含三条判断标�?可复用�?场景�?工作�?', () => {
      expect(typeof ps.ASSET_LENS).toBe('string');
      expect(ps.ASSET_LENS).toContain('猫科动物');
      expect(ps.ASSET_LENS).toContain('搭建舞台');
      expect(ps.ASSET_LENS).toContain('消灭试错');
      expect(ps.ASSET_LENS).toContain('不为通用而通用');
  });

  test('buildAssetLens:门开 �?返透镜;门关 �?空串', () => {
      expect(ps.buildAssetLens({})).toBe(ps.ASSET_LENS);
      expect(ps.buildAssetLens({ KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off' })).toBe('');
  });

  test('buildStructuredPrompt:门开含「抽象层级」行 + 附「复用性判断」透镜�?, () => {
      const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', {});
      expect(out).toContain('抽象层级:');
      expect(out.includes('可复用类�?猫科动物).toBeTruthy()'));
      expect(out).toContain('## 复用性判�?/ Asset Lens');
      expect(out).toContain('消灭试错');
      // 内容段仍在透镜之后,原文逐字保留
      expect(out.indexOf('## 复用性判�?).toBeTruthy() < out.indexOf('## 内容 / Content'));
      expect(out).toContain('给所有接口统一加限流，必须可配置，不要影响现有逻辑');
  });

  test('buildStructuredPrompt:子门控关 �?无透镜�?逐字节回退到基础结构�?仍保留抽象层级行)', () => {
      const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', {
        KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off',
      });
      expect(typeof out === 'string').toBeTruthy();
      expect(out.startsWith(ps.STRUCTURE_MARKER).toBeTruthy());
      expect(out.includes('抽象层级:')).toBeTruthy();
      expect(!out.includes('## 复用性判�?)).toBeTruthy();
  });

  test('buildStructuredPrompt:父门控关 �?整个结构化返 null(透镜随父一起消�?', () => {
      assert.equal(
        ps.buildStructuredPrompt('给所有接口统一加限�?, { KHY_PROMPT_STRUCTURING: 'off' }),
        null
      );
  });

  test('isComplex:简单短请求 �?false;多约�?多动�?长请�?�?true', () => {
      expect(ps.isComplex('写个函数')).toBe(false);
      expect(ps.isComplex('帮我改一�?)).toBe(false);
      // 多约�?+ 多动�?      expect(ps.isComplex('先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖')).toBe(true);
      // �?+ 多从�?      assert.equal(
        ps.isComplex('重构支付模块。第一步抽出金额计算。第二步补单元测试。必须保持对外契约不变�?),
        true
      );
  });

  test('isComplex:坏输入不�?, () => {
      expect(() => ps.isComplex(undefined).not.toThrow());
      expect(() => ps.isComplex(null).not.toThrow());
      expect(ps.isComplex(123)).toBe(false);
  });

  test('codeSpecEnabled:默认开;�?/ 父门控任一显式�?�?�?, () => {
      expect(ps.codeSpecEnabled({})).toBe(true);
      expect(ps.codeSpecEnabled({ KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off' })).toBe(false);
      expect(ps.codeSpecEnabled({ KHY_PROMPT_STRUCTURING: 'off' })).toBe(false); // 父关→子必关
      expect(ps.codeSpecEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' })).toBe(false);
  });

  test('buildCodeSpec:简单任�?�?空串(仅复杂任务代码化,不加�?', () => {
      expect(ps.buildCodeSpec('写个函数', {})).toBe('');
  });

  test('buildCodeSpec:门关 �?空串;坏输�?�?空串不抛', () => {
      assert.equal(
        ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须�?JWT', {
          KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off',
        }),
        ''
      );
      expect(() => ps.buildCodeSpec(undefined, {}).not.toThrow());
      expect(ps.buildCodeSpec(undefined, {})).toBe('');
  });

  test('buildStructuredPrompt:值得结构化但不复�?�?有结构段、无代码化段', () => {
      // 达到结构化门(2 约束→打�?1)但未达代码化�?打分<2):应有 ## 结构、无 ## 代码化�?      const out = ps.buildStructuredPrompt('实现一个登录接口，必须�?JWT，不要存明文密码', {});
      expect(out.startsWith(ps.STRUCTURE_MARKER).toBeTruthy());
      expect(out.includes('## 结构')).toBeTruthy();
      expect(!out.includes('## 代码�?)).toBeTruthy();
  });

  test('buildStructuredPrompt:代码化子门控�?�?�?spec �?逐字节回退,结构+透镜+内容仍在)', () => {
      const complex = '先创建用户表，然后实现登录接口，必须�?JWT，不要引入新依赖';
      const out = ps.buildStructuredPrompt(complex, { KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off' });
      expect(typeof out === 'string').toBeTruthy();
      expect(!out.includes('## 代码�?)).toBeTruthy();
      expect(out.includes('## 结构')).toBeTruthy();
      expect(out.includes(complex)).toBeTruthy();
  });

});

