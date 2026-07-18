'use strict';

/**
 * promptStructurer.test.js — 用户提示词结构化处理纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 关 / 注册表委托)、TASK_TYPES 冻结(纯叶子不可变)、
 * classify(各任务类型命中 / general 兜底 / 约束抽取 / 疑问 / 含代码 / 坏输入不抛)、
 * buildStructuredPrompt(门开产「结构+内容」且**原文逐字保留** / 门关返 null 逐字节回退 /
 * 空输入返 null / 幂等不二次包裹 / 坏输入返 null 不抛)。零 IO、确定性——显式传 env。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ps = require('../promptStructurer');

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(ps.isEnabled({}), true);
  assert.equal(ps.isEnabled({ KHY_PROMPT_STRUCTURING: '1' }), true);
  assert.equal(ps.isEnabled({ KHY_PROMPT_STRUCTURING: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(ps.isEnabled({ KHY_PROMPT_STRUCTURING: v }), false, v);
  }
});

test('isEnabled:注册表关时回退私有 _off 判定(逐字节等价)', () => {
  assert.equal(ps.isEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(ps.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: 'off' }), false);
});

test('TASK_TYPES:冻结(纯叶子不可变),元素与 patterns 均冻结', () => {
  assert.ok(Object.isFrozen(ps.TASK_TYPES));
  for (const t of ps.TASK_TYPES) {
    assert.ok(Object.isFrozen(t), `${t.key} frozen`);
    assert.ok(typeof t.key === 'string' && t.label && t.output && Array.isArray(t.patterns));
  }
});

test('classify:各任务类型按线索命中', () => {
  assert.equal(ps.classify('帮我修复这个报错').taskType, 'debug');
  assert.equal(ps.classify('写一个函数实现快排').taskType, 'code');
  assert.equal(ps.classify('调研一下最新的向量数据库').taskType, 'research');
  assert.equal(ps.classify('设计一个方案').taskType, 'plan');
  assert.equal(ps.classify('解释一下什么是闭包').taskType, 'explain');
  assert.equal(ps.classify('写一篇文档总结这个模块').taskType, 'write');
});

test('classify:都不命中 → general 兜底', () => {
  assert.equal(ps.classify('今天天气不错啊').taskType, 'general');
});

test('classify:抽取显式约束从句(去重、限量)', () => {
  const info = ps.classify('实现登录；必须用 JWT；不要引入新依赖；必须用 JWT');
  assert.ok(info.constraints.length >= 2);
  assert.ok(info.constraints.some((c) => /JWT/.test(c)));
  assert.ok(info.constraints.some((c) => /不要引入新依赖/.test(c)));
  // 去重:同一「必须用 JWT」只出现一次
  const jwtHits = info.constraints.filter((c) => /必须用 JWT/.test(c)).length;
  assert.equal(jwtHits, 1);
});

test('classify:疑问 / 含代码 标志位', () => {
  assert.equal(ps.classify('这段代码为什么会崩？').isQuestion, true);
  assert.equal(ps.classify('看看这个\n```js\nconst a=1\n```').hasCode, true);
  assert.equal(ps.classify('普通一句话').hasCode, false);
});

test('classify:坏输入不抛', () => {
  assert.doesNotThrow(() => ps.classify(undefined));
  assert.doesNotThrow(() => ps.classify(null));
  assert.doesNotThrow(() => ps.classify(123));
  assert.equal(ps.classify('').taskType, 'general');
});

// ── 关键动作抽取(回归:问候开场不该吞掉真实诉求)──────────────────────────
// bug:「你好,那么我要做 X」旧实现按逗号切句,关键动作被截成「你好」,看着像原文被丢弃
//(实则 ## 内容 原文一字未动)。修:只按句末标点切句 + 跳过纯问候开场句。
test('classify:关键动作跳过纯问候开场,取首个实质句(不再截成「你好」)', () => {
  const info = ps.classify('你好，那么我要实现一个登录接口');
  assert.notEqual(info.action, '你好', '关键动作绝不能只剩问候语');
  assert.ok(/实现|登录/.test(info.action), `关键动作应反映真实诉求,实得: ${info.action}`);
});

test('classify:关键动作不再按逗号截断(取到整个首句)', () => {
  // 无问候,首句含逗号:旧实现会截到第一个逗号止,新实现取到句末标点。
  const info = ps.classify('修复登录报错，顺便清理无用日志。');
  assert.ok(info.action.includes('清理'), `关键动作应含逗号后内容,实得: ${info.action}`);
});

test('classify:整段皆问候 → 退回首句兜底(不空)', () => {
  const info = ps.classify('你好');
  assert.ok(info.action && info.action !== '(见内容)', `纯问候仍应有兜底动作,实得: ${info.action}`);
});

test('classify:问候式问句不被误判为纯问候(实质诉求保留)', () => {
  // 「你好吗?能不能帮我…」——首句是问句而非纯问候,应原样保留为关键动作。
  const info = ps.classify('你好吗？能不能帮我写个函数');
  assert.ok(/你好吗|帮我|函数/.test(info.action), `实质问句不该被当纯问候丢弃,实得: ${info.action}`);
});

test('buildStructuredPrompt:问候开场的短请求 → 不出冗余「关键动作」行,但原文(含问候)逐字保留', () => {
  const original = '你好，帮我实现一个登录接口，必须用 JWT，不要存明文密码';
  const out = ps.buildStructuredPrompt(original, {});
  assert.ok(out, '多约束请求应被结构化');
  assert.ok(out.includes(original), '## 内容 必须逐字保留用户原文(含开场问候)');
  // 短请求的「关键动作」= 下方内容的逐字复述 → 纯冗余,不再发行(问候语更不该作为动作出现)
  assert.ok(!out.includes('- 关键动作:'), '短请求不出关键动作行(与内容重复)');
  assert.ok(!out.includes('关键动作: 你好'), '问候语绝不作为关键动作出现');
});

test('buildStructuredPrompt:门开 + 值得结构化 → 产「结构 + 内容」且原文逐字保留', () => {
  const original = '帮我写一个排序函数，必须用递归，不要用内置 sort';
  const out = ps.buildStructuredPrompt(original, {});
  assert.ok(typeof out === 'string');
  assert.ok(out.startsWith(ps.STRUCTURE_MARKER));
  assert.ok(out.includes('## 结构 / Structure'));
  assert.ok(out.includes('## 内容 / Content'));
  assert.ok(out.includes('任务类型:'));
  assert.ok(out.includes('期望产出:'));
  // 原文逐字包含(绝不改写/删减)
  assert.ok(out.includes(original), '结构化结果必须原样包含用户原文');
});

test('buildStructuredPrompt:门关 → 返 null(接线处逐字节回退,保持原文)', () => {
  assert.equal(ps.buildStructuredPrompt('随便什么', { KHY_PROMPT_STRUCTURING: 'off' }), null);
  assert.equal(ps.buildStructuredPrompt('随便什么', { KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' }), null);
});

test('buildStructuredPrompt:空输入 / 纯空白 → 返 null(无可结构化)', () => {
  assert.equal(ps.buildStructuredPrompt('', {}), null);
  assert.equal(ps.buildStructuredPrompt('   \n\t ', {}), null);
});

test('buildStructuredPrompt:幂等——已结构化的消息不再二次包裹', () => {
  const once = ps.buildStructuredPrompt('帮我写一个排序函数，必须用递归，不要用内置 sort', {});
  assert.ok(once);
  const twice = ps.buildStructuredPrompt(once, {});
  assert.equal(twice, null, '带 STRUCTURE_MARKER 前缀的消息应被识别为已结构化');
});

test('buildStructuredPrompt:坏输入 → 返 null 不抛', () => {
  assert.doesNotThrow(() => ps.buildStructuredPrompt(undefined, {}));
  assert.equal(ps.buildStructuredPrompt(undefined, {}), null);
  assert.equal(ps.buildStructuredPrompt(42, {}), null);
});

// ── 成本感知门:结构化必须"挣回"其 token(没用则保持原样)──────────────────────
// /goal 2026-07-08:结构块是纯附加 token(## 内容 已含完整原文),给「你好」/清晰一句话套 200+ token
// 结构是纯浪费。只在任务够实质、结构前缀能在对话层少走试错时才包裹;否则原样(返 null,逐字节回退)。
test('isWorthStructuring:纯问候 / 极短 / 清晰单命令 → false(不值得,保持原样)', () => {
  for (const t of ['你好', '您好', 'hi', 'hello', '谢谢', '好的', '嗯', '帮我改个错别字', '写个函数']) {
    assert.equal(ps.isWorthStructuring(t), false, `「${t}」不该被结构化`);
  }
});

test('isWorthStructuring:多约束 / 多步 / 长请求 / 含代码 → true(值得)', () => {
  assert.equal(ps.isWorthStructuring('实现一个登录接口，必须用 JWT，不要存明文密码'), true);
  assert.equal(ps.isWorthStructuring('先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖'), true);
  assert.equal(ps.isWorthStructuring('看看这个\n```js\nconst a=1\n```\n帮我优化一下这段逻辑'), true);
});

test('isWorthStructuring:坏输入不抛,一律保守取 false', () => {
  for (const v of [undefined, null, 123, {}, '', '   ']) {
    assert.doesNotThrow(() => ps.isWorthStructuring(v));
    assert.equal(ps.isWorthStructuring(v), false);
  }
});

test('buildStructuredPrompt:不值得结构化的消息 → 返 null(接线处保持用户原文,省 token)', () => {
  // 纯问候 / 清晰单命令:不套结构,原样发送。
  assert.equal(ps.buildStructuredPrompt('你好', {}), null);
  assert.equal(ps.buildStructuredPrompt('帮我修复登录报错', {}), null);
  // 截图里那句随口的元问题也不再被结构化——正是省 token 的期望结果。
  assert.equal(ps.buildStructuredPrompt('你好，那么我发送你好，结构化处理后发送给你提示词变成了什么样', {}), null);
});

// ── 精简格式:表头单行 + 只发带正信号的行(缺省/不存在的行是零信息噪声,不发)────────────
// /goal 2026-07-08「优化结构化的格式和方法」:结构块每行都要挣回 token。表头压到 1 行;约束仅有时发、
// 含代码仅含时发、抽象层级仅成类时发;任务类型/关键动作/期望产出恒发。资产透镜只在 category 作用域发。
test('格式:表头压缩为单行(第二行是空行,不再是第二行元解释散文)', () => {
  const out = ps.buildStructuredPrompt('实现一个登录接口，必须用 JWT，不要存明文密码', {});
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith(ps.STRUCTURE_MARKER), '首行是标记 + 单行说明');
  assert.equal(lines[1], '', '第二行应为空行(表头仅一行)');
  assert.ok(lines[0].includes('以「## 内容」原文为准') || lines[0].includes('原文为准'), '表头保留"冲突以原文为准"语义');
});

test('格式:instance 请求 → 无「抽象层级」行、无资产透镜(缺省作用域不占 token)', () => {
  const out = ps.buildStructuredPrompt('实现一个登录接口，必须用 JWT，不要存明文密码', {});
  assert.ok(!out.includes('抽象层级:'), 'instance 作用域不发抽象层级行');
  assert.ok(!out.includes('## 复用性判断'), 'instance 作用域不发资产透镜(其首问对一次性请求是噪声)');
  // 但带正信号的行都在
  assert.ok(out.includes('- 约束:'), '有约束 → 发约束行');
  assert.ok(out.includes('- 任务类型:') && out.includes('- 期望产出:'), '任务类型/期望产出恒发');
});

test('格式:category 请求 → 有「抽象层级」行 + 资产透镜(其核心取舍在此才是活问题)', () => {
  const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', {});
  assert.ok(out.includes('抽象层级:'), 'category 作用域发抽象层级行');
  assert.ok(out.includes('可复用类别(猫科动物)'));
  assert.ok(out.includes('## 复用性判断'), 'category 作用域发资产透镜');
});

test('格式:无约束请求 → 不发「约束」行(不发"无显式约束"噪声)', () => {
  const out = ps.buildStructuredPrompt('创建用户表并实现登录接口，同时补上单元测试', {});
  assert.ok(out, '多动作请求应被结构化');
  assert.ok(!out.includes('- 约束:'), '无约束时不发约束行');
  assert.ok(!out.includes('无显式约束'), '不发"无显式约束"占位噪声');
});

test('格式:含代码 → 发「含代码/引用: 是」;不含 → 该行不出现(不发"否"噪声)', () => {
  // 轻量含代码请求(4 空格缩进码块,长度 <24 → 非复杂 → 走 bullet 路径)。
  const withCode = ps.buildStructuredPrompt('帮我看看这段\n    const a = 1', {});
  assert.ok(withCode.includes('含代码/引用: 是'), '含代码的轻量请求发该行');
  const noCode = ps.buildStructuredPrompt('实现一个登录接口，必须用 JWT，不要存明文密码', {});
  assert.ok(!noCode.includes('含代码/引用'), '不含代码时不发该行');
});

// ── 结构单一表示:同一份解析绝不出两遍(bullet 与 spec 字段完全重合即冗余)──────────────
test('格式:轻量请求不出「关键动作」行(= 下方内容的逐字复述,纯冗余)', () => {
  const out = ps.buildStructuredPrompt('实现一个登录接口，必须用 JWT，不要存明文密码', {});
  assert.ok(out.includes('## 结构'));
  assert.ok(!out.includes('- 关键动作:'), '轻量结构不再出关键动作行(与内容重复)');
  // 派生信号行(原文里本没有的)仍在
  assert.ok(out.includes('- 任务类型:') && out.includes('- 期望产出:'));
});

test('结构单一化:复杂任务只出 ```spec 一种结构,不再另出重复的 bullet', () => {
  const original = '先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖';
  const out = ps.buildStructuredPrompt(original, {});
  assert.ok(out.includes('```spec'), '复杂任务结构以声明式 spec 呈现');
  assert.ok(!out.includes('- 任务类型:'), 'spec 在则不再出重复的 bullet 结构(TASK 已含)');
  assert.ok(!out.includes('- 关键动作:'), '「主诉指针」由 spec 的 GOAL 承担,不再另出 bullet');
  assert.ok(out.includes('GOAL'), 'spec 保留 GOAL 作为主诉指针(未随 bullet 一起丢失)');
  assert.ok(out.includes(original), '原文逐字保留');
});

test('格式:代码化 spec 不发「HAS_CODE false」噪声(仅含代码时发 true)', () => {
  const noCode = ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖', {});
  assert.ok(noCode.includes('```spec'));
  assert.ok(!noCode.includes('HAS_CODE'), '不含代码的复杂任务:spec 不发 HAS_CODE 行');
});

// ── 提示词资产化:抽象层级 + 判断透镜 ─────────────────────────────────────

test('classify:抽象层级——显式成类线索 → category(猫科动物)', () => {
  assert.equal(ps.classify('给所有接口统一加限流').scope, 'category');
  assert.equal(ps.classify('以后每个函数都要带类型注解').scope, 'category');
  assert.equal(ps.classify('make this reusable for any input').scope, 'category');
});

test('classify:抽象层级——一次性线索(或缺省)→ instance(这只猫)', () => {
  assert.equal(ps.classify('修复这个函数的报错').scope, 'instance');
  assert.equal(ps.classify('把当前文件格式化一下').scope, 'instance');
  assert.equal(ps.classify('随便写点什么').scope, 'instance'); // 缺省
  // 同时含成类与一次性线索时,一次性线索占先(保守取 instance,不为通用而通用)
  assert.equal(ps.classify('把这个文件里所有函数都改一下').scope, 'instance');
});

test('classify:scopeLabel 与 scope 一致', () => {
  assert.match(ps.classify('给所有模块加日志').scopeLabel, /猫科动物/);
  assert.match(ps.classify('修这一处').scopeLabel, /这只猫/);
});

test('assetLensEnabled:默认开;子门控 / 父门控任一显式关 → 关', () => {
  assert.equal(ps.assetLensEnabled({}), true);
  assert.equal(ps.assetLensEnabled({ KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off' }), false);
  // 父关 → 子必关(注册表 resolver 与手写回退都成立)
  assert.equal(ps.assetLensEnabled({ KHY_PROMPT_STRUCTURING: 'off' }), false);
  assert.equal(ps.assetLensEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' }), false);
  assert.equal(ps.assetLensEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING_ASSET_LENS: '0' }), false);
});

test('ASSET_LENS:冻结常量含三条判断标准(可复用性/场景性/工作流)', () => {
  assert.equal(typeof ps.ASSET_LENS, 'string');
  assert.ok(ps.ASSET_LENS.includes('猫科动物'));
  assert.ok(ps.ASSET_LENS.includes('搭建舞台'));
  assert.ok(ps.ASSET_LENS.includes('消灭试错'));
  assert.ok(ps.ASSET_LENS.includes('不为通用而通用'));
});

test('buildAssetLens:门开 → 返透镜;门关 → 空串', () => {
  assert.equal(ps.buildAssetLens({}), ps.ASSET_LENS);
  assert.equal(ps.buildAssetLens({ KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off' }), '');
});

test('buildStructuredPrompt:门开含「抽象层级」行 + 附「复用性判断」透镜段', () => {
  const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', {});
  assert.ok(out.includes('抽象层级:'));
  assert.ok(out.includes('可复用类别(猫科动物)'));
  assert.ok(out.includes('## 复用性判断 / Asset Lens'));
  assert.ok(out.includes('消灭试错'));
  // 内容段仍在透镜之后,原文逐字保留
  assert.ok(out.indexOf('## 复用性判断') < out.indexOf('## 内容 / Content'));
  assert.ok(out.includes('给所有接口统一加限流，必须可配置，不要影响现有逻辑'));
});

test('buildStructuredPrompt:子门控关 → 无透镜段(逐字节回退到基础结构化,仍保留抽象层级行)', () => {
  const out = ps.buildStructuredPrompt('给所有接口统一加限流，必须可配置，不要影响现有逻辑', { KHY_PROMPT_STRUCTURING_ASSET_LENS: 'off' });
  assert.ok(typeof out === 'string');
  assert.ok(out.startsWith(ps.STRUCTURE_MARKER));
  assert.ok(out.includes('抽象层级:'), '抽象层级行是基础结构化的一部分,始终在');
  assert.ok(!out.includes('## 复用性判断'), '子门控关时不追加透镜段');
});

test('buildStructuredPrompt:父门控关 → 整个结构化返 null(透镜随父一起消失)', () => {
  assert.equal(ps.buildStructuredPrompt('给所有接口统一加限流', { KHY_PROMPT_STRUCTURING: 'off' }), null);
});

// ── 代码化提示词(复杂任务 → ```spec 声明式规格)────────────────────────────

test('isComplex:简单短请求 → false;多约束/多动作/长请求 → true', () => {
  assert.equal(ps.isComplex('写个函数'), false);
  assert.equal(ps.isComplex('帮我改一下'), false);
  // 多约束 + 多动作
  assert.equal(ps.isComplex('先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖'), true);
  // 长 + 多从句
  assert.equal(ps.isComplex('重构支付模块。第一步抽出金额计算。第二步补单元测试。必须保持对外契约不变。'), true);
});

test('isComplex:坏输入不抛', () => {
  assert.doesNotThrow(() => ps.isComplex(undefined));
  assert.doesNotThrow(() => ps.isComplex(null));
  assert.equal(ps.isComplex(123), false);
});

test('codeSpecEnabled:默认开;子 / 父门控任一显式关 → 关', () => {
  assert.equal(ps.codeSpecEnabled({}), true);
  assert.equal(ps.codeSpecEnabled({ KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off' }), false);
  assert.equal(ps.codeSpecEnabled({ KHY_PROMPT_STRUCTURING: 'off' }), false); // 父关→子必关
  assert.equal(ps.codeSpecEnabled({ KHY_FLAG_REGISTRY: '0', KHY_PROMPT_STRUCTURING: '0' }), false);
});

test('buildCodeSpec:复杂任务 + 门开 → 产 ```spec 规格(取自 classify 字段)', () => {
  const spec = ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖', {});
  assert.ok(spec.startsWith('```spec'));
  assert.ok(spec.trimEnd().endsWith('```'));
  assert.ok(spec.includes('TASK'));
  assert.ok(spec.includes('CONSTRAINTS'));
  assert.ok(spec.includes('JWT'));
  assert.ok(spec.includes('冲突以 ## 内容 为准') || spec.includes('冲突') , 'spec 须声明冲突以原文为准');
});

test('buildCodeSpec:简单任务 → 空串(仅复杂任务代码化,不加噪)', () => {
  assert.equal(ps.buildCodeSpec('写个函数', {}), '');
});

test('buildCodeSpec:门关 → 空串;坏输入 → 空串不抛', () => {
  assert.equal(ps.buildCodeSpec('先创建用户表，然后实现登录接口，必须用 JWT', { KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off' }), '');
  assert.doesNotThrow(() => ps.buildCodeSpec(undefined, {}));
  assert.equal(ps.buildCodeSpec(undefined, {}), '');
});

test('buildStructuredPrompt:复杂任务门开 → 结构段即用 ```spec(不再另出 bullet,单一表示)', () => {
  const original = '先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖';
  const out = ps.buildStructuredPrompt(original, {});
  assert.ok(out.includes('## 结构 / Structure'), '仍在统一的「## 结构」标题下');
  assert.ok(out.includes('```spec'), '复杂任务结构以声明式 spec 呈现');
  assert.ok(!out.includes('## 代码化'), '不再有独立「## 代码化」标题(已并入结构)');
  // spec 段落在结构标题之后、内容之前
  assert.ok(out.indexOf('## 结构') < out.indexOf('```spec'));
  assert.ok(out.indexOf('```spec') < out.indexOf('## 内容 / Content'));
  // 原文逐字保留
  assert.ok(out.includes(original));
});

test('buildStructuredPrompt:值得结构化但不复杂 → 有结构段、无代码化段', () => {
  // 达到结构化门(2 约束→打分 1)但未达代码化门(打分<2):应有 ## 结构、无 ## 代码化。
  const out = ps.buildStructuredPrompt('实现一个登录接口，必须用 JWT，不要存明文密码', {});
  assert.ok(out.startsWith(ps.STRUCTURE_MARKER));
  assert.ok(out.includes('## 结构'), '值得结构化的请求应有结构段');
  assert.ok(!out.includes('## 代码化'), '未达代码化门的请求不加 spec 段');
});

test('buildStructuredPrompt:代码化子门控关 → 无 spec 段(逐字节回退,结构+透镜+内容仍在)', () => {
  const complex = '先创建用户表，然后实现登录接口，必须用 JWT，不要引入新依赖';
  const out = ps.buildStructuredPrompt(complex, { KHY_PROMPT_STRUCTURING_CODE_SPEC: 'off' });
  assert.ok(typeof out === 'string');
  assert.ok(!out.includes('## 代码化'), '代码化子门控关时不追加 spec 段');
  assert.ok(out.includes('## 结构'), '基础结构化仍在');
  assert.ok(out.includes(complex), '原文仍逐字保留');
});
