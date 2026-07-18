'use strict';

/**
 * toolResultSummary — 「工具结果一行摘要」单元测试。
 *
 * 重点验证用户原诉求:「这些大括号,前端看见了,人也难以阅读,希望可以显示为具体命令」。
 *  - build_project / shell 结构化结果 → 显示具体命令,绝不出现原始 JSON {braces}。
 *  - 通用兜底:无字符串 output 的结构化结果绝不被 JSON.stringify 成 {…},
 *    而是渲染成可读的具体命令 / 字段,或退回「完成」。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeToolResult,
  _readableObjectSummary,
} = require('../src/cli/toolResultSummary');

const hasBraces = (s) => /[{}]/.test(String(s));

describe('build_project — 显示具体构建命令而非 {braces}', () => {
  test('失败构建 → 命令 + 退出码 + 错误数,无大括号', () => {
    const result = {
      success: false,
      data: { projectType: 'maven', command: 'mvn package -q', exitCode: 1, errors: ['E1'], warnings: [], errorCount: 1, warningCount: 0 },
    };
    const s = summarizeToolResult('build_project', result, {});
    assert.ok(s.includes('mvn package -q'), `应含具体命令: ${s}`);
    assert.ok(s.includes('退出码 1'), `应含退出码: ${s}`);
    assert.ok(s.includes('1 个错误'), `应含错误数: ${s}`);
    assert.ok(!hasBraces(s), `绝不含大括号: ${s}`);
  });

  test('成功构建 → 已构建 + 命令,无大括号', () => {
    const result = { success: true, data: { projectType: 'node', command: 'npm run build', exitCode: 0, errorCount: 0, warningCount: 0 } };
    const s = summarizeToolResult('build_project', result, {});
    assert.ok(s.includes('npm run build'), s);
    assert.ok(!s.includes('退出码'), `退出码 0 不显示: ${s}`);
    assert.ok(!hasBraces(s), s);
  });
});

describe('shell — 输出为空时显示运行的命令', () => {
  test('空输出 + 非零退出码 → 显示 $ 命令 + 退出码', () => {
    const result = { output: '', exitCode: 2 };
    const s = summarizeToolResult('shellCommand', result, { command: 'ls /nonexistent' });
    assert.ok(s.includes('ls /nonexistent'), s);
    assert.ok(s.includes('退出码 2'), s);
    assert.ok(!hasBraces(s), s);
  });

  test('有输出 → 保持原样(短输出直出)', () => {
    const result = { output: 'hello\nworld', exitCode: 0 };
    const s = summarizeToolResult('bash', result, { command: 'echo' });
    assert.ok(s.includes('hello') && s.includes('world'), s);
  });

  test('后台运行不变', () => {
    assert.equal(summarizeToolResult('bash', { _background: true }, {}), '已在后台运行（↓ 管理）');
  });
});

describe('通用兜底 — 永不吐原始 JSON 大括号', () => {
  test('无字符串 output 的结构化结果 → 可读字段,无大括号', () => {
    const result = { mode: 'match', kind: 'archetype', target: 'ssm' };
    const s = summarizeToolResult('some_domain_tool', result, {});
    assert.ok(!hasBraces(s), `绝不含大括号: ${s}`);
    assert.ok(s.includes('mode=match'), s);
  });

  test('带 command 字段的结构化结果 → 显示命令', () => {
    const s = summarizeToolResult('unknownTool', { command: 'git status' }, {});
    assert.ok(s.includes('git status'), s);
    assert.ok(!hasBraces(s), s);
  });

  test('带 message 字段 → 显示 message', () => {
    const s = summarizeToolResult('unknownTool', { message: '操作已完成' }, {});
    assert.equal(s, '操作已完成');
  });

  test('完全空结构化对象 → 退回「完成」', () => {
    const s = summarizeToolResult('unknownTool', { success: true }, {});
    assert.equal(s, '完成');
  });

  test('字符串 output 行为不变(brief)', () => {
    const s = summarizeToolResult('unknownTool', { output: 'plain text result' }, {});
    assert.equal(s, 'plain text result');
  });
});

describe('_readableObjectSummary — 单元', () => {
  test('优先命令 > message > k=v', () => {
    assert.ok(_readableObjectSummary({ command: 'cmd', message: 'm', a: 1 }).includes('cmd'));
    assert.ok(_readableObjectSummary({ message: 'm', a: 1 }).includes('m'));
    assert.ok(_readableObjectSummary({ a: 1, b: 'x' }).includes('a=1'));
  });
  test('嵌套对象/数组不被序列化进结果(无大括号)', () => {
    const s = _readableObjectSummary({ nested: { deep: 1 }, list: [1, 2], flag: true });
    assert.ok(!hasBraces(s), s);
    assert.ok(s.includes('flag=true'), s);
  });
  test('非对象输入 → 空串', () => {
    assert.equal(_readableObjectSummary(null), '');
    assert.equal(_readableObjectSummary('str'), '');
  });
});
