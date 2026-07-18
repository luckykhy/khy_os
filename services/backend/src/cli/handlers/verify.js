/**
 * CLI Handler: cross-platform delivery verification.
 *
 * Commands:
 *   khy verify              Full auto-detect verification
 *   khy verify node         Node.js project only
 *   khy verify python       Python project only
 *   khy verify wasm         WASM module only
 *   khy verify docker       Docker build only
 *
 * Options:
 *   --verbose     Include info-level issues
 *   --platform X  Check specific platform (darwin|linux|win32)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable,
} = require('../formatters');

const ICON_CHECK = chalk.green('✓');
const ICON_WARN  = chalk.yellow('⚠');
const ICON_CROSS = chalk.red('✗');
const ICON_GEAR  = '⚙';
const DEFAULT_WORKFLOW_TIMEOUT_MS = 45000;
const DEFAULT_WORKFLOW_MAX_ADAPTERS = 3;

// 收敛到 utils/markProcessFailure 单一真源(逐字节委托,调用点不变)
const _markFailure = require('../../utils/markProcessFailure');

function _toInt(value, fallback, min = 1) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  return n;
}

function _toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function _formatMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

function _truncate(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function _normalizeAdapterKey(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = {
    local: 'localLLM',
    localllm: 'localLLM',
    local_llm: 'localLLM',
    ollma: 'ollama',
    relayapi: 'relay_api',
    bridge: 'relay_api',
  };
  return map[raw] || raw;
}

function _stringIncludesAny(input, patterns = []) {
  const text = String(input || '').toLowerCase();
  return patterns.some(p => text.includes(String(p).toLowerCase()));
}

function _resolveProbeErrorType(probe = {}) {
  const explicit = String(probe?.errorType || probe?.result?.errorType || '').trim().toLowerCase();
  if (explicit) return explicit;
  const text = String(probe?.reason || probe?.result?.error || probe?.result?.content || '').toLowerCase();
  if (/aborted|cancelled|canceled|请求已取消/.test(text)) return 'cancelled';
  if (/timeout|timed out|deadline exceeded/.test(text)) return 'timeout';
  if (/reconnecting|channel closed|failed to record rollout items|spawn|process|stream disconnected/.test(text)) return 'process';
  if (/network|fetch failed|econn|enotfound|ehostunreach|enetunreach|getaddrinfo|socket/.test(text)) return 'network';
  if (/unauthorized|forbidden|api key|token|未配置|not configured|auth|login/.test(text)) return 'auth';
  if (/not installed|not found|unavailable|不可用/.test(text)) return 'unavailable';
  if (/permission|eacces|eperm|sandbox/.test(text)) return 'permission';
  return 'unknown';
}

function _isSoftAiProbeFailure(probe = {}) {
  if (!probe || probe.ok) return false;
  const t = _resolveProbeErrorType(probe);
  // External dependency / environment / auth / transient channel errors are soft by default.
  return ['cancelled', 'timeout', 'process', 'network', 'auth', 'unavailable', 'permission'].includes(t);
}

function _resolveWorkflowAdapters(statuses = [], options = {}) {
  const enabledAvailable = statuses.filter(s => s && s.enabled && s.available);
  const enabledAny = statuses.filter(s => s && s.enabled);
  const explicit = String(options.adapter || options.adapters || options.channel || '').trim();
  const includeAll = _toBool(options['all-adapters'] || options.allAdapters, false) || explicit.toLowerCase() === 'all';
  const maxAdapters = _toInt(options['max-adapters'] || options.maxAdapters, DEFAULT_WORKFLOW_MAX_ADAPTERS, 1);

  if (includeAll) {
    return [...new Set(enabledAny.map(s => s.type).filter(Boolean))];
  }

  if (explicit) {
    return explicit
      .split(',')
      .map(s => _normalizeAdapterKey(s))
      .filter(Boolean)
      .filter((key, idx, arr) => arr.indexOf(key) === idx)
      .slice(0, maxAdapters);
  }

  const preferredOrder = ['api', 'relay_api', 'ollama', 'localLLM', 'codex', 'claude', 'cli'];
  const picked = [];
  for (const key of preferredOrder) {
    const found = enabledAvailable.find(s => String(s.type || '').toLowerCase() === key.toLowerCase());
    if (found) picked.push(found.type);
    if (picked.length >= maxAdapters) break;
  }
  if (picked.length > 0) return [...new Set(picked)];

  const fallback = enabledAvailable.map(s => s.type).filter(Boolean);
  return [...new Set(fallback)].slice(0, maxAdapters);
}

async function _runAiProbe(gateway, adapterKey, label, prompt, timeoutMs, expectFn = null) {
  const startedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(new Error(`${label} timeout`)); } catch { /* ignore */ }
  }, timeoutMs);
  timer.unref?.();

  let lastStatus = '';
  const prevStrictRelax = process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
  process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'false';
  try {
    const result = await gateway.generate(prompt, {
      preferredAdapter: adapterKey,
      preferredStrict: true,
      strictPreferred: true,
      maxTokens: 120,
      temperature: 0.1,
      abortSignal: ac.signal,
      onStatus: (msg) => {
        const text = typeof msg === 'string' ? msg : String(msg?.message || '');
        const normalized = text.trim();
        if (!normalized || normalized === lastStatus) return;
        lastStatus = normalized;
        printInfo(`[${adapterKey}] ${normalized}`);
      },
    });

    const durationMs = Date.now() - startedAt;
    const text = String(result?.content || '').trim();
    const actualAdapter = String(result?.actualAdapter || result?.adapter || '').trim();
    let ok = !!result?.success && text.length > 0;
    let reason = text ? _truncate(text, 80) : (result?.content || result?.errorType || 'empty response');

    if (typeof expectFn === 'function' && !expectFn(text)) {
      ok = false;
      reason = 'question answered but format/intent mismatch';
    }
    if (actualAdapter && String(actualAdapter).toLowerCase() !== String(adapterKey).toLowerCase()) {
      ok = false;
      reason = `fallback used (${adapterKey} -> ${actualAdapter})`;
    }

    return {
      ok,
      durationMs,
      reason,
      errorType: String(result?.errorType || '').trim() || null,
      result,
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const lower = String(message || '').toLowerCase();
    let errorType = 'unknown';
    if (/aborted|cancelled|canceled/.test(lower)) errorType = 'cancelled';
    else if (/timeout|timed out|deadline exceeded/.test(lower)) errorType = 'timeout';
    else if (/reconnecting|channel closed|failed to record rollout items|spawn|stream disconnected/.test(lower)) errorType = 'process';
    else if (/network|fetch failed|econn|enotfound|ehostunreach|enetunreach|getaddrinfo|socket/.test(lower)) errorType = 'network';
    else if (/unauthorized|forbidden|api key|token|not configured|auth|login|未配置/.test(lower)) errorType = 'auth';
    else if (/not installed|not found|unavailable|不可用/.test(lower)) errorType = 'unavailable';
    else if (/permission|eacces|eperm|sandbox/.test(lower)) errorType = 'permission';
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      reason: message,
      errorType,
      result: null,
    };
  } finally {
    if (prevStrictRelax === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    else process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = prevStrictRelax;
    clearTimeout(timer);
  }
}

