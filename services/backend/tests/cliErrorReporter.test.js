'use strict';

/**
 * cliErrorReporter.test.js — 验证「真实原因 + 解决方案」单一真源的红线不变量：
 *   1. 任何错误的 reason 都不只是退出码 / 不是空 / 不是裸「命令执行失败」。
 *   2. suggestions 永不为空（含未知错误兜底）。
 *   3. errno（ENOENT/EACCES/EADDRINUSE…）给出针对性修复。
 *   4. 退出码被并入 reason，且不会丢失真实 stderr。
 *   5. 敏感凭证在原因中被脱敏。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  describeCliError,
  formatCliErrorLine,
  reportCliError,
} = require('../src/cli/cliErrorReporter');

describe('cliErrorReporter — 真实原因 + 解决方案', () => {
  test('普通 Error：reason 取真实消息，suggestions 非空', () => {
    const d = describeCliError(new Error('disk write failed'));
    assert.ok(d.reason.includes('disk write failed'));
    assert.ok(Array.isArray(d.suggestions) && d.suggestions.length > 0);
  });

  test('未知/空错误也必须给出解决方案，且 reason 不为空', () => {
    const d = describeCliError({});
    assert.ok(d.reason && d.reason.length > 0, 'reason 不能为空');
    assert.ok(d.suggestions.length > 0, 'suggestions 永不为空');
    assert.ok(!/^-1$/.test(d.reason), 'reason 不能只是退出码');
  });

  test('纯退出码结果：不只显示退出码，且并入 reason', () => {
    const d = describeCliError({ exitCode: -1 });
    assert.equal(d.exitCode, -1);
    assert.ok(d.reason.includes('退出码 -1'), 'reason 必须包含退出码');
    assert.ok(d.reason.length > '退出码 -1'.length, '不能只剩退出码');
    assert.ok(d.suggestions.length > 0);
  });

  test('退出码 + stderr：真实 stderr 作为原因，不被退出码淹没', () => {
    const d = describeCliError({ exitCode: 2, stderr: 'fatal: not a git repository' });
    assert.ok(d.reason.includes('not a git repository'));
    assert.ok(d.reason.includes('退出码 2'));
  });

  test('ENOENT：给出找不到文件/命令的针对性修复', () => {
    const err = new Error('spawn foo ENOENT');
    err.code = 'ENOENT';
    const d = describeCliError(err, { context: 'foo' });
    const joined = d.suggestions.join('\n');
    assert.ok(/找不到文件或命令/.test(joined));
    assert.ok(joined.includes('foo'), '应带上下文 foo');
  });

  test('EADDRINUSE：提示换端口/结束占用进程', () => {
    const err = new Error('listen EADDRINUSE: address already in use :::9090');
    err.code = 'EADDRINUSE';
    const d = describeCliError(err, { context: '端口 9090' });
    const joined = d.suggestions.join('\n');
    assert.ok(/端口/.test(joined));
    assert.ok(/lsof|--port|结束/.test(joined));
  });

  test('EACCES：权限类修复', () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    const d = describeCliError(err);
    assert.ok(/权限/.test(d.suggestions.join('\n')));
  });

  test('网络类错误：按 kind 给网络修复', () => {
    const d = describeCliError(new Error('fetch failed: getaddrinfo ENOTFOUND api.x'));
    // ENOTFOUND errno 优先，否则 network kind
    assert.ok(/网络|DNS|代理|解析/.test(d.suggestions.join('\n')));
  });

  test('认证类错误：提示重新登录', () => {
    const d = describeCliError(new Error('401 Unauthorized: invalid api key'));
    assert.ok(/登录|认证|Key|凭证/i.test(d.suggestions.join('\n')));
  });

  test('上下文超限：提示压缩历史', () => {
    const d = describeCliError(new Error('prompt is too long: maximum context exceeded'));
    assert.ok(/压缩|compact|history|上下文/i.test(d.suggestions.join('\n')));
  });

  test('结果对象 {success,error} 形态：提取 error 文案', () => {
    const d = describeCliError({ success: false, error: '订阅服务不可用' });
    assert.ok(d.reason.includes('订阅服务不可用'));
    assert.ok(d.suggestions.length > 0);
  });

  test('敏感凭证脱敏：API Key 不原样出现在 reason 中', () => {
    const d = describeCliError(new Error('auth failed with key sk-ABCD1234EFGH5678IJKL'));
    assert.ok(!d.reason.includes('sk-ABCD1234EFGH5678IJKL'), '完整 key 不得泄露');
  });

  test('formatCliErrorLine：单行含原因 + 解决方向', () => {
    const line = formatCliErrorLine(new Error('boom'));
    assert.ok(line.includes('boom'));
    assert.ok(line.includes('解决'));
  });

  test('reportCliError：经注入 formatters 渲染面板（含 message + suggestions）', () => {
    let captured = null;
    const fakeFmt = { printErrorPanel: (opts) => { captured = opts; } };
    const d = reportCliError(new Error('kaboom'), { formatters: fakeFmt });
    assert.ok(captured, 'printErrorPanel 应被调用');
    assert.ok(captured.message.includes('kaboom'));
    assert.ok(captured.suggestions.length > 0);
    assert.equal(d.reason, captured.message);
  });

  test('reportCliError：formatters 缺失时降级到 printError 而非崩溃', () => {
    const lines = [];
    const fakeFmt = { printError: (m) => lines.push(m) };
    reportCliError(new Error('degrade me'), { formatters: fakeFmt });
    assert.ok(lines.some((l) => l.includes('degrade me')));
  });
});
