'use strict';

/**
 * toolCallingProbe.test.js — 实测工具调用能力的纯逻辑层不变量。
 * interpretProbeResult 三态裁决 + shouldReprobe(TTL) + 门控 + 规范化 + 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../../src/services/gateway/toolCallingProbe');

describe('isEnabled — gate KHY_TOOL_CAP_PROBE (默认开)', () => {
  test('unset → ON', () => {
    assert.equal(probe.isEnabled({}), true);
  });
  test('falsy values → OFF', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false ', 'No']) {
      assert.equal(probe.isEnabled({ KHY_TOOL_CAP_PROBE: v }), false, `"${v}" should disable`);
    }
  });
  test('any other value → ON', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(probe.isEnabled({ KHY_TOOL_CAP_PROBE: v }), true);
    }
  });
});

describe('normalizeModel', () => {
  test('trims + lowercases', () => {
    assert.equal(probe.normalizeModel('  Agnes-2.0-Flash '), 'agnes-2.0-flash');
    assert.equal(probe.normalizeModel(null), '');
    assert.equal(probe.normalizeModel(undefined), '');
  });
});

describe('TRIVIAL_TOOL / PROBE_PROMPT — probe payload', () => {
  test('tool has a name + minimal schema', () => {
    assert.equal(probe.TRIVIAL_TOOL.name, 'khy_probe_echo');
    assert.equal(probe.TRIVIAL_TOOL.input_schema.type, 'object');
    assert.deepEqual(probe.TRIVIAL_TOOL.input_schema.required, ['ok']);
  });
  test('prompt instructs a tool call', () => {
    assert.match(probe.PROBE_PROMPT, /khy_probe_echo/);
  });
});

describe('interpretProbeResult — 三态', () => {
  test('native: toolUseBlocks present', () => {
    const r = probe.interpretProbeResult({ success: true, toolUseBlocks: [{ name: 'khy_probe_echo' }] });
    assert.equal(r.verdict, 'native');
  });
  test('native: finish_reason tool_calls (no blocks parsed)', () => {
    assert.equal(probe.interpretProbeResult({ success: true, finishReason: 'tool_calls' }).verdict, 'native');
    assert.equal(probe.interpretProbeResult({ stopReason: 'tool_use' }).verdict, 'native');
  });
  test('native: alt field names (toolCalls / tool_calls)', () => {
    assert.equal(probe.interpretProbeResult({ toolCalls: [{}] }).verdict, 'native');
    assert.equal(probe.interpretProbeResult({ tool_calls: [{}] }).verdict, 'native');
  });
  test('text: success with content, no tool calls', () => {
    const r = probe.interpretProbeResult({ success: true, content: 'I cannot call tools, here is text.' });
    assert.equal(r.verdict, 'text');
  });
  test('text: content present without explicit success flag', () => {
    assert.equal(probe.interpretProbeResult({ content: 'hello' }).verdict, 'text');
  });
  test('unknown: explicit failure', () => {
    assert.equal(probe.interpretProbeResult({ success: false, error: 'boom' }).verdict, 'unknown');
  });
  test('unknown: empty response', () => {
    assert.equal(probe.interpretProbeResult({ success: true, content: '' }).verdict, 'unknown');
    assert.equal(probe.interpretProbeResult({}).verdict, 'unknown');
  });
  test('never throws on junk', () => {
    for (const j of [null, undefined, 42, 'str', [], () => {}]) {
      assert.doesNotThrow(() => probe.interpretProbeResult(j));
      assert.equal(probe.interpretProbeResult(j).verdict, 'unknown');
    }
  });
});

describe('shouldReprobe — TTL', () => {
  const now = 1_000_000_000_000;
  test('no record / junk → reprobe', () => {
    assert.equal(probe.shouldReprobe(null, {}, now), true);
    assert.equal(probe.shouldReprobe({}, {}, now), true);
    assert.equal(probe.shouldReprobe({ verdict: 'unknown', measuredAt: now }, {}, now), true);
    assert.equal(probe.shouldReprobe({ verdict: 'native' }, {}, now), true); // no measuredAt
  });
  test('fresh record → no reprobe', () => {
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now }, {}, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 1000 }, {}, now), false);
  });
  test('confirmed PASS (native) is sticky — never reprobed by age (避免重复浪费)', () => {
    const ancient = now - probe.DEFAULT_TTL_MS * 100;
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: ancient }, {}, now), false);
  });
  test('expired TEXT record → reprobe (未确证有界 TTL,假阴性可恢复)', () => {
    const old = now - probe.DEFAULT_TTL_MS - 1;
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: old }, {}, now), true);
  });
  test('custom TTL env honored (text)', () => {
    const env = { KHY_TOOL_CAP_TTL_MS: '1000' };
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 500 }, env, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 2000 }, env, now), true);
  });
  test('KHY_TOOL_CAP_NATIVE_TTL_MS re-enables native expiry (self-heal opt-in)', () => {
    const env = { KHY_TOOL_CAP_NATIVE_TTL_MS: '1000' };
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now - 500 }, env, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now - 2000 }, env, now), true);
  });
  test('never throws', () => {
    assert.doesNotThrow(() => probe.shouldReprobe(Symbol('x')));
  });
});