async function _runAdapterWorkflowSuite(gateway, adapterKey, timeoutMs) {
  printInfo(`[${adapterKey}] 开始 T3 提问链路测试`);
  const qa = await _runAiProbe(
    gateway,
    adapterKey,
    'qa',
    '请简要回答：2+2 等于几？',
    timeoutMs
  );

  printInfo(`[${adapterKey}] 开始 T5 闲聊链路测试`);
  const chat = await _runAiProbe(
    gateway,
    adapterKey,
    'chat',
    '请用一句话回复：聊天链路正常',
    timeoutMs
  );

  return {
    adapter: adapterKey,
    qa,
    chat,
    ok: qa.ok && chat.ok,
  };
}

function _buildWorkflowFixSuggestions(suites = []) {
  const localSet = new Set(['localllm', 'ollama']);
  const localFailures = [];
  const remoteFailures = [];
  let authMissingLikely = false;

  for (const suite of suites) {
    const adapter = String(suite?.adapter || '').trim();
    const adapterLower = adapter.toLowerCase();
    const failed = !(suite?.qa?.ok && suite?.chat?.ok);
    if (!failed) continue;

    const reasonText = `${suite?.qa?.reason || ''} ${suite?.chat?.reason || ''}`.trim();
    if (_stringIncludesAny(reasonText, ['api key', 'token', 'unauthorized', 'forbidden', '401', '403', '未配置', 'not configured'])) {
      authMissingLikely = true;
    }

    if (localSet.has(adapterLower)) localFailures.push({ adapter, reasonText });
    else remoteFailures.push({ adapter, reasonText });
  }

  const suggestions = [];

  if (remoteFailures.length > 0) {
    suggestions.push({
      id: 'prefer_remote',
      title: '自动切换到可用远程通道',
      cmd: 'khy gateway prefer-remote',
      canAutoFix: true,
    });
  }

  if (localFailures.length > 0) {
    suggestions.push({
      id: 'tune_local',
      title: '应用本地模型智能调优（fast 档）',
      cmd: 'khy gateway tune-local fast apply',
      canAutoFix: true,
    });
  }

  if (authMissingLikely) {
    suggestions.push({
      id: 'config_auth',
      title: '补全 API/桥接凭证',
      cmd: 'khy ai config',
      canAutoFix: false,
    });
  }

  suggestions.push({
    id: 'retry_timeout',
    title: '放宽探测超时后重测',
    cmd: 'khy verify workflow --timeout 12000',
    canAutoFix: false,
  });

  return suggestions;
}

