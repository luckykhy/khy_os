'use strict';

/**
 * codexAdoptRouting.test.js — functional wiring test for the AI-agent launcher
 * credential verbs (`khy codex adopt-env|use-relay|export-env`, and the fixed
 * `khy claude` counterparts).
 *
 * Why functional (not a grep): the verb for launcher commands is NOT in
 * SUB_COMMANDS, so parseInput leaves it in args[0], not subCommand. A source-level
 * check can't catch the regression where the router keyed off `subCommand` and the
 * verb silently fell through to the IDE launcher. This test drives the REAL
 * parseInput→route path with stubbed handlers and asserts the correct dispatch.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROUTER = path.join(__dirname, '../../src/cli/router.js');
const CLAUDE_ADOPT = path.join(__dirname, '../../src/cli/handlers/claudeAdopt.js');
const CODEX_ADOPT = path.join(__dirname, '../../src/cli/handlers/codexAdopt.js');
const IDE = path.join(__dirname, '../../src/cli/handlers/ide.js');

function withStubbedRoute(fn) {
  // Fresh module graph so our handler stubs are the ones the router requires.
  for (const p of [ROUTER, CLAUDE_ADOPT, CODEX_ADOPT, IDE]) {
    delete require.cache[require.resolve(p)];
  }
  const { parseInput, route } = require(ROUTER);
  const log = [];
  const ca = require(CLAUDE_ADOPT);
  ca.handleClaudeAdoptEnv = async () => log.push('claude.adopt');
  ca.handleClaudeUseRelay = async (n) => log.push(`claude.relay(${n})`);
  ca.handleClaudeExportEnv = async (p2) => log.push(`claude.export(${p2})`);
  const co = require(CODEX_ADOPT);
  co.handleCodexAdoptEnv = async () => log.push('codex.adopt');
  co.handleCodexUseRelay = async (n) => log.push(`codex.relay(${n})`);
  co.handleCodexExportEnv = async (p2) => log.push(`codex.export(${p2})`);
  const ide = require(IDE);
  ide.handleIdeCommand = async (c) => log.push(`IDE(${c})`);
  return fn(async (input) => {
    log.length = 0;
    await route(parseInput(input));
    return log.join(',');
  });
}

test('khy codex adopt-env 抵达 codex handler(不落 IDE 启动器)', () => withStubbedRoute(async (run) => {
  assert.strictEqual(await run('codex adopt-env'), 'codex.adopt');
  assert.strictEqual(await run('codex use-codex-env'), 'codex.adopt');
}));

test('khy codex use-relay <name> 传入位置参数', () => withStubbedRoute(async (run) => {
  assert.strictEqual(await run('codex use-relay foo'), 'codex.relay(foo)');
  // 裸 relay / relays 列出(空名)。
  assert.strictEqual(await run('codex relay'), 'codex.relay()');
  assert.strictEqual(await run('codex relays'), 'codex.relay()');
}));

test('khy codex export-env [path] 传入路径', () => withStubbedRoute(async (run) => {
  assert.strictEqual(await run('codex export-env /tmp/cx.env'), 'codex.export(/tmp/cx.env)');
  // 缺省路径 → 空串,handler 自己解析桌面默认。
  assert.strictEqual(await run('codex export-env'), 'codex.export()');
}));

test('回归修复:khy claude 三命令也抵达 handler(此前被 subCommand 判空漏掉)', () => withStubbedRoute(async (run) => {
  assert.strictEqual(await run('claude adopt-env'), 'claude.adopt');
  assert.strictEqual(await run('claude use-cc-env'), 'claude.adopt');
  assert.strictEqual(await run('claude use-relay mindflow'), 'claude.relay(mindflow)');
  assert.strictEqual(await run('claude export-env /tmp/cc.env'), 'claude.export(/tmp/cc.env)');
}));

test('裸启动 / 模型名仍落 IDE 启动器(不误吞)', () => withStubbedRoute(async (run) => {
  assert.strictEqual(await run('codex'), 'IDE(codex)');
  assert.strictEqual(await run('claude'), 'IDE(claude)');
  assert.strictEqual(await run('codex codex-mini'), 'IDE(codex)');
  assert.strictEqual(await run('claude glm-4v'), 'IDE(claude)');
}));

test('凭据动词不串到其它启动器(kiro/cursor 等不触发)', () => withStubbedRoute(async (run) => {
  // kiro adopt-env is not a credential verb for kiro → must go to IDE launcher.
  assert.strictEqual(await run('kiro adopt-env'), 'IDE(kiro)');
}));
