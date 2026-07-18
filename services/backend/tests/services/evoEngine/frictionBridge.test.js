'use strict';

/**
 * frictionBridge.test.js — evoEngine 接入活执行路径的适配器验收（协作而非替代）。
 *
 * 验证四件事：①工具失败 → 旁路观测铸造需求并落 observations 积压；②同一痛点签名有界
 * 去重；③fail-soft（脏输入/桥不可用绝不抛）；④端到端：真 executeTool 失败在 KHY_EVO_ENGINE=on
 * 下产出观测，且**不改变工具返回结果**（核心循环仍权威）。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-evobridge-test-${process.pid}`);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const bridge = require('../../../src/services/evoEngine/frictionBridge');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });
beforeEach(() => bridge._resetForTest());

describe('frictionBridge — 运行态痛点观测', () => {
  test('工具失败 → 铸造需求并落 observations 积压', () => {
    const before = bridge.pendingObservations().length;
    const r = bridge.observeFailure({
      signal: 'tool-failure',
      surface: 'dataParser',
      error: new Error('parser cannot handle format: unsupported'),
      context: { tool: 'dataParser', sessionId: 's1' },
    });
    assert.equal(r.observed, true);
    assert.ok(r.requirementId && r.requirementId.startsWith('evo_'));
    const after = bridge.pendingObservations();
    assert.equal(after.length, before + 1);
    const last = after[after.length - 1];
    assert.equal(last.kind, 'requirement');
    assert.equal(last.payload.source, 'runtime-friction');
    assert.equal(last.payload.surface, 'dataParser');
  });

  test('同一痛点签名有界去重 → 第二次不再落盘', () => {
    const friction = {
      signal: 'tool-failure', surface: 'sameTool',
      error: new Error('unsupported format at line 5'),
      context: { tool: 'sameTool' },
    };
    const first = bridge.observeFailure(friction);
    assert.equal(first.observed, true);
    const lenAfterFirst = bridge.pendingObservations().length;
    // 行号差异不应分裂签名（signatureOf 数字归一）。
    const second = bridge.observeFailure({ ...friction, error: new Error('unsupported format at line 99') });
    assert.equal(second.observed, false);
    assert.equal(second.deduped, true);
    assert.equal(second.requirementId, first.requirementId);
    assert.equal(bridge.pendingObservations().length, lenAfterFirst);
  });

  test('fail-soft：脏输入/空 friction 永不抛', () => {
    assert.doesNotThrow(() => bridge.observeFailure());
    assert.doesNotThrow(() => bridge.observeFailure({ error: null }));
    assert.doesNotThrow(() => bridge.observeFailure({ error: 'plain string failure', surface: 'x' }));
  });

  test('落盘记录链完整（沿 evoLedger 哈希链）', () => {
    bridge.observeFailure({ surface: 'a', error: new Error('unsupported one') });
    bridge.observeFailure({ surface: 'b', error: new Error('unsupported two') });
    const v = require('../../../src/services/evoEngine/evoLedger').verify({ branch: bridge.OBSERVATION_BRANCH });
    assert.equal(v.ok, true);
  });
});

describe('frictionBridge — 接入 executeTool 单漏斗（端到端，协作不替代）', () => {
  const toolCalling = require('../../../src/services/toolCalling');

  // 用一个**真实注册**的工具在执行期失败（ls 指向不存在的相对路径 → 软失败出口），
  // 以此命中真正的接入点。注意：①不存在的工具名会走更早的「Unknown tool」早退；
  // ②绝对/系统级路径会被系统调用网关 fail-closed 拦在更早的 deny 出口——两者都绕过接入点，
  // 故必须用 cwd 下的相对路径，让 L0 放行后在执行期真失败。
  const MISSING_PATH = `./__evo_no_such_dir_${process.pid}`;

  test('KHY_EVO_ENGINE=on：真工具失败 → 产出观测，且不改变工具返回结果', async () => {
    const prev = process.env.KHY_EVO_ENGINE;
    process.env.KHY_EVO_ENGINE = 'on';
    bridge._resetForTest();
    const before = bridge.pendingObservations().length;
    try {
      const result = await toolCalling.executeTool('ls', { path: MISSING_PATH }, { sessionId: 'e2e' });
      // 核心权威：仍然是它自己的失败结果，未被本桥篡改。
      assert.equal(result && result.success === true, false);
    } finally {
      if (prev === undefined) delete process.env.KHY_EVO_ENGINE; else process.env.KHY_EVO_ENGINE = prev;
    }
    // 旁路抄送已落一条观测（积压增长）。
    const after = bridge.pendingObservations().length;
    assert.ok(after >= before + 1, `expected an observation appended (before=${before}, after=${after})`);
  });

  test('KHY_EVO_ENGINE=off：显式关闭 → 失败不产出观测（逃生口）', async () => {
    const prev = process.env.KHY_EVO_ENGINE;
    process.env.KHY_EVO_ENGINE = 'off';
    bridge._resetForTest();
    const before = bridge.pendingObservations().length;
    try {
      await toolCalling.executeTool('ls', { path: MISSING_PATH }, { sessionId: 'off' });
    } finally {
      if (prev === undefined) delete process.env.KHY_EVO_ENGINE; else process.env.KHY_EVO_ENGINE = prev;
    }
    assert.equal(bridge.pendingObservations().length, before);
  });

  test('KHY_EVO_ENGINE 未设：默认开启 → 失败仍产出观测', async () => {
    const prev = process.env.KHY_EVO_ENGINE;
    delete process.env.KHY_EVO_ENGINE; // unset = active by default
    bridge._resetForTest();
    const before = bridge.pendingObservations().length;
    try {
      const result = await toolCalling.executeTool('ls', { path: MISSING_PATH }, { sessionId: 'default-on' });
      assert.equal(result && result.success === true, false);
    } finally {
      if (prev !== undefined) process.env.KHY_EVO_ENGINE = prev;
    }
    assert.ok(bridge.pendingObservations().length >= before + 1, 'default-on must append an observation');
  });
});
