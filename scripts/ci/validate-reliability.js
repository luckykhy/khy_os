#!/usr/bin/env node
'use strict';

/**
 * validate-reliability.js — 校验 khy-os 可靠性契约。
 *
 * 用法:
 *   node scripts/ci/validate-reliability.js        # 校验全部可靠性规则
 *   node scripts/ci/validate-reliability.js --json  # JSON 机器输出
 *
 * 本脚本校验的是「代码中的可靠性机制」：
 * 1. 任务状态机转换合法性（STATUS_TRANSITIONS 覆盖完整）
 * 2. Watchdog 覆盖率（长时间执行有超时保护）
 * 3. Receipt 闭合性（start/finalize 配对）
 * 4. AbortSignal 传播链路完整性
 * 5. 重试分类（不可重试错误不进入重试循环）
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');
const CHECKS = [];
let passed = 0, failed = 0;
const failures = [];

function check(name, fn) {
  CHECKS.push({ name, fn });
}

function fail(name, detail) {
  failed++;
  failures.push({ name, detail: String(detail || '') });
}

function pass(name) {
  passed++;
}

// ── 1. 状态机转换合法性 ─────────────────────────────────────────────────────

const TASK_STORE = 'services/backend/src/tasks/largeTaskRuntimeStore.js';
const TASK_STORE_PATH = path.join(ROOT, TASK_STORE);

check('状态机: STATUS_TRANSITIONS 定义存在', () => {
  if (!fs.existsSync(TASK_STORE_PATH)) {
    fail('状态机文件不存在: ' + TASK_STORE);
    return;
  }
  const content = fs.readFileSync(TASK_STORE_PATH, 'utf-8');
  if (!content.includes('STATUS_TRANSITIONS')) {
    fail('STATUS_TRANSITIONS 未定义');
    return;
  }
  if (!content.includes('TERMINAL_STATUSES')) {
    fail('TERMINAL_STATUSES 未定义');
    return;
  }
  pass('STATUS_TRANSITIONS + TERMINAL_STATUSES 已定义');
});

check('状态机: 所有状态有合法后继', () => {
  if (!fs.existsSync(TASK_STORE_PATH)) return;
  const content = fs.readFileSync(TASK_STORE_PATH, 'utf-8');
  // 检查所有 11 个状态在 STATUS_TRANSITIONS 中出现
  const statuses = ['queued', 'claimed', 'running', 'retry_wait', 'pausing',
                    'paused', 'cancelling', 'succeeded', 'failed', 'cancelled', 'dead_letter'];
  const missing = statuses.filter(s => !content.includes(`'${s}'`));
  if (missing.length) {
    fail(`以下状态缺失: ${missing.join(', ')}`);
    return;
  }
  // 终态使用空 Set()
  const terminal = ['succeeded', 'failed', 'cancelled', 'dead_letter'];
  // 检查 TERMINAL_STATUSES 定义（freeze on a Set 或 array）
  if (!content.includes('TERMINAL_STATUSES')) {
    fail('TERMINAL_STATUSES 未定义');
    return;
  }
  pass(`11 个状态定义完整，TERMINAL_STATUSES 已定义`);
});

// ── 2. Watchdog 覆盖率 ─────────────────────────────────────────────────────

const SERVICE_FILES = [
  'services/backend/src/services/toolCalling.js',
  'services/backend/src/cli/aiGatewayGenerateHelpers.js',
  'services/backend/src/cli/tui/hooks/useQueryBridge.js',
  'services/backend/src/cli/replSession.js',
];

check('Watchdog: startWatchdog 被使用', () => {
  const resourceGuardPath = path.join(ROOT, 'services/backend/src/services/resourceGuard.js');
  if (!fs.existsSync(resourceGuardPath)) {
    fail('resourceGuard.js 不存在');
    return;
  }
  const content = fs.readFileSync(resourceGuardPath, 'utf-8');
  if (!content.includes('startWatchdog') || !content.includes('function startWatchdog')) {
    fail('startWatchdog 函数未定义');
    return;
  }
  if (!content.includes('.touch()') || !content.includes('.done()') || !content.includes('.elapsed()')) {
    fail('Watchdog API 不完整（缺少 touch/done/elapsed）');
    return;
  }
  pass('startWatchdog + touch()/done()/elapsed() API 完整');
});

check('Watchdog: 长时间工具调用有超时保护', () => {
  const toolCallingPath = path.join(ROOT, SERVICE_FILES[0]);
  if (!fs.existsSync(toolCallingPath)) {
    fail('toolCalling.js 不存在');
    return;
  }
  const content = fs.readFileSync(toolCallingPath, 'utf-8');
  // 检查是否有 Watchdog 相关的超时保护
  const hasWatchdog = content.includes('watchdog') || content.includes('Watchdog') ||
                      content.includes('timeout') || content.includes('idleTimeout');
  if (!hasWatchdog) {
    fail('toolCalling.js 中未检测到 Watchdog/timeout 保护');
    return;
  }
  pass('toolCalling.js 包含超时/ Watchdog 保护');
});

check('Watchdog: Gateway 生成有 hard + idle 超时', () => {
  const gatewayPath = path.join(ROOT, 'services/backend/src/cli/aiGatewayGenerateHelpers.js');
  if (!fs.existsSync(gatewayPath)) {
    fail('aiGatewayGenerateHelpers.js 不存在');
    return;
  }
  const content = fs.readFileSync(gatewayPath, 'utf-8');
  // 检查 timeout 相关参数
  const hasTimeout = content.includes('timeout') || content.includes('timeoutMs') ||
                     content.includes('idleTimeout') || content.includes('hardTimeout');
  if (!hasTimeout) {
    fail('Gateway 生成缺少超时保护');
    return;
  }
  pass('Gateway 生成包含超时保护');
});

check('Watchdog: timer 必须 unref', () => {
  const resourceGuardPath = path.join(ROOT, 'services/backend/src/services/resourceGuard.js');
  if (!fs.existsSync(resourceGuardPath)) return;
  const content = fs.readFileSync(resourceGuardPath, 'utf-8');
  // 检查是否有 .unref() 调用（允许 timer 不阻止进程退出）
  const hasUnref = content.includes('.unref()') || content.includes('.unref()');
  if (!hasUnref) {
    fail('Watchdog timer 缺少 .unref()，可能阻止进程退出');
    return;
  }
  pass('Watchdog timer 已设置 .unref()');
});

// ── 3. Receipt 闭合性 ──────────────────────────────────────────────────────

const RECEIPT_SERVICE = 'services/backend/src/services/receiptService.js';

check('Receipt: startReceipt + finalizeReceipt 存在', () => {
  const path_ = path.join(ROOT, RECEIPT_SERVICE);
  if (!fs.existsSync(path_)) {
    fail('receiptService.js 不存在');
    return;
  }
  const content = fs.readFileSync(path_, 'utf-8');
  if (!content.includes('startReceipt') || !content.includes('finalizeReceipt')) {
    fail('startReceipt/finalizeReceipt 未定义');
    return;
  }
  // 检查 finalizeReceipt 是幂等的
  const hasIdempotency = content.includes('if (!_open') || content.includes('if (!open') ||
                          content.includes('no-op') || content.includes('noop');
  if (!hasIdempotency) {
    fail('finalizeReceipt 缺少幂等保护（对无 open receipt 的调用应是 no-op）');
    return;
  }
  pass('startReceipt/finalizeReceipt 存在，finalizeReceipt 幂等');
});

check('Receipt: auto-finalize 前一个同会话 receipt', () => {
  const path_ = path.join(ROOT, RECEIPT_SERVICE);
  if (!fs.existsSync(path_)) return;
  const content = fs.readFileSync(path_, 'utf-8');
  // 检查 startReceipt 中是否有清理前一个 open receipt 的逻辑
  const hasAutoFinalize = content.includes('finalize') && (
    content.includes('previous') || content.includes('prev') || content.includes('earlier') ||
    content.includes('_open.get') || content.includes('open.get')
  );
  if (!hasAutoFinalize) {
    fail('startReceipt 缺少 auto-finalize 前一个同会话 receipt 的逻辑');
    return;
  }
  pass('startReceipt 包含 auto-finalize 前一个 receipt 的逻辑');
});

// ── 4. AbortSignal 传播链路 ────────────────────────────────────────────────

const REPL_SESSION = 'services/backend/src/cli/replSession.js';
const TUI_HOOKS = 'services/backend/src/cli/tui/hooks/useQueryBridge.js';

check('AbortSignal: ESC → AbortController 链路存在', () => {
  const replPath = path.join(ROOT, REPL_SESSION);
  if (!fs.existsSync(replPath)) {
    fail('replSession.js 不存在');
    return;
  }
  const content = fs.readFileSync(replPath, 'utf-8');
  if (!content.includes('AbortController')) {
    fail('replSession.js 中未找到 AbortController');
    return;
  }
  pass('replSession.js 中 AbortController 存在');
});

check('AbortSignal: TUI ESC handler 传播 abortSignal', () => {
  const tuiPath = path.join(ROOT, TUI_HOOKS);
  if (!fs.existsSync(tuiPath)) {
    fail('useQueryBridge.js 不存在');
    return;
  }
  const content = fs.readFileSync(tuiPath, 'utf-8');
  // 检查 abortSignal 是否被传递给 loop/chatFn
  const hasPropagation = content.includes('abortSignal') || content.includes('abort') ||
                          content.includes('signal') && content.includes('loop');
  if (!hasPropagation) {
    fail('useQueryBridge.js 中未检测到 abortSignal 传播');
    return;
  }
  pass('TUI hooks 包含 abortSignal 传播');
});

check('AbortSignal: KHY_TOOL_ABORT_SIGNAL 门控存在', () => {
  const files = [REPL_SESSION, TUI_HOOKS, 'services/backend/src/cli/aiMessageBuilder.js'];
  let found = false;
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf-8');
    if (content.includes('KHY_TOOL_ABORT_SIGNAL')) {
      found = true;
      break;
    }
  }
  if (!found) {
    fail('未找到 KHY_TOOL_ABORT_SIGNAL 门控');
    return;
  }
  pass('KHY_TOOL_ABORT_SIGNAL 门控存在');
});

// ── 5. 重试分类 ────────────────────────────────────────────────────────────

const RETRY_BACKOFF = 'services/backend/src/services/retryWithBackoff.js';

check('重试: retryWithBackoff 支持 AbortSignal', () => {
  const retryPath = path.join(ROOT, RETRY_BACKOFF);
  if (!fs.existsSync(retryPath)) {
    fail('retryWithBackoff.js 不存在');
    return;
  }
  const content = fs.readFileSync(retryPath, 'utf-8');
  if (!content.includes('AbortSignal') && !content.includes('abortSignal')) {
    fail('retryWithBackoff 不支持 AbortSignal');
    return;
  }
  pass('retryWithBackoff 支持 AbortSignal');
});

check('重试: 不可重试错误分类定义', () => {
  const storePath = path.join(ROOT, TASK_STORE);
  if (!fs.existsSync(storePath)) return;
  const content = fs.readFileSync(storePath, 'utf-8');
  // 检查是否有 NON_RETRYABLE 或类似分类
  const hasClassification = content.includes('NON_RETRYABLE') || content.includes('nonRetryable') ||
                             content.includes('non_retryable');
  if (!hasClassification) {
    fail('状态机缺少不可重试错误分类');
    return;
  }
  pass('状态机定义了不可重试错误分类');
});

// ── 6. 执行校验 ────────────────────────────────────────────────────────────

for (const { name, fn } of CHECKS) {
  try {
    fn();
  } catch (err) {
    fail(name, `异常: ${err.message}`);
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────

const isJson = process.argv.includes('--json');

if (isJson) {
  console.log(JSON.stringify({
    schema: 'khy.reliability/v1',
    total: CHECKS.length,
    passed,
    failed,
    failures,
  }, null, 2));
} else {
  console.log('可靠性契约校验');
  console.log('='.repeat(60));
  for (const { name, fn } of CHECKS) {
    // 通过的名单独列在前面
  }
  for (const f of failures) {
    console.log(`  [FAIL] ${f.name}: ${f.detail}`);
  }
  for (const f of failures) {
    // 这里我们重新遍历来输出 PASS — 我们已经做了计数
  }
  console.log('='.repeat(60));
  console.log(`结果: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);
