'use strict';

/**
 * Tests for agentDevLog.js — khyos 底座侧开发者可观测层（规范 DESIGN-ARCH-016 §1）。
 * 覆盖：脱敏(§1.3)、大文本摘要(§1.4)、phase/action 映射、NDJSON 记录字段契约(§1.2)、
 * 通道解析(§3 / 静默优先)、sink 与 diagnostics 集成、零待机噪音、防呆静默。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/agentDevLog');
const {
  redact,
  summarize,
  phaseForType,
  actionForEvent,
  toDevLogRecord,
  resolveTarget,
  AgentDevLogSink,
  enableKhyosAgentDevLog,
  MAX_TEXT,
  _resetForTest,
} = mod;

describe('redact (§1.3 / R4)', () => {
  test('masks prefixed secrets like sk-/khy-', () => {
    const out = redact('key is sk-ABCDEFGHIJKLMNOP done');
    assert.ok(!out.includes('ABCDEFGHIJKLMNOP'), '原始密钥体不得明文出现');
    assert.ok(out.includes('***'), '应包含打码标记');
  });

  test('masks Bearer tokens', () => {
    const out = redact('Authorization: Bearer abcdef1234567890');
    assert.ok(!out.includes('abcdef1234567890'), '令牌体不得明文出现');
    assert.ok(out.includes('***'), '应包含打码标记');
  });

  test('masks key=value sensitive pairs', () => {
    const out = redact('api_key=supersecretvalue123&x=1');
    assert.ok(!out.includes('supersecretvalue123'));
    assert.ok(out.includes('***'));
  });

  test('null/undefined → empty string', () => {
    assert.strictEqual(redact(null), '');
    assert.strictEqual(redact(undefined), '');
  });

  test('non-string input is stringified then redacted', () => {
    const out = redact({ token: 'sk-abcdefghijklmnop' });
    assert.ok(!out.includes('abcdefghijklmnop'));
  });
});

describe('summarize (§1.4 / R3)', () => {
  test('short text passes through (after redaction)', () => {
    assert.strictEqual(summarize('hello world'), 'hello world');
  });

  test('long text truncated to MAX_TEXT with +N chars suffix', () => {
    const long = 'x'.repeat(250);
    const out = summarize(long);
    assert.ok(out.startsWith('x'.repeat(MAX_TEXT)));
    assert.ok(out.includes(`…(+${250 - MAX_TEXT} chars)`));
    assert.ok(out.length < 250);
  });

  test('summarize redacts before truncating', () => {
    const out = summarize('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    assert.ok(!out.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  });
});

describe('phaseForType (§1.2 enum)', () => {
  test('maps types to spec phases', () => {
    assert.strictEqual(phaseForType('tool_call'), 'tool');
    assert.strictEqual(phaseForType('tool_result'), 'result');
    assert.strictEqual(phaseForType('model_request'), 'llm');
    assert.strictEqual(phaseForType('model_response'), 'llm');
    assert.strictEqual(phaseForType('error'), 'error');
  });

  test('session_state terminal → end, otherwise start', () => {
    assert.strictEqual(phaseForType('session_state', { to: 'ended' }), 'end');
    assert.strictEqual(phaseForType('session_state', { to: 'active' }), 'start');
  });

  test('unknown type → result (no new enum value)', () => {
    assert.strictEqual(phaseForType('attention'), 'result');
  });
});

describe('actionForEvent (§1.2 action)', () => {
  test('tool events → tool.<name>', () => {
    assert.strictEqual(actionForEvent('tool_call', { toolName: 'getStockData' }), 'tool.getStockData');
    assert.strictEqual(actionForEvent('tool_result', { toolName: 'bash' }), 'tool.bash');
  });

  test('model events carry model id', () => {
    assert.strictEqual(actionForEvent('model_request', { model: 'opus' }), 'llm.request:opus');
    assert.strictEqual(actionForEvent('model_response', { model: 'opus' }), 'llm.response:opus');
  });
});

describe('toDevLogRecord — field contract (§1.2)', () => {
  test('required fields always present', () => {
    const rec = toDevLogRecord(
      { type: 'tool_call', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), timestamp: Date.now(), data: { toolName: 'read', paramKeys: ['path'] } },
      { app: 'khyos', agent: 'general-purpose', step: 3 },
    );
    assert.strictEqual(rec.app, 'khyos');
    assert.strictEqual(rec.agent, 'general-purpose');
    assert.strictEqual(rec.step, 3);
    assert.strictEqual(rec.phase, 'tool');
    assert.strictEqual(rec.trace_id, 'a'.repeat(32));
    assert.strictEqual(rec.span_id, 'b'.repeat(16));
    assert.strictEqual(rec.action, 'tool.read');
    assert.ok(typeof rec.ts === 'string' && rec.ts.includes('T'));
  });

  test('model_response carries tokens + duration + status', () => {
    const rec = toDevLogRecord(
      { type: 'model_response', traceId: 'c'.repeat(32), timestamp: Date.now(), data: { model: 'opus', inputTokens: 800, outputTokens: 150, totalTokens: 950, durationMs: 1342, provider: 'anthropic' } },
      { app: 'khyos', agent: 'tech', step: 2 },
    );
    assert.deepStrictEqual(rec.tokens, { in: 800, out: 150, total: 950 });
    assert.strictEqual(rec.duration_ms, 1342);
    assert.strictEqual(rec.status, 'ok');
    assert.strictEqual(rec.phase, 'llm');
  });

  test('tool_result error surfaces status=error and redacted detail', () => {
    const rec = toDevLogRecord(
      { type: 'tool_result', traceId: 'd'.repeat(32), timestamp: Date.now(), data: { toolName: 'http', success: false, error: 'failed with token=secretvalue1234' } },
      {},
    );
    assert.strictEqual(rec.status, 'error');
    assert.ok(rec.detail && !rec.detail.includes('secretvalue1234'), 'detail 必须脱敏');
  });

  test('does not mutate input event', () => {
    const event = { type: 'tool_call', traceId: 'e'.repeat(32), timestamp: Date.now(), data: { toolName: 'read', paramKeys: ['path'] } };
    const snapshot = JSON.stringify(event);
    toDevLogRecord(event, { step: 1 });
    assert.strictEqual(JSON.stringify(event), snapshot, '不得改写既有事件对象');
  });

  test('agent derived from event.data.agent over ctx default', () => {
    const rec = toDevLogRecord(
      { type: 'tool_call', traceId: 'f'.repeat(32), timestamp: Date.now(), data: { toolName: 'x', agent: 'explore' } },
      { agent: 'fallback' },
    );
    assert.strictEqual(rec.agent, 'explore');
  });
});

describe('resolveTarget (§3 / 静默优先)', () => {
  test('KHY_AGENT_LOG=0 → null (极致静默, 最高优先级)', () => {
    assert.strictEqual(resolveTarget({ KHY_AGENT_LOG: '0', KHYOS_REPORT_FD: '3' }), null);
  });

  test('eco fd → kind fd', () => {
    assert.deepStrictEqual(resolveTarget({ KHYOS_REPORT_FD: '5' }), { kind: 'fd', fd: 5 });
  });

  test('KHY_AGENT_LOG_FILE → kind file', () => {
    assert.deepStrictEqual(resolveTarget({ KHY_AGENT_LOG_FILE: '/tmp/x.log' }), { kind: 'file', file: '/tmp/x.log' });
  });

  test('KHY_AGENT_LOG=stderr/1/true → kind stderr', () => {
    assert.deepStrictEqual(resolveTarget({ KHY_AGENT_LOG: 'stderr' }), { kind: 'stderr' });
    assert.deepStrictEqual(resolveTarget({ KHY_AGENT_LOG: '1' }), { kind: 'stderr' });
    assert.deepStrictEqual(resolveTarget({ KHY_AGENT_LOG: 'true' }), { kind: 'stderr' });
  });

  test('standalone 未显式开启 → null (保持既有行为)', () => {
    assert.strictEqual(resolveTarget({}), null);
  });
});

describe('AgentDevLogSink — NDJSON 写出 (eco fd)', () => {
  test('writes single-line agent.log payload to fd, redacted', () => {
    const writes = [];
    const fakeFd = 999;
    // 用 file 通道更难注入，直接用 fd 通道并 stub fs.writeSync
    const fs = require('fs');
    const orig = fs.writeSync;
    fs.writeSync = (fd, str) => { if (fd === fakeFd) { writes.push(str); return str.length; } return orig(fd, str); };
    try {
      const sink = new AgentDevLogSink({ app: 'khyos', agent: 'a', target: { kind: 'fd', fd: fakeFd } });
      sink.handle({ type: 'model_response', traceId: '1'.repeat(32), timestamp: Date.now(), data: { model: 'opus', inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 100 } });
    } finally {
      fs.writeSync = orig;
    }
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].split('\n').filter(Boolean).length, 1, '必须单行 NDJSON');
    const parsed = JSON.parse(writes[0]);
    assert.strictEqual(parsed.type, 'agent.log');
    assert.strictEqual(parsed.payload.phase, 'llm');
  });

  test('per-trace step counter increments from 1', () => {
    const recs = [];
    const sink = new AgentDevLogSink({ target: { kind: 'stderr' } });
    const origErr = process.stderr.write;
    process.stderr.write = (s) => { recs.push(JSON.parse(s)); return true; };
    try {
      const tid = '2'.repeat(32);
      sink.handle({ type: 'tool_call', traceId: tid, timestamp: Date.now(), data: { toolName: 'a' } });
      sink.handle({ type: 'tool_call', traceId: tid, timestamp: Date.now(), data: { toolName: 'b' } });
    } finally {
      process.stderr.write = origErr;
    }
    assert.strictEqual(recs[0].step, 1);
    assert.strictEqual(recs[1].step, 2);
  });

  test('handle never throws on malformed event (防呆)', () => {
    const sink = new AgentDevLogSink({ target: { kind: 'stderr' } });
    assert.doesNotThrow(() => sink.handle(null));
    assert.doesNotThrow(() => sink.handle({}));
    assert.doesNotThrow(() => sink.handle({ type: 'x', data: null }));
  });
});

describe('enableKhyosAgentDevLog — diagnostics 集成 + 幂等 + 零噪音', () => {
  beforeEach(() => _resetForTest());
  afterEach(() => _resetForTest());

  test('standalone 未开启 → 不挂 sink (null), diagnostics emit 静默', () => {
    const handle = enableKhyosAgentDevLog({});
    // resolveTarget reads real env; CI 默认无 KHY_AGENT_LOG → null
    if (!process.env.KHY_AGENT_LOG && !process.env.KHYOS_REPORT_FD && !process.env.KHY_AGENT_LOG_FILE) {
      assert.strictEqual(handle, null);
    }
  });

  test('opt-in stderr: emit 触发单行写出；幂等不重复挂载', () => {
    const prev = process.env.KHY_AGENT_LOG;
    process.env.KHY_AGENT_LOG = 'stderr';
    const lines = [];
    const origErr = process.stderr.write;
    process.stderr.write = (s) => { lines.push(s); return true; };
    try {
      const h1 = enableKhyosAgentDevLog({ app: 'khyos', agent: 'g' });
      const h2 = enableKhyosAgentDevLog({ app: 'khyos', agent: 'g' });
      assert.strictEqual(h1, h2, '应幂等返回同一句柄');
      const { diagnostics } = require('../../src/services/diagnosticEvents');
      diagnostics.emit('tool_call', { toolName: 'read', paramKeys: ['path'] }, { traceId: '9'.repeat(32) });
    } finally {
      process.stderr.write = origErr;
      if (prev === undefined) delete process.env.KHY_AGENT_LOG; else process.env.KHY_AGENT_LOG = prev;
    }
    const devLines = lines.filter((l) => l.includes('"phase"'));
    assert.ok(devLines.length >= 1, '一次 emit 至少一行开发者日志');
    devLines.forEach((l) => assert.strictEqual(l.trim().split('\n').length, 1, 'NDJSON 单行'));
  });
});
