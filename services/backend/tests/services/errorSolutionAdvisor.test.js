'use strict';

/**
 * errorSolutionAdvisor.test.js — 「错误 → 建议方案」纯叶子契约 SSoT。
 *
 * 用户诉求:khyos 出错时只报错、缺建议方案。本套件锁死叶子的纯部分:
 *   - 门控默认开;关(0/false/off/no,大小写/空格不敏感)→ 恒返 [](调用方逐字节回退);
 *   - 确定性错误签名 → 具体可执行建议(权限保留 Shift+Tab 提示,覆盖 16 类);
 *   - 顺序即优先级(越具体越靠前),去重,受 max 截断;
 *   - 绝不抛(null / 非字符串 / junk env / 空输入 → [])。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  SOLUTION_RULES,
  isErrorSolutionAdvisorEnabled,
  suggestSolutions,
  matchedSolutionNames,
} = require('../../src/services/errorSolutionAdvisor');

test('gate default-on', () => {
  assert.strictEqual(isErrorSolutionAdvisorEnabled({}), true);
  assert.strictEqual(isErrorSolutionAdvisorEnabled(undefined), true);
  assert.strictEqual(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: '1' }), true);
  assert.strictEqual(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'on' }), true);
  assert.strictEqual(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'true' }), true);
});

test('gate off — CANON off-words (case/space-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(
      isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: v }),
      false,
      `expected off for ${JSON.stringify(v)}`,
    );
  }
});

test('gate off → suggestSolutions/matchedSolutionNames return [] (byte-revert)', () => {
  const env = { KHY_ERROR_SOLUTION_ADVISOR: 'off' };
  assert.deepStrictEqual(suggestSolutions('EACCES: permission denied', { env }), []);
  assert.deepStrictEqual(matchedSolutionNames('EACCES: permission denied', { env }), []);
});

test('never throws — junk inputs', () => {
  assert.deepStrictEqual(suggestSolutions(null), []);
  assert.deepStrictEqual(suggestSolutions(undefined), []);
  assert.deepStrictEqual(suggestSolutions(''), []);
  assert.deepStrictEqual(suggestSolutions([null, undefined, 123, {}]), []);
  assert.deepStrictEqual(suggestSolutions('anything', { env: { KHY_ERROR_SOLUTION_ADVISOR: { weird: true } } }), []);
});

test('permission signature preserves Shift+Tab hint', () => {
  const out = suggestSolutions('Error: EACCES: permission denied, open /etc/hosts');
  assert.strictEqual(out.length >= 1, true);
  assert.match(out[0], /Shift\+Tab/);
  assert.deepStrictEqual(matchedSolutionNames('EPERM operation not permitted'), ['permission']);
  assert.deepStrictEqual(matchedSolutionNames('权限不足'), ['permission']);
});

test('each deterministic signature maps to its rule', () => {
  const cases = [
    ['ENOENT: no such file or directory', 'path-not-found'],
    ['bash: foo: command not found', 'command-not-found'],
    ['The required parameter `pattern` is missing', 'missing-parameter'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'connection-refused'],
    ['getaddrinfo ENOTFOUND api.example.com', 'dns'],
    ['listen EADDRINUSE: address already in use :::3000', 'port-in-use'],
    ['request ETIMEDOUT', 'timeout'],
    ['ENOSPC: no space left on device', 'disk-full'],
    ['FATAL ERROR: JavaScript heap out of memory', 'out-of-memory'],
    ["Cannot find module 'express'", 'module-not-found'],
    ['EEXIST: file already exists', 'file-exists'],
    ['Request failed with status code 401 Unauthorized', 'auth'],
    ['429 Too Many Requests', 'rate-limit'],
    ['Automatic merge failed; fix conflicts (merge conflict)', 'git-conflict'],
    ['Invoke-WebRequest : Not Found ... WebCmdletWebResponseException', 'download-failed'],
  ];
  for (const [text, name] of cases) {
    assert.ok(
      matchedSolutionNames(text).includes(name),
      `expected ${JSON.stringify(text)} → ${name}, got ${JSON.stringify(matchedSolutionNames(text))}`,
    );
    const sol = suggestSolutions(text);
    assert.strictEqual(sol.length >= 1, true, `expected a solution for ${name}`);
  }
});

test('command-not-found distinct from path-not-found on exit 127', () => {
  const names = matchedSolutionNames('process exited with code 127');
  assert.ok(names.includes('command-not-found'));
});

test('dedup + order (specific before generic) + max cap', () => {
  const text = [
    'ECONNREFUSED connection refused',
    'ETIMEDOUT timed out',
    'EACCES permission denied',
    'ENOSPC no space left on device',
    'EADDRINUSE address already in use',
  ].join('\n');
  const names = matchedSolutionNames(text);
  // permission precedes connection-refused precedes port-in-use precedes timeout precedes disk-full
  assert.ok(names.indexOf('permission') < names.indexOf('connection-refused'));
  assert.ok(names.indexOf('connection-refused') < names.indexOf('port-in-use'));
  assert.ok(names.indexOf('port-in-use') < names.indexOf('timeout'));
  // max cap
  const capped = suggestSolutions(text, { max: 2 });
  assert.strictEqual(capped.length, 2);
  // no duplicates when same signature appears twice
  const dup = suggestSolutions('EACCES denied\nEACCES permission denied');
  assert.strictEqual(dup.length, 1);
});

test('download-failed wins and suppresses path/command-not-found on web 404 (screenshot repro)', () => {
  // 截图真景:powershell Invoke-WebRequest 远端 404,裸 "Not Found" 会同时触发
  // path-not-found / command-not-found。download-failed 声明在前,须领先且抑制那两个泛化家族。
  const stderr = [
    'Invoke-WebRequest : Not Found',
    '    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-WebRequest], WebException',
    '    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeWebRequestCommand',
  ].join('\n');
  const sols = suggestSolutions(stderr);
  assert.ok(sols.length >= 1);
  assert.match(sols[0], /下载|远端/, 'download-failed 应领先');
  assert.match(sols[0], /gh release|github|资产|标签/, '应给查发布 API 的方向');
  // 抑制:用户可见输出不应再混入「路径缺失 / 命令未安装」的误导条目
  for (const s of sols) {
    assert.ok(!/不在 PATH|命令未安装|路径不存在|核实路径/.test(s), `不应混入路径/命令缺失误导条: ${s}`);
  }
});

test('download-failed does not steal genuine command-not-found (no web signature)', () => {
  const names = matchedSolutionNames('bash: frobnicate: command not found');
  assert.ok(names.includes('command-not-found'));
  assert.ok(!names.includes('download-failed'), '无下载签名不应误命中 download-failed');
});

test('no match on benign text → [] (caller falls back)', () => {
  assert.deepStrictEqual(suggestSolutions('operation completed successfully'), []);
  assert.deepStrictEqual(suggestSolutions('构建通过,测试全绿'), []);
});

test('SOLUTION_RULES is frozen and well-formed', () => {
  assert.strictEqual(Object.isFrozen(SOLUTION_RULES), true);
  assert.strictEqual(SOLUTION_RULES.length, 16);
  for (const r of SOLUTION_RULES) {
    assert.strictEqual(typeof r.name, 'string');
    assert.ok(r.re instanceof RegExp);
    assert.strictEqual(typeof r.solution, 'string');
    assert.ok(r.solution.length > 0);
  }
});
