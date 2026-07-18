'use strict';

/**
 * testWritingPolicy.js — 纯叶子:教会 Khyos「怎么给项目写测试」的单一真源。
 *
 * 目标(goal 2026-06-28):「教会 khyos 怎么给项目写些测试」。当用户让 Khyos 为项目/模块/
 * 函数编写(或补充)测试时,注入一套确定性的**测试编写协议**,让产出的测试真实有效、可重复
 * 运行、真能抓住回归,而不是凑数 / assert(true) / 迁就当前(可能有 bug 的)输出。
 *
 * 先核实再动手(绝不重造):仓库的 `agents/constraints.js` `EXECUTION_DISCIPLINE` 已教「改完要
 * 跑测试/构建/lint **验证**」——那是「怎么用证据验证」;本叶子正交补的是「怎么**写**好测试」
 * 这条独立缺口(测试设计:对齐框架、测行为非实现、成体系覆盖、确定性隔离、有意义断言、跑出证据、
 * 诚实边界)。两者一个管「写」、一个管「验」,互不复制。
 *
 * 与既有意图叶子族(mathSolvePolicy / philosophyDesignResolver / nlActionResolver)同构:
 * detect → buildDirective → route,经 ai.js 三缝 + directiveComposer 注入系统提示词。
 *
 * 纯叶子:零 IO、确定性、绝不抛、fail-soft、单一真源。env 门控 KHY_TEST_WRITING(默认开;仅
 * 显式 0/false/off/no 关闭;关闭后 routeTestWriting 返回空指令 → 接缝字节回退,系统提示词逐字节
 * 不变)。不使用 eval / new Function。**它只教「怎么写测试」,绝不编造被测代码的事实。**
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  try {
    const v = (env || process.env || {}).KHY_TEST_WRITING;
    return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
  } catch {
    return true; // fail-soft:无法判定时维持默认开
  }
}

// ── 写测试意图识别(零假阳性优先;均为线性正则,无灾难性回溯)──────────────────────
// 判据 = 同时命中「写/补/生成 类动词」与「测试 类名词」。仅「运行测试 / 测试一下功能」这类
// 没有写作动词的句子不会命中(那是跑测试 / 试用,不是写测试)——这是刻意的零假阳性边界。
const _WRITE_RE = /(写|编写|添加|新增|补充|补上?|补全|补一?些|加上?|加个|加一?些|加点|写一?些|写个|写下|生成|创建|做个?|搞个?|整个?|来一?个|覆盖|write|writing|add|adding|create|creating|generate|author|cover)/i;
const _TEST_NOUN_RE = /(单元测试|集成测试|端到端测试|端到端|回归测试|测试用例|测试覆盖|覆盖率|单测|测试代码|测试脚本|测试套件|测试|用例|unit\s*tests?|integration\s*tests?|e2e\s*tests?|end[\s-]?to[\s-]?end|regression\s*tests?|test\s*cases?|test\s*coverage|test\s*suites?|\btests?\b|\bspecs?\b)/i;
// 强信号名词:即便写作动词措辞古怪,出现这些明确「编写测试」名词也算命中(仍需配合写作动词,
// 避免「运行单元测试」误命中——它没有写作动词)。此表用于题型(kind)细分。
const _KIND_INTEGRATION_RE = /(集成测试|integration\s*tests?)/i;
const _KIND_E2E_RE = /(端到端|e2e\s*tests?|end[\s-]?to[\s-]?end)/i;
const _KIND_UNIT_RE = /(单元测试|单测|unit\s*tests?)/i;

// 去掉代码块 / 行内代码,避免代码里的字样干扰意图识别。委托单一真源 utils/stripCodeSpans。
const _stripCode = require('../utils/stripCodeSpans');

/**
 * 识别一段文本是否为「写测试」意图,并给出测试类型(用于指令措辞/状态行)。零假阳性优先。
 * @param {string} text
 * @returns {{shouldInject:boolean, kinds:string[]}}
 */
function detectTestWritingIntent(text) {
  try {
    const cleaned = _stripCode(text);
    if (!cleaned.trim()) return { shouldInject: false, kinds: [] };
    if (!_TEST_NOUN_RE.test(cleaned) || !_WRITE_RE.test(cleaned)) {
      return { shouldInject: false, kinds: [] };
    }
    const kinds = [];
    if (_KIND_UNIT_RE.test(cleaned)) kinds.push('unit');
    if (_KIND_INTEGRATION_RE.test(cleaned)) kinds.push('integration');
    if (_KIND_E2E_RE.test(cleaned)) kinds.push('e2e');
    if (!kinds.length) kinds.push('general');
    return { shouldInject: true, kinds };
  } catch {
    return { shouldInject: false, kinds: [] };
  }
}