async function _applyWorkflowAutoFixes(suggestions = []) {
  const gatewayHandler = require('./gateway');
  const actions = suggestions
    .filter(s => s && s.canAutoFix)
    .map(s => s.id);

  if (actions.length === 0) {
    printInfo('未找到可自动执行的修复动作');
    return { applied: 0, failed: 0 };
  }

  let applied = 0;
  let failed = 0;
  for (const id of actions) {
    try {
      if (id === 'prefer_remote') {
        printInfo('自动修复: 切换远程通道中...');
        await gatewayHandler.handleGatewayPreferRemote({ silent: false, probeOnlyAvailable: false });
        applied += 1;
      } else if (id === 'tune_local') {
        printInfo('自动修复: 本地模型调优写入中...');
        await gatewayHandler.handleGatewayTuneLocal(['fast', 'apply'], { apply: true });
        applied += 1;
      }
    } catch (err) {
      failed += 1;
      printWarn(`自动修复失败(${id}): ${err.message || err}`);
    }
  }

  return { applied, failed };
}

async function _runWorkflowPass({ projectPath, timeoutMs, parallel, options = {} }) {
  const startedAt = Date.now();
  const rows = [];
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let adapterSuites = [];
  const strictAi = _toBool(options['strict-ai'] || options.strictAi, false);

  const pushRow = (taskId, taskName, stateOrOk, durationMs, detail) => {
    const state = typeof stateOrOk === 'boolean'
      ? (stateOrOk ? 'pass' : 'fail')
      : String(stateOrOk || 'fail').toLowerCase();
    const statusLabel = state === 'pass'
      ? `${ICON_CHECK} PASS`
      : (state === 'warn' ? `${ICON_WARN} SKIP` : `${ICON_CROSS} FAIL`);
    rows.push([
      taskId,
      taskName,
      statusLabel,
      _formatMs(durationMs),
      detail,
    ]);
    if (state === 'pass') passed += 1;
    else if (state === 'warn') warned += 1;
    else failed += 1;
  };

  // T1: Read file
  {
    const t = Date.now();
    printInfo('T1 读文件测试进行中...');
    try {
      const candidates = [
        'pyproject.toml',
        'package.json',
        'README.md',
        'backend/package.json',
        'backend/src/cli/router.js',
      ];
      const found = candidates.find(rel => fs.existsSync(path.join(projectPath, rel)));
      if (!found) {
        pushRow('T1', '读文件', false, Date.now() - t, '未找到可读取的测试文件');
      } else {
        const content = fs.readFileSync(path.join(projectPath, found), 'utf-8');
        const firstLine = _truncate((content.split('\n').find(line => line.trim()) || '').trim(), 70);
        const ok = content.length > 0;
        pushRow('T1', '读文件', ok, Date.now() - t, ok ? `${found} (${content.length} bytes)` : `读取为空: ${found}`);
        if (ok && firstLine) printInfo(`T1 样本: ${firstLine}`);
      }
    } catch (err) {
      pushRow('T1', '读文件', false, Date.now() - t, err.message || String(err));
    }
  }

  // T2: Execute command
  {
    const t = Date.now();
    printInfo('T2 执行命令测试进行中...');
    try {
      const result = spawnSync('node', ['--version'], {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 8000,
      });
      const ok = result.status === 0 && String(result.stdout || '').trim().length > 0;
      const detail = ok
        ? `node ${String(result.stdout || '').trim()}`
        : `exit=${result.status} ${_truncate(result.stderr || result.stdout || 'unknown error', 90)}`;
      pushRow('T2', '执行命令', ok, Date.now() - t, detail);
    } catch (err) {
      pushRow('T2', '执行命令', false, Date.now() - t, err.message || String(err));
    }
  }

  // T4: Edit file
  {
    const t = Date.now();
    printInfo('T4 修改文件测试进行中...');
    try {
      const dir = path.join(os.tmpdir(), 'khy-workflow-selftest');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `workflow-${Date.now()}.txt`);
      fs.writeFileSync(file, 'khy workflow selftest\n', 'utf-8');
      fs.appendFileSync(file, 'step=T4\n', 'utf-8');
      const content = fs.readFileSync(file, 'utf-8');
      const ok = content.includes('step=T4');
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      pushRow('T4', '修改文件', ok, Date.now() - t, ok ? 'tmp write+append+read verified' : '写入校验失败');
    } catch (err) {
      pushRow('T4', '修改文件', false, Date.now() - t, err.message || String(err));
    }
  }

  // T3 + T5: AI question/chat probes per adapter
  {
    const t = Date.now();
    printInfo('T3/T5 AI 通道测试准备中...');
    try {
      const gateway = require('../../services/gateway/aiGateway');
      if (!gateway._initialized) await gateway.init();
      const statuses = gateway.getStatus();
      const adapters = _resolveWorkflowAdapters(statuses, options);

      if (adapters.length === 0) {
        pushRow('T3', '提问', false, Date.now() - t, '未找到可用适配器');
        pushRow('T5', '闲聊', false, Date.now() - t, '未找到可用适配器');
      } else {
        printInfo(`T3/T5 目标适配器: ${adapters.join(', ')}`);
        const runOne = (adapterKey) => _runAdapterWorkflowSuite(gateway, adapterKey, timeoutMs);
        const suites = [];

        if (parallel) {
          const settled = await Promise.allSettled(adapters.map(adapterKey => runOne(adapterKey)));
          for (const item of settled) {
            if (item.status === 'fulfilled') suites.push(item.value);
            else suites.push({
              adapter: 'unknown',
              qa: { ok: false, reason: item.reason?.message || String(item.reason), durationMs: 0 },
              chat: { ok: false, reason: item.reason?.message || String(item.reason), durationMs: 0 },
              ok: false,
            });
          }
        } else {
          for (const adapterKey of adapters) {
            suites.push(await runOne(adapterKey));
          }
        }

        const qaOk = suites.length > 0 && suites.every(s => s.qa.ok);
        const chatOk = suites.length > 0 && suites.every(s => s.chat.ok);
        const qaAllSoftFail = suites.length > 0 && suites.every(s => s.qa.ok || _isSoftAiProbeFailure(s.qa));
        const chatAllSoftFail = suites.length > 0 && suites.every(s => s.chat.ok || _isSoftAiProbeFailure(s.chat));
        adapterSuites = suites;
        const qaDetail = suites.map((s) => `${s.adapter}:${s.qa.ok ? 'OK' : `FAIL(${_truncate(s.qa.reason, 36)})`}`).join(' | ');
        const chatDetail = suites.map((s) => `${s.adapter}:${s.chat.ok ? 'OK' : `FAIL(${_truncate(s.chat.reason, 36)})`}`).join(' | ');

        const qaState = qaOk ? 'pass' : ((!strictAi && qaAllSoftFail) ? 'warn' : 'fail');
        const chatState = chatOk ? 'pass' : ((!strictAi && chatAllSoftFail) ? 'warn' : 'fail');
        pushRow('T3', '提问', qaState, Date.now() - t, qaDetail);
        pushRow('T5', '闲聊', chatState, Date.now() - t, chatDetail);

        if (!strictAi && (qaState === 'warn' || chatState === 'warn')) {
          printWarn('检测到 AI 通道外部依赖异常（网络/登录态/本地能力受限），T3/T5 已按 SKIP 软失败处理');
          printInfo('如需严格失败，请追加参数: --strict-ai');
        }
      }
    } catch (err) {
      const message = err.message || String(err);
      pushRow('T3', '提问', false, Date.now() - t, message);
      pushRow('T5', '闲聊', false, Date.now() - t, message);
    }
  }

  console.log('');
  printTable(['Task', 'Name', 'Status', 'Duration', 'Detail'], rows);
  console.log('');

  return {
    success: failed === 0,
    passed,
    warned,
    failed,
    durationMs: Date.now() - startedAt,
    rows,
    adapterSuites,
  };
}

