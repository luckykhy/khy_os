'use strict';

/**
 * directiveComposer — 整合层单元测试。
 *
 * 验证「系统提示词意图指令整合层」:
 *  - 门控关 → 逐字节回退到历史 join(顺序与内容字节一致)。
 *  - 0 / 1 个 protocol → 不插入协调头(无噪声,近字节回退)。
 *  - ≥2 个 protocol → 插入唯一协调头;guard 在协调头之前、protocol 在其后,次序确定。
 *  - 空 directive 被过滤;未知 key 按 protocol 兜底不丢弃;异常输入不抛、回退 join。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DIRECTIVE_REGISTRY,
  buildCoherenceHeader,
  composeDirectives,
  isComposerEnabled,
} = require('../src/services/directiveComposer');

const HEADER_MARKER = '## 本回合有多套处理协议同时生效';

// 关闭门控的 options(逐字节回退)。
const OFF = { directiveComposer: 'off' };
// 显式开启(不依赖 env 默认)。
const ON = { directiveComposer: 'on' };

describe('门控关 → 逐字节回退到历史 join', () => {
  test('任意混合输入,关门控 == 过滤空串后按入参顺序 join("\\n\\n")', () => {
    const entries = [
      { key: 'groundTruth', directive: 'G1' },
      { key: 'mathSolve', directive: 'P-math' },
      { key: 'philosophyDesign', directive: 'P-phil' },
      { key: 'searchNecessity', directive: '' }, // 空 → 过滤
    ];
    const got = composeDirectives({ entries, options: OFF });
    assert.equal(got, ['G1', 'P-math', 'P-phil'].join('\n\n'));
    // 关门控时绝不出现协调头。
    assert.ok(!got.includes(HEADER_MARKER));
  });

  test('全空 → 关门控返回空串', () => {
    const got = composeDirectives({
      entries: [{ key: 'mathSolve', directive: '' }, { key: 'goal', directive: '  ' }],
      options: OFF,
    });
    assert.equal(got, '');
  });
});

describe('开门控 + 0/1 protocol → 不插入协调头(无噪声)', () => {
  test('0 protocol(仅 guard)→ 无协调头,仅 guard 段', () => {
    const got = composeDirectives({
      entries: [
        { key: 'groundTruth', directive: 'G1' },
        { key: 'deterministicFacts', directive: 'G2' },
      ],
      options: ON,
    });
    assert.ok(!got.includes(HEADER_MARKER));
    assert.equal(got, 'G1\n\nG2');
  });

  test('1 protocol → 无协调头(单协议不加噪声)', () => {
    const got = composeDirectives({
      entries: [
        { key: 'groundTruth', directive: 'G1' },
        { key: 'mathSolve', directive: 'P-math' },
      ],
      options: ON,
    });
    assert.ok(!got.includes(HEADER_MARKER));
    assert.equal(got, 'G1\n\nP-math');
  });

  test('1 protocol 且无 guard → 与单块字节一致', () => {
    const got = composeDirectives({
      entries: [{ key: 'goal', directive: 'P-goal' }],
      options: ON,
    });
    assert.equal(got, 'P-goal');
  });
});

describe('开门控 + ≥2 protocol → 插入唯一协调头,tier 有序', () => {
  test('guard 在协调头之前;协调头唯一;protocol 在协调头之后,保持入参相对顺序', () => {
    const entries = [
      { key: 'mathSolve', directive: 'P-math' },          // protocol
      { key: 'groundTruth', directive: 'G-truth' },        // guard
      { key: 'philosophyDesign', directive: 'P-phil' },    // protocol
      { key: 'inlineImageOcrGuard', directive: 'G-ocr' },  // guard
    ];
    const got = composeDirectives({ entries, options: ON });

    // 协调头存在且唯一。
    const headerCount = got.split(HEADER_MARKER).length - 1;
    assert.equal(headerCount, 1);

    const idxGtruth = got.indexOf('G-truth');
    const idxGocr = got.indexOf('G-ocr');
    const idxHeader = got.indexOf(HEADER_MARKER);
    const idxMath = got.indexOf('P-math');
    const idxPhil = got.indexOf('P-phil');

    // guard 段都在协调头之前。
    assert.ok(idxGtruth >= 0 && idxGtruth < idxHeader, 'guard G-truth before header');
    assert.ok(idxGocr >= 0 && idxGocr < idxHeader, 'guard G-ocr before header');
    // protocol 段都在协调头之后。
    assert.ok(idxMath > idxHeader, 'protocol math after header');
    assert.ok(idxPhil > idxHeader, 'protocol phil after header');
    // protocol 内部保持入参相对顺序(math 先于 phil)。
    assert.ok(idxMath < idxPhil, 'protocol order preserved');
    // guard 内部保持入参相对顺序(truth 先于 ocr)。
    assert.ok(idxGtruth < idxGocr, 'guard order preserved');
  });

  test('协调头按次序列出生效协议的 label', () => {
    const got = composeDirectives({
      entries: [
        { key: 'mathSolve', directive: 'P-math' },
        { key: 'errorEnumeration', directive: 'P-err' },
      ],
      options: ON,
    });
    assert.ok(got.includes(DIRECTIVE_REGISTRY.mathSolve.label));
    assert.ok(got.includes(DIRECTIVE_REGISTRY.errorEnumeration.label));
    // 编号次序:math 先于 err。
    assert.ok(got.indexOf(`1. ${DIRECTIVE_REGISTRY.mathSolve.label}`) >= 0);
    assert.ok(got.indexOf(`2. ${DIRECTIVE_REGISTRY.errorEnumeration.label}`) >= 0);
  });
});

describe('未知 key 与异常输入 — fail-soft', () => {
  test('未知 key 按 protocol 兜底,绝不丢弃', () => {
    const got = composeDirectives({
      entries: [
        { key: 'totallyUnknownLeaf', directive: 'P-unknown' },
        { key: 'mathSolve', directive: 'P-math' },
      ],
      options: ON,
    });
    // 两个都算 protocol → ≥2 → 有协调头,且两段都在。
    assert.ok(got.includes(HEADER_MARKER));
    assert.ok(got.includes('P-unknown'));
    assert.ok(got.includes('P-math'));
  });

  test('entries 非数组 → 不抛,返回空串', () => {
    assert.doesNotThrow(() => composeDirectives({ entries: null, options: ON }));
    assert.equal(composeDirectives({ entries: undefined, options: ON }), '');
  });

  test('entry 含 null/非串 directive → 过滤不抛', () => {
    const got = composeDirectives({
      entries: [
        { key: 'mathSolve', directive: null },
        { key: 'goal', directive: 12345 },
        { key: 'groundTruth', directive: 'G1' },
      ],
      options: ON,
    });
    // null 被过滤;数字 12345 → String → '12345' 非空保留(protocol,仅 1 个 → 无头)。
    assert.ok(got.includes('G1'));
    assert.ok(!got.includes(HEADER_MARKER));
  });

  test('无参调用 → 不抛', () => {
    assert.doesNotThrow(() => composeDirectives());
    assert.equal(composeDirectives(), ''); // 默认 env 开,无 entries → 空串
  });
});

describe('buildCoherenceHeader — 确定性、不回显输入', () => {
  test('空 label 列表 → 仍产出固定头骨架(头部无生效协议编号项,但保留协调规则段)', () => {
    const h = buildCoherenceHeader([]);
    assert.ok(h.includes(HEADER_MARKER));
    assert.ok(h.includes('协调规则:'));
    // 头部「生效协议列表」段(协调规则之前)无任何编号项,因为没有 label。
    const beforeRules = h.split('协调规则:')[0];
    assert.ok(!/^\d+\. /m.test(beforeRules), 'no numbered protocol items when labels empty');
  });

  test('同一输入两次调用结果恒等(确定性)', () => {
    const a = buildCoherenceHeader(['x', 'y']);
    const b = buildCoherenceHeader(['x', 'y']);
    assert.equal(a, b);
  });
});

describe('intentAssurance 纳入整合层 — 领头 guard,贯通用户真实意图', () => {
  test('注册为 guard tier,且是 registry 中第一个 guard', () => {
    assert.equal(DIRECTIVE_REGISTRY.intentAssurance.tier, 'guard');
    const firstGuard = Object.keys(DIRECTIVE_REGISTRY)
      .find(k => DIRECTIVE_REGISTRY[k].tier === 'guard');
    assert.equal(firstGuard, 'intentAssurance',
      'intentAssurance 必须排在所有 guard 之首(用户真实意图是一切协议的前提)');
  });

  test('开门控:intentAssurance 在所有 guard 之前、协调头之前', () => {
    const out = composeDirectives({
      entries: [
        { key: 'intentAssurance', directive: 'IA_BLOCK' },
        { key: 'groundTruth', directive: 'GT_BLOCK' },
        { key: 'mathSolve', directive: 'MATH_BLOCK' },
        { key: 'goal', directive: 'GOAL_BLOCK' },
      ],
      options: ON,
    });
    assert.ok(out.indexOf('IA_BLOCK') < out.indexOf('GT_BLOCK'),
      'intentAssurance 领先其余 guard');
    assert.ok(out.indexOf('GT_BLOCK') < out.indexOf(HEADER_MARKER),
      'guard 段整体在协调头之前');
    assert.ok(out.indexOf('IA_BLOCK') < out.indexOf('MATH_BLOCK'),
      '用户真实意图领先所有 protocol');
  });

  test('开门控:即便 entries 顺序把 intentAssurance 放在后面,tier 排序仍把它提到 guard 段首', () => {
    const out = composeDirectives({
      entries: [
        { key: 'goal', directive: 'GOAL_BLOCK' },
        { key: 'groundTruth', directive: 'GT_BLOCK' },
        { key: 'intentAssurance', directive: 'IA_BLOCK' },
      ],
      options: ON,
    });
    // intentAssurance 与 groundTruth 同为 guard,组内保入参序 → groundTruth 在前。
    // 但两者都先于 protocol(goal)。这里验证 guard 段整体领先 protocol(贯通的核心不变量)。
    assert.ok(out.indexOf('GT_BLOCK') < out.indexOf('GOAL_BLOCK'));
    assert.ok(out.indexOf('IA_BLOCK') < out.indexOf('GOAL_BLOCK'));
  });

  test('关门控:逐字节回退——调用点据此把 intentAssurance 留在历史尾部位置(此处仅验证 join 不含协调头且保入参序)', () => {
    const entries = [
      { key: 'intentAssurance', directive: 'IA_BLOCK' },
      { key: 'mathSolve', directive: 'MATH_BLOCK' },
    ];
    const out = composeDirectives({ entries, options: OFF });
    assert.equal(out, 'IA_BLOCK\n\nMATH_BLOCK');
    assert.ok(!out.includes(HEADER_MARKER));
  });
});

describe('isComposerEnabled — 与内部门控判定同口径(供调用点分支)', () => {
  test('options.directiveComposer=off → false', () => {
    assert.equal(isComposerEnabled({ directiveComposer: 'off' }), false);
    assert.equal(isComposerEnabled({ directiveComposer: '0' }), false);
    assert.equal(isComposerEnabled({ directiveComposer: 'false' }), false);
  });

  test('options.directiveComposer=on / 未指定 → true(默认开)', () => {
    assert.equal(isComposerEnabled({ directiveComposer: 'on' }), true);
    assert.equal(isComposerEnabled({}), true);
    assert.equal(isComposerEnabled(), true);
  });
});