// ── 测试编写协议(注入系统提示词)────────────────────────────────────────────────
/**
 * 产出 [SYSTEM:] 测试编写协议指令。命中写测试意图才产出(否则空串)。
 * @param {object} args
 * @param {string[]} [args.kinds] 测试类型(detectTestWritingIntent 的结果)
 * @returns {string}
 */
function buildTestWritingDirective({ kinds = [] } = {}) {
  const lines = [
    '[SYSTEM: 测试编写协议]',
    '本轮要为项目编写(或补充)测试。目标是「测试真实有效 + 可重复运行 + 真能抓住回归」,绝不凑数。请遵循:',
    '1) 先对齐项目约定,绝不另起炉灶:先找现有测试(测试目录、文件命名、运行器/框架、断言库、fixture/mock 方式),',
    '   新测试与既有风格、位置、命名、运行方式保持一致。仓库已有测试框架时绝不引入第二套;不确定就先读一两个',
    '   现有测试再动手。',
    '2) 测行为,不测实现:针对公开契约、输入→输出、可观察的副作用断言,而非内部私有细节,这样重构不破坏测试。',
    '3) 覆盖成体系,不只测顺风路径:',
    '   · 正常路径(典型输入与预期结果);',
    '   · 边界值(空 / 0 / 1 / 最大 / 越界 / 超长 / 重复);',
    '   · 错误与异常路径(非法输入、依赖失败、超时——断言它**如何失败**,而不是只测成功);',
    '   · 关键不变量(状态前后一致、幂等、与顺序/并发无关——如适用)。',
    '4) 必须确定性、隔离、可重复:不依赖真实网络 / 时钟 / 随机 / 外部服务 / 真实文件系统——改用依赖注入、打桩、',
    '   临时目录、固定种子;绝不用 sleep 等固定墙钟去等异步,改用事件或轮询条件;测试之间不共享可变状态、',
    '   各自清理。坚决杜绝 flaky(时好时坏)的测试。',
    '5) 断言要有意义:每个测试聚焦一个行为,名字描述「条件 → 期望」;断言具体的值/结构,不写 assert(true)、',
    '   不只断言「没抛异常」;不要过度 mock 到最后只测了 mock 自己。',
    '6) 跑起来看证据:写完**实际运行**这些测试并展示真实的通过/失败输出;不能运行的测试不算测试。新写的测试',
    '   最好能先针对未实现 / 有 bug 的点**真实失败**,再因正确实现而变绿,以此证明它确实在断言。',
    '7) 诚实边界:测试通过只证明「被断言的那部分行为成立」,不等于整段代码正确;**绝不为了变绿把断言改成迁就',
    '   当前(可能有 bug 的)输出**——要断言「应有的」行为。覆盖不到或无法确定性验证的部分,如实说明。',
  ];
  if ((Array.isArray(kinds) ? kinds : []).some((k) => k === 'integration' || k === 'e2e')) {
    lines.push(
      '附(集成 / 端到端):跨组件用真实接线而非全打桩,但外部不可控边界(第三方网络、时钟、支付等)仍需在',
      '   确定性接缝处替身;给足建链/拆链(setup/teardown),确保可重复且互不污染。',
    );
  }
  return lines.join('\n');
}

/**
 * 编排:识别写测试意图并产出注入指令。镜像 routeMathSolve 的契约。
 * @param {object} args
 * @param {string}  args.text
 * @param {object}  [args.env]
 * @returns {{shouldInject:boolean, kinds:string[], directive:string}}
 */
function routeTestWriting({ text = '', env } = {}) {
  try {
    if (!isEnabled(env)) return { shouldInject: false, kinds: [], directive: '' };
    const det = detectTestWritingIntent(text);
    if (!det.shouldInject) return { shouldInject: false, kinds: [], directive: '' };
    return { shouldInject: true, kinds: det.kinds, directive: buildTestWritingDirective({ kinds: det.kinds }) };
  } catch {
    return { shouldInject: false, kinds: [], directive: '' };
  }
}

module.exports = {
  isEnabled,
  detectTestWritingIntent,
  buildTestWritingDirective,
  routeTestWriting,
};