function _formatWorkflowSummary(result) {
  const warned = Number(result?.warned || 0);
  if (warned > 0) {
    return `${result.passed} passed / ${warned} skipped / ${result.failed} failed · total ${_formatMs(result.durationMs)}`;
  }
  return `${result.passed} passed / ${result.failed} failed · total ${_formatMs(result.durationMs)}`;
}

function _printWorkflowABCompare(beforeResult, afterResult) {
  if (!beforeResult || !afterResult) return;
  const beforeMap = new Map((beforeResult.rows || []).map(r => [String(r[0]), r]));
  const afterMap = new Map((afterResult.rows || []).map(r => [String(r[0]), r]));
  const tasks = ['T1', 'T2', 'T3', 'T4', 'T5'];

  console.log('');
  printInfo('AB 对照（修复前 -> 修复后）:');
  for (const task of tasks) {
    const a = beforeMap.get(task);
    const b = afterMap.get(task);
    if (!a || !b) continue;
    const parseStatus = (value) => {
      const s = String(value || '').toUpperCase();
      if (s.includes('PASS')) return 'PASS';
      if (s.includes('SKIP')) return 'SKIP';
      return 'FAIL';
    };
    const aStatus = parseStatus(a[2]);
    const bStatus = parseStatus(b[2]);
    console.log(`  ${task}: ${aStatus} -> ${bStatus}`);
    if (aStatus !== bStatus || bStatus === 'FAIL') {
      console.log(`     A: ${_truncate(a[4] || '', 120)}`);
      console.log(`     B: ${_truncate(b[4] || '', 120)}`);
    }
  }
  console.log('');
}

