'use strict';

/**
 * emptyReplySalvage.test.js — 空响应救援（anti-truncation）回归。
 *
 * 实测现象：用户执行工具（如 `pip cache purge`）成功后追问「结果呢」，弱模型把预算
 * 耗在思考/被 max_tokens 截断 → 回复为空，旧逻辑直接抛「未返回有效回复」，但工具结果
 * 就在历史里。`_salvageRecentToolResult` 在空响应路径优先捞回最近一次成功结果回显，
 * 把「执行成功却报截断」变成「直接看到工具输出」。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../../src/cli/ai');
const { _salvageRecentToolResult } = ai.__test__;

const toolMsg = (action, text) => ({ role: 'user', content: `[Tool Result]\n[Tool:${action}] ${text}` });

describe('_salvageRecentToolResult — anti-truncation salvage', () => {
  test('captures the most recent successful tool result with an attributing header', () => {
    const msgs = [
      { role: 'user', content: '清理一下 pip 缓存' },
      { role: 'assistant', content: '[tool_use shellCommand]' },
      toolMsg('shellCommand', 'Files removed: 573'),
      { role: 'user', content: '结果呢' },
    ];
    const out = _salvageRecentToolResult(msgs);
    assert.ok(out, 'returns a salvage string');
    assert.match(out, /Files removed: 573/);
    assert.match(out, /shellCommand/);
  });

  test('returns null when the most recent tool result is a failure (never fakes success)', () => {
    const msgs = [
      { role: 'assistant', content: '[tool_use shellCommand]' },
      toolMsg('shellCommand', 'ERROR: head is not recognized'),
      { role: 'user', content: '结果呢' },
    ];
    assert.equal(_salvageRecentToolResult(msgs), null);
  });

  test('respects the lookback window — stale results beyond it are ignored', () => {
    const msgs = [
      toolMsg('shellCommand', 'ANCIENT OUTPUT'),
      { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' },
      { role: 'assistant', content: 'e' }, { role: 'user', content: 'f' },
    ];
    assert.equal(_salvageRecentToolResult(msgs, { maxLookback: 4 }), null);
    // With a wide enough window it IS captured.
    assert.match(_salvageRecentToolResult(msgs, { maxLookback: 99 }), /ANCIENT OUTPUT/);
  });

  test('picks the latest of multiple tool results', () => {
    const msgs = [
      toolMsg('Read', 'first file body'),
      { role: 'assistant', content: '[tool_use Glob]' },
      toolMsg('Glob', 'second: a.js b.js'),
      { role: 'user', content: '结果呢' },
    ];
    const out = _salvageRecentToolResult(msgs);
    assert.match(out, /second: a\.js b\.js/);
    assert.doesNotMatch(out, /first file body/);
  });

  test('null / empty / no-tool histories return null', () => {
    assert.equal(_salvageRecentToolResult(null), null);
    assert.equal(_salvageRecentToolResult([]), null);
    assert.equal(_salvageRecentToolResult([{ role: 'user', content: 'hi' }]), null);
  });

  test('long output is tail-truncated', () => {
    const big = 'X'.repeat(5000);
    const out = _salvageRecentToolResult([toolMsg('shellCommand', big)]);
    assert.ok(out.length < 2000, 'salvage caps the echoed output');
    assert.match(out, /^.*…/s, 'tail-truncation ellipsis present');
  });
});
