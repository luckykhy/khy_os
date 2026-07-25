'use strict';

/**
 * healthHandler.test.js — `khy health` 统一自助健康诊断。
 *
 * 验证聚合层 collectHealth() 的结构化契约与渲染层 handleHealth() 的行为：
 *   - collectHealth() 永不抛错，返回 {level, checks[], summary} 且 level 自洽；
 *   - 必有的核心检查项（runtime/dataHome/auth/network/services/disk）齐全；
 *   - 任一检查项探测失败时降级为 yellow 而非让整命令崩溃（fail-soft）；
 *   - --json 模式输出可被 JSON.parse 消费；
 *   - 存在 red 项时 handleHealth 以非零 exitCode 退出（健康门禁）。
 *
 * 纯单测：不联网、不依赖外部后端配置；磁盘/内存读本机真实值（只断言形状）。
 */

const test = require('node:test');
const assert = require('node:assert');

const health = require('../../../src/cli/handlers/health');

const REQUIRED_IDS = ['runtime', 'dataHome', 'auth', 'network', 'modelChannels', 'disk', 'memory', 'services'];
const VALID_STATUS = new Set(['green', 'yellow', 'red', 'info']);

test('collectHealth() returns a self-consistent structured report', async () => {
  const r = await health.collectHealth();
  assert.ok(r && typeof r === 'object', 'report is an object');
  assert.ok(['green', 'yellow', 'red'].includes(r.level), 'level is green/yellow/red');
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0, 'checks is a non-empty array');

  for (const c of r.checks) {
    assert.ok(c.id, 'check has id');
    assert.ok(c.label, 'check has label');
    assert.ok(VALID_STATUS.has(c.status), `check status valid (${c.status})`);
    assert.equal(typeof c.detail, 'string', 'check detail is a string');
  }

  // level must reflect the worst status present.
  const hasRed = r.checks.some(c => c.status === 'red');
  const hasYellow = r.checks.some(c => c.status === 'yellow');
  const expected = hasRed ? 'red' : (hasYellow ? 'yellow' : 'green');
  assert.equal(r.level, expected, 'level reflects worst status');

  // summary counts add up to the number of checks.
  const counted = r.summary.green + r.summary.yellow + r.summary.red + r.summary.info;
  assert.equal(counted, r.checks.length, 'summary counts sum to checks length');
});

test('collectHealth() includes the required core diagnostic items', async () => {
  const r = await health.collectHealth();
  const ids = new Set(r.checks.map(c => c.id));
  for (const id of REQUIRED_IDS) {
    assert.ok(ids.has(id), `report includes "${id}"`);
  }
});

test('a check that throws degrades to yellow rather than crashing the command', async () => {
  // Force networkDetector.getStatus to throw, then confirm the network item is
  // a yellow "无法检测" and the overall command still produces a report.
  const detector = require('../../../src/services/networkDetector');
  const orig = detector.getStatus;
  detector.getStatus = () => { throw new Error('boom'); };
  try {
    const r = await health.collectHealth();
    const net = r.checks.find(c => c.id === 'network');
    assert.ok(net, 'network check still present');
    assert.equal(net.status, 'yellow', 'thrown check degrades to yellow');
    assert.match(net.detail, /无法检测/, 'detail explains the failure');
  } finally {
    detector.getStatus = orig;
  }
});

test('handleHealth(--json) prints parseable JSON and does not throw', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const savedExit = process.exitCode;
  try {
    const ret = await health.handleHealth({ args: ['--json'] });
    assert.equal(ret, true, 'handler returns true');
    const parsed = JSON.parse(logs.join('\n'));
    assert.ok(['green', 'yellow', 'red'].includes(parsed.level), 'json carries a level');
    assert.ok(Array.isArray(parsed.checks), 'json carries checks array');
  } finally {
    console.log = origLog;
    process.exitCode = savedExit;
  }
});

test('handleHealth sets a non-zero exit code when a check is red', async () => {
  // Stub disk to red (simulating an out-of-space data home) and confirm the
  // command surfaces it as a gating non-zero exit.
  const fs = require('fs');
  const origStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1, bsize: 1, blocks: 1 }); // ~1 byte free → red
  const savedExit = process.exitCode;
  const origLog = console.log;
  console.log = () => {};
  try {
    process.exitCode = 0;
    await health.handleHealth({ args: ['--json'] });
    assert.equal(process.exitCode, 1, 'red report yields non-zero exit');
  } finally {
    fs.statfsSync = origStatfs;
    console.log = origLog;
    process.exitCode = savedExit;
  }
});
