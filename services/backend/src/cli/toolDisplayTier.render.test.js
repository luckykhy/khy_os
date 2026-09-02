'use strict';

/**
 * toolDisplayTier.render.test.js — 输出区分级（tier）与焦点说明行契约测试。
 *
 * 单一真源：cli/toolDisplayPolicy.js（tier 注册表 + getToolTier/isCoreToolDisplay/
 * buildCoreFocusLine）。三条渲染路径（经典 REPL step 行 / 管道工具头行 / headless
 * stderr 行 / TUI 叙述行）消费同一份分级，本测试锁定分级数据与纯字符串行为：
 *  - core（shell/写/编辑/应用启动/agent）→ 常驻显示 + ▌ 焦点锚点
 *  - minor（read/grep/glob/websearch/webfetch/todo）→ 显示后折叠成摘要行
 *  - 未注册工具默认 core（宁可见到，不可漏掉）
 *  - printStepLine core 强调 / headless formatToolStart ▌ 前缀（console 捕获）
 */

const assert = require('node:assert');
const { test, before, after } = require('node:test');

const policy = require('./toolDisplayPolicy');

test('getToolTier: 核心工具 → core（状态变更/委派类）', () => {
  for (const name of ['bash', 'shell', 'shell_command', 'write', 'write_file', 'edit', 'edit_file', 'agent', 'task', 'open_app']) {
    assert.equal(policy.getToolTier(name), 'core', name);
    assert.equal(policy.isCoreToolDisplay(name), true, name);
  }
});

test('getToolTier: 次要工具 → minor（只读/信息类，显示后折叠）', () => {
  for (const name of ['read', 'read_file', 'grep', 'glob', 'find', 'ls', 'websearch', 'web_search', 'webfetch', 'web_fetch', 'todowrite']) {
    assert.equal(policy.getToolTier(name), 'minor', name);
    assert.equal(policy.isCoreToolDisplay(name), false, name);
  }
});

test('getToolTier: 未注册工具默认 core（宁可见到，不可漏掉）', () => {
  assert.equal(policy.getToolTier('image_generate'), 'core');
  assert.equal(policy.getToolTier('totally_unknown_tool'), 'core');
  assert.equal(policy.getToolTier(''), 'core');
  assert.equal(policy.getToolTier(null), 'core');
});

test('buildCoreFocusLine: ▌ 焦点锚点 + 标签 + 目标三段式', () => {
  assert.equal(policy.buildCoreFocusLine('写入文件', 'src/x.js'), '▌ 写入文件：src/x.js');
  assert.equal(policy.buildCoreFocusLine('执行命令', ''), '▌ 执行命令');
  assert.equal(policy.buildCoreFocusLine('', 'src/x.js'), '▌ 核心操作：src/x.js');
  assert.equal(policy.buildCoreFocusLine(null, null), '▌ 核心操作');
  assert.equal(policy.buildCoreFocusLine('  执行命令  ', '  src/x.js  '), '▌ 执行命令：src/x.js');
});

test('printStepLine: 核心工具 ▌ 焦点强调，次要工具保持轻量', () => {
  const steps = require('./steps');
  const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const savedInk = process.env.KHY_INK_TUI_ACTIVE;
  const lines = [];
  const savedLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.KHY_INK_TUI_ACTIVE;

    lines.length = 0;
    steps.printStepLine('active', 'Running command', 'npm test', '', { toolName: 'bash' });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('▌'), '核心工具应有 ▌ 焦点锚点');
    assert.ok(lines[0].includes('Running command'));
    assert.ok(lines[0].includes('npm test'));

    lines.length = 0;
    steps.printStepLine('active', 'Reading file', 'src/x.js', '', { toolName: 'read_file' });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('▌'), '次要工具不应有 ▌ 锚点');
    assert.ok(lines[0].includes('Reading file'));

    // 未传 toolName（旧调用方）→ 无锚点，逐字节回退旧行为
    lines.length = 0;
    steps.printStepLine('active', 'Running command', 'npm test');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('▌'), '旧调用签名应逐字节回退');
  } finally {
    console.log = savedLog;
    if (savedIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', savedIsTTY);
    }
    if (savedInk === undefined) {
      delete process.env.KHY_INK_TUI_ACTIVE;
    } else {
      process.env.KHY_INK_TUI_ACTIVE = savedInk;
    }
  }
});

test('headless formatToolStart: core 加 ▌ 前缀，minor 保持原行', () => {
  const hp = require('./headlessProgress');
  const bashLine = hp.formatToolStart('bash', { command: 'npm test' });
  assert.ok(bashLine.startsWith('▌ '), `核心工具开始行应有 ▌ 前缀，实际: ${bashLine}`);
  assert.ok(bashLine.includes('npm test'));

  const readLine = hp.formatToolStart('read_file', { path: 'src/x.js' });
  assert.ok(!readLine.startsWith('▌'), `次要工具开始行不应有 ▌ 前缀，实际: ${readLine}`);
  assert.ok(readLine.includes('src/x.js'));

  const unknownLine = hp.formatToolStart('mystery_tool', {});
  assert.ok(unknownLine.startsWith('▌'), '未注册工具默认按核心显示');
});

test('分级注册表完整性：每条 policy 都有合法 tier', () => {
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    assert.ok(p.tier === 'core' || p.tier === 'minor', `POLICIES.${key}.tier 必须是 core|minor`);
  }
  assert.equal(policy.DEFAULT_POLICY.tier, 'core');
});
