'use strict';

/**
 * sessionForkPlan.test.js — 纯叶子 `/fork` 逻辑契约(node:test,零 IO)。
 *
 * 锁定:parseForkArgs(--at/标题/缺值)、deriveForkTitle(显式/源+后缀/空/不重复叠加)、
 * buildForkState(净化身份字段 uuid/parentUuid/_khyTrace、保留 role/content + 旗标、
 * forkedFrom 元数据、空/无消息→null)、门控梯。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseForkArgs,
  deriveForkTitle,
  buildForkState,
  isEnabled,
  _FORK_SUFFIX,
  _DEFAULT_FORK_TITLE,
} = require('../../../src/services/session/sessionForkPlan');

describe('parseForkArgs', () => {
  test('空参 → 无标题无 leaf,valid', () => {
    assert.deepEqual(parseForkArgs([]), { title: '', leafUuid: null, valid: true, parseError: null });
    assert.deepEqual(parseForkArgs(undefined), { title: '', leafUuid: null, valid: true, parseError: null });
  });
  test('纯标题', () => {
    const r = parseForkArgs(['探索', '另一条', '路']);
    assert.equal(r.title, '探索 另一条 路');
    assert.equal(r.leafUuid, null);
    assert.ok(r.valid);
  });
  test('--at <uuid> 抽出 leafUuid,其余为标题', () => {
    const r = parseForkArgs(['--at', 'abc123', '回测', '分支']);
    assert.equal(r.leafUuid, 'abc123');
    assert.equal(r.title, '回测 分支');
  });
  test('-a 别名与 --at= 形式', () => {
    assert.equal(parseForkArgs(['-a', 'u1']).leafUuid, 'u1');
    assert.equal(parseForkArgs(['--at=u2', 'x']).leafUuid, 'u2');
    assert.equal(parseForkArgs(['--at=u2', 'x']).title, 'x');
  });
  test('--at 缺值(后接 flag 或末尾)→ parseError', () => {
    assert.equal(parseForkArgs(['--at']).valid, false);
    assert.equal(parseForkArgs(['--at']).parseError, 'missing_leaf_uuid');
    assert.equal(parseForkArgs(['--at', '--foo']).valid, false);
    assert.equal(parseForkArgs(['--at=']).valid, false);
  });
});

describe('deriveForkTitle', () => {
  test('显式标题优先', () => {
    assert.equal(deriveForkTitle('原标题', '我的分叉'), '我的分叉');
  });
  test('无显式 → 源标题 + " (fork)"', () => {
    assert.equal(deriveForkTitle('量化策略', ''), '量化策略' + _FORK_SUFFIX);
    assert.equal(deriveForkTitle('量化策略'), '量化策略' + _FORK_SUFFIX);
  });
  test('源也空 → 默认标题', () => {
    assert.equal(deriveForkTitle('', ''), _DEFAULT_FORK_TITLE);
    assert.equal(deriveForkTitle(null, null), _DEFAULT_FORK_TITLE);
  });
  test('源已带 " (fork)" 后缀 → 不重复叠加', () => {
    assert.equal(deriveForkTitle('量化策略' + _FORK_SUFFIX, ''), '量化策略' + _FORK_SUFFIX);
  });
});

describe('buildForkState', () => {
  const snapshot = {
    sessionId: 'src-001',
    title: '源会话',
    model: 'claude-opus-4-8',
    metadata: { cwd: '/proj', custom: 1 },
    messages: [
      { role: 'user', content: '你好', uuid: 'u1', parentUuid: null, timestamp: 111, _khyTrace: { x: 1 } },
      { role: 'assistant', content: '在', uuid: 'u2', parentUuid: 'u1', timestamp: 222, _khyProvenance: { y: 2 } },
      { role: 'user', content: '继续', uuid: 'u3', parentUuid: 'u2', timestamp: 333, isMeta: true, isCompactSummary: true },
    ],
  };

  test('剥离身份/溯源字段,只留 role/content + 旗标', () => {
    const st = buildForkState({ snapshot, forkedAt: 999 });
    assert.equal(st.messages.length, 3);
    for (const m of st.messages) {
      assert.equal('uuid' in m, false);
      assert.equal('parentUuid' in m, false);
      assert.equal('timestamp' in m, false);
      assert.equal('_khyTrace' in m, false);
      assert.equal('_khyProvenance' in m, false);
      assert.ok('role' in m && 'content' in m);
    }
    // 语义旗标保留
    assert.equal(st.messages[2].isMeta, true);
    assert.equal(st.messages[2].isCompactSummary, true);
    // 非旗标消息不带 isMeta
    assert.equal('isMeta' in st.messages[0], false);
  });
  test('标题派生 + model 透传 + forkedFrom/forkedAt 元数据', () => {
    const st = buildForkState({ snapshot, forkedAt: 999 });
    assert.equal(st.title, '源会话' + _FORK_SUFFIX);
    assert.equal(st.model, 'claude-opus-4-8');
    assert.equal(st.metadata.forkedFrom, 'src-001');
    assert.equal(st.metadata.forkedAt, 999);
    assert.equal(st.metadata.cwd, '/proj'); // 既有元数据保留
    assert.equal(st.metadata.custom, 1);
  });
  test('显式标题覆盖', () => {
    const st = buildForkState({ snapshot, title: '岔路 A', forkedAt: 1 });
    assert.equal(st.title, '岔路 A');
  });
  test('非有限 forkedAt → 不写 forkedAt', () => {
    const st = buildForkState({ snapshot });
    assert.equal('forkedAt' in st.metadata, false);
  });
  test('空/无消息 → null(绝不写空会话)', () => {
    assert.equal(buildForkState({ snapshot: null }), null);
    assert.equal(buildForkState({ snapshot: { messages: [] } }), null);
    assert.equal(buildForkState({ snapshot: { title: 'x' } }), null);
    assert.equal(buildForkState({}), null);
  });
  test('坏消息条目被跳过', () => {
    const st = buildForkState({ snapshot: { sessionId: 's', messages: [null, 'str', { role: 'user', content: 'ok' }] } });
    assert.equal(st.messages.length, 1);
    assert.equal(st.messages[0].content, 'ok');
  });
});

describe('门控 isEnabled', () => {
  test('默认 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_FORK: 'true' }), true);
    assert.equal(isEnabled(undefined), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_FORK: v }), false);
    }
  });
});

describe('刀 2:fork 槽继承(slots)', () => {
  const base = {
    sessionId: 'parent',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { insight: '父的待读', memory: '父的外向摘要', systemPrompt: '你是助手', other: 1 },
  };

  test('不传 slots → 字节回退(legacy:父槽原样展开)', () => {
    const st = buildForkState({ snapshot: base });
    assert.equal(st.metadata.insight, '父的待读');
    assert.equal(st.metadata.memory, '父的外向摘要');
    assert.equal(st.metadata.systemPrompt, '你是助手');
    assert.equal(st.metadata.other, 1);
    assert.equal(st.metadata.forkedFrom, 'parent');
  });

  test('slots.enabled inherit → 清空 insight/memory,保留 systemPrompt', () => {
    const st = buildForkState({ snapshot: base, slots: { enabled: true, policy: 'inherit' } });
    assert.equal(st.metadata.insight, undefined, 'insight 一次性收件箱不继承');
    assert.equal(st.metadata.memory, undefined, 'memory 外向摘要不冒领');
    assert.equal(st.metadata.systemPrompt, '你是助手', 'inherit 保留父 systemPrompt');
    assert.equal(st.metadata.other, 1, '其它元数据保留');
    assert.equal(st.metadata.forkedFrom, 'parent');
  });

  test('slots.enabled 默认 policy(未给)= inherit', () => {
    const st = buildForkState({ snapshot: base, slots: { enabled: true } });
    assert.equal(st.metadata.insight, undefined);
    assert.equal(st.metadata.memory, undefined);
    assert.equal(st.metadata.systemPrompt, '你是助手');
  });

  test('policy none → 三槽全清(仅 history 继承)', () => {
    const st = buildForkState({ snapshot: base, slots: { enabled: true, policy: 'none' } });
    assert.equal(st.metadata.insight, undefined);
    assert.equal(st.metadata.memory, undefined);
    assert.equal(st.metadata.systemPrompt, undefined);
    assert.equal(st.metadata.forkedFrom, 'parent');
  });

  test('薄壳传入 merged systemPrompt → 覆盖父', () => {
    const st = buildForkState({
      snapshot: base,
      slots: { enabled: true, policy: 'inherit', systemPrompt: 'D\n\n你是助手\n\nF' },
    });
    assert.equal(st.metadata.systemPrompt, 'D\n\n你是助手\n\nF');
    assert.equal(st.metadata.insight, undefined);
    assert.equal(st.metadata.memory, undefined);
  });

  test('slots.enabled=false → 不触发整理(字节回退)', () => {
    const st = buildForkState({ snapshot: base, slots: { enabled: false, policy: 'none' } });
    assert.equal(st.metadata.insight, '父的待读');
    assert.equal(st.metadata.memory, '父的外向摘要');
  });
});