async function handleVerifyWorkflow(args = [], options = {}) {
  const projectPath = path.resolve(args[0] || process.cwd());
  const timeoutMs = _toInt(options.timeout || options['timeout-ms'], DEFAULT_WORKFLOW_TIMEOUT_MS, 3000);
  const parallel = _toBool(options.parallel, true);
  const autoFix = _toBool(options.autofix || options.fix, false);
  const retestAfterFix = autoFix && _toBool(options.retest, true);

  console.log(`\n  ${ICON_GEAR}  ${chalk.cyan.bold('Workflow Stability Verification (T1-T5)')}\n`);
  console.log(`  Project: ${chalk.dim(projectPath)}`);
  console.log(`  Timeout: ${chalk.dim(`${timeoutMs}ms / AI probe`)}`);
  console.log(`  Mode:    ${chalk.dim(parallel ? 'parallel adapters' : 'serial adapters')}\n`);
  if (autoFix) {
    printInfo('AutoFix: 已启用（仅执行安全自动修复动作）');
    if (retestAfterFix) printInfo('Retest: AutoFix 后自动执行 B 轮复测');
    console.log('');
  }

  printInfo('A 轮测试开始（修复前基线）...');
  const baseline = await _runWorkflowPass({
    projectPath,
    timeoutMs,
    parallel,
    options,
  });

  if (baseline.success) {
    if (Number(baseline.warned || 0) > 0) {
      printWarn(`Workflow stability test passed with skips: ${_formatWorkflowSummary(baseline)}`);
    } else {
      printSuccess(`Workflow stability test passed: ${_formatWorkflowSummary(baseline)}`);
    }
    return baseline;
  }

  printWarn(`Workflow stability test finished with failures: ${_formatWorkflowSummary(baseline)}`);
  const suggestions = _buildWorkflowFixSuggestions(baseline.adapterSuites);
  if (suggestions.length > 0) {
    console.log('');
    printInfo('建议操作:');
    suggestions.forEach((s, idx) => {
      const auto = s.canAutoFix ? ' (可自动修复)' : '';
      console.log(`  ${idx + 1}. ${s.title}${auto}`);
      console.log(`     ${chalk.dim(s.cmd)}`);
    });
    console.log('');
  }

  if (!autoFix) {
    _markFailure();
    return baseline;
  }

  printInfo('已启用 --autofix，开始尝试自动修复...');
  const fixResult = await _applyWorkflowAutoFixes(suggestions);
  if (fixResult.applied > 0 && fixResult.failed === 0) {
    printSuccess(`自动修复完成: ${fixResult.applied} 项成功`);
  } else if (fixResult.applied > 0 || fixResult.failed > 0) {
    printWarn(`自动修复完成: 成功 ${fixResult.applied}，失败 ${fixResult.failed}`);
  }

  if (!retestAfterFix || fixResult.applied <= 0) {
    _markFailure();
    return {
      ...baseline,
      autoFix: fixResult,
      retest: null,
    };
  }

  printInfo('B 轮测试开始（自动修复后复测）...');
  const afterFix = await _runWorkflowPass({
    projectPath,
    timeoutMs,
    parallel,
    options,
  });
  const afterSummary = _formatWorkflowSummary(afterFix);
  if (afterFix.success) {
    printSuccess(`B 轮复测通过: ${afterSummary}`);
  } else {
    printWarn(`B 轮复测仍失败: ${afterSummary}`);
  }
  _printWorkflowABCompare(baseline, afterFix);

  if (!afterFix.success) _markFailure();

  return {
    success: afterFix.success,
    passed: afterFix.passed,
    warned: afterFix.warned || 0,
    failed: afterFix.failed,
    durationMs: baseline.durationMs + afterFix.durationMs,
    rows: afterFix.rows,
    baseline,
    retest: afterFix,
    autoFix: fixResult,
  };
}

