#!/usr/bin/env node
'use strict';

// 临时诊断脚本 —— 与 _tmp-jest-linux.yml 一同删除。
// 把 jest --json 的结果压成「根因直方图 + 逐 suite 首行」，通过公开可读的
// check-run annotations 取回（Actions 日志需要 admin 权限，拿不到）。

const fs = require('fs');

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*m', 'g');

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const enc = (s) => String(s).replace(/\r/g, '').replace(/\n/g, '%0A').replace(/::/g, ': ');
const rel = (p) => String(p).replace(/^.*services[/\\]backend[/\\]/, '').replace(/\\/g, '/');

// 只取首行不够用：jest 的首行往往是 "assert.strictEqual(received, expected)" 这类
// 模板文字，看不出根因。所以剔掉 "● suite › case" 标题与堆栈行之后，取前若干行
// 拼成签名 —— Expected/Received 就落在紧随其后的那两行里。
const failureSignature = (text) => {
  const lines = String(text || '')
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('●') && !l.startsWith('at ') && !/^\d+ \|/.test(l) && l !== '^');
  return lines.length ? lines.slice(0, 4).join(' ⋯ ') : '(无消息)';
};

const summary =
  `suites: ${report.numFailedTestSuites} failed / ${report.numTotalTestSuites} total` +
  `  |  tests: ${report.numFailedTests} failed / ${report.numTotalTests} total` +
  `  |  node ${process.version}`;

const histogram = new Map();
const perSuite = [];

for (const suite of report.testResults) {
  const failedCases = (suite.assertionResults || []).filter((a) => a.status === 'failed');
  const isSuiteLevel = failedCases.length === 0 && suite.status === 'failed';
  if (!failedCases.length && !isSuiteLevel) continue;

  const reasons = isSuiteLevel
    ? [failureSignature(suite.message).slice(0, 220)]
    : failedCases.map((a) => failureSignature(a.failureMessages && a.failureMessages[0]).slice(0, 220));

  for (const reason of reasons) histogram.set(reason, (histogram.get(reason) || 0) + 1);

  const count = isSuiteLevel ? 'suite级' : String(failedCases.length);
  perSuite.push(`${rel(suite.name)}  [${count}]  ${reasons[0]}`);
}

const histLines = [...histogram.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([reason, n]) => `${String(n).padStart(4)}x  ${reason}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## ${summary}\n\n### 根因直方图\n\n\`\`\`\n${histLines.join('\n')}\n\`\`\`\n\n` +
      `### 逐 suite\n\n\`\`\`\n${perSuite.sort().join('\n')}\n\`\`\`\n`
  );
}

// 单条 annotation 有长度上限，超了会被截断。按预算切片，每片单独成为一条。
function chunk(lines, budget) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length > budget && cur.length) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

console.log(`::error title=汇总::${enc(summary)}`);
chunk(histLines, 2400).forEach((c, i) => {
  console.log(`::error title=根因 ${i + 1}::${enc(c.join('\n'))}`);
});
chunk(perSuite.sort(), 2400).forEach((c, i) => {
  console.log(`::error title=失败 suite ${i + 1}::${enc(c.join('\n'))}`);
});

// 第四次启用：剩下的失败只有个位数，可以直接把**完整** failureMessage 取回来。
// 前三次只取签名（前 4 行）是因为有 160 条，现在反过来 —— 签名看不出
// 「为什么本机绿、门禁红」，真正有用的是 Expected/Received 的全文和堆栈首帧。
const detail = [];
for (const suite of report.testResults) {
  const failedCases = (suite.assertionResults || []).filter((a) => a.status === 'failed');
  if (!failedCases.length && suite.status !== 'failed') continue;
  detail.push('##### ' + rel(suite.name));
  if (!failedCases.length) {
    detail.push(...String(suite.message || '').replace(ANSI, '').split('\n').slice(0, 40));
    continue;
  }
  for (const a of failedCases) {
    detail.push('--- ' + a.fullName);
    const msg = String((a.failureMessages || [])[0] || '').replace(ANSI, '');
    detail.push(...msg.split('\n').slice(0, 45));
  }
}
chunk(detail.map((l) => l.replace(/\s+$/, '')).filter((l) => l !== ''), 2400).forEach((c, i) => {
  console.log(`::error title=全文 ${i + 1}::${enc(c.join('\n'))}`);
});