/**
 * Main handler — dispatches to deliveryValidator service.
 */
async function handleVerify(subCommand, args = [], options = {}) {
  if (['workflow', 'wf', 'tasks', 'pipeline'].includes(String(subCommand || '').toLowerCase())) {
    return handleVerifyWorkflow(args, options);
  }

  const validator = require('../../services/deliveryValidator');
  const projectPath = args[0] || process.cwd();

  const types = subCommand && subCommand !== 'verify'
    ? [_normalizeType(subCommand)]
    : null;

  const platforms = options.platform
    ? [_normalizePlatform(options.platform)]
    : null;

  console.log(`\n  ${ICON_GEAR}  ${chalk.cyan.bold('Cross-Platform Delivery Verification')}\n`);
  console.log(`  Project: ${chalk.dim(projectPath)}`);

  let report;
  try {
    report = await validator.validate(projectPath, {
      types,
      platforms,
      verbose: !!options.verbose,
    });
  } catch (err) {
    printError(`Verification failed: ${err.message}`);
    return null;
  }

  console.log(`  Type:    ${chalk.cyan(report.projectType)}`);
  console.log(`  Time:    ${report.durationMs}ms\n`);

  // ── Issues ──────────────────────────────────────────────────────────

  if (report.issues.length === 0) {
    printSuccess('No issues found — project looks ready for cross-platform delivery.');
  } else {
    // Group by rule prefix
    const groups = {};
    for (const issue of report.issues) {
      const group = issue.rule.split('/')[0];
      if (!groups[group]) groups[group] = [];
      groups[group].push(issue);
    }

    for (const [group, issues] of Object.entries(groups)) {
      console.log(`  ${chalk.bold(_groupLabel(group))} (${issues.length} issues)\n`);

      for (const issue of issues) {
        const icon = issue.severity === 'error' ? ICON_CROSS
          : issue.severity === 'warning' ? ICON_WARN : chalk.blue('ℹ');
        const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
        const platforms = issue.platforms.length > 0
          ? chalk.dim(` [${issue.platforms.join(', ')}]`)
          : '';
        console.log(`    ${icon} ${chalk.dim(loc)} ${issue.message}${platforms}`);
      }
      console.log('');
    }
  }

  // ── Score Bar ───────────────────────────────────────────────────────

  const scoreColor = report.score >= 80 ? chalk.green
    : report.score >= 50 ? chalk.yellow : chalk.red;
  const bar = _scoreBar(report.score);
  const verdictText = report.verdict === 'pass' ? chalk.green.bold('PASS')
    : report.verdict === 'warn' ? chalk.yellow.bold('WARN') : chalk.red.bold('FAIL');

  console.log(`  Score: ${scoreColor.bold(report.score)} / 100  ${bar}  ${verdictText}`);

  // ── Platform Readiness Matrix ───────────────────────────────────────

  console.log(`\n  ${chalk.bold('Platform Readiness')}\n`);
  printTable(
    ['Platform', 'Status'],
    [
      ['Linux',   report.platformReady.linux  ? `${ICON_CHECK} Ready` : `${ICON_CROSS} Issues`],
      ['Windows', report.platformReady.win32  ? `${ICON_CHECK} Ready` : `${ICON_CROSS} Issues`],
      ['macOS',   report.platformReady.darwin ? `${ICON_CHECK} Ready` : `${ICON_CROSS} Issues`],
    ],
  );

  // ── Summary Line ────────────────────────────────────────────────────

  const errors   = report.issues.filter(i => i.severity === 'error').length;
  const warnings = report.issues.filter(i => i.severity === 'warning').length;
  const infos    = report.issues.filter(i => i.severity === 'info').length;

  console.log(`\n  ${chalk.green(errors === 0 ? '✓' : errors)} errors  ` +
    `${chalk.yellow(warnings)} warnings  ${chalk.blue(infos)} info\n`);

  return report;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _normalizeType(type) {
  const map = { node: 'nodejs', nodejs: 'nodejs', python: 'python', py: 'python',
    wasm: 'wasm', docker: 'docker' };
  return map[type] || type;
}

function _normalizePlatform(platform) {
  const map = { windows: 'win32', win: 'win32', win32: 'win32',
    mac: 'darwin', macos: 'darwin', darwin: 'darwin',
    linux: 'linux' };
  return map[platform] || platform;
}

function _groupLabel(group) {
  const labels = {
    node: 'Node.js', python: 'Python', wasm: 'WebAssembly',
    docker: 'Docker',
  };
  return labels[group] || group;
}

function _scoreBar(score) {
  const total = 20;
  const filled = Math.round(score / 100 * total);
  const empty = total - filled;
  const color = score >= 80 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

module.exports = { handleVerify };
