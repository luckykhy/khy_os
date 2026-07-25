'use strict';

/**
 * Gateway runtime probes & relay subsystem (extracted from cli/handlers/gateway.js).
 *
 * Owns: web-relay bootstrap, IDE/adapter detection, AI-channel connectivity test,
 * tool-calling capability probe, and the end-to-end sample self-check. Extracted verbatim
 * (byte-identical bodies) as a same-directory sibling leaf so in-body relative require()
 * paths resolve identically; the host re-imports every public handler by the same name to
 * keep the `gateway relay|detect|test|probe-tools|sample` command contracts unchanged.
 *
 * This leaf performs IO (spawns the khy binary for sampling, reads run artifacts, prints to
 * the terminal) so it does NOT self-declare as a pure zero-IO leaf. The four host callbacks it
 * still needs (prompt guard, reason compaction, home-risk snapshot, .env writer) are injected
 * via setGatewayRuntimeProbesDeps to avoid a require cycle back into the host.
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  printSuccess,
  printError,
  printInfo,
  printTable,
  stripAnsi,
} = require('../formatters');
const {
  buildGatewayRelayFeatureLabel,
  getFeatureFamilyPrefix,
} = require('../../services/featureKeyBuilder');
const { _parseIntWithMin } = require('./gatewayManageDaemon');

// ── Host callbacks injected via DI (avoid a require cycle back into gateway.js) ──
let promptWithReplGuard = null;
let _compactReasonText = null;
let _getGatewayHomeRiskSnapshot = null;
let _writeEnvMap = null;

function setGatewayRuntimeProbesDeps(deps = {}) {
  if (typeof deps.promptWithReplGuard === 'function') promptWithReplGuard = deps.promptWithReplGuard;
  if (typeof deps._compactReasonText === 'function') _compactReasonText = deps._compactReasonText;
  if (typeof deps._getGatewayHomeRiskSnapshot === 'function') _getGatewayHomeRiskSnapshot = deps._getGatewayHomeRiskSnapshot;
  if (typeof deps._writeEnvMap === 'function') _writeEnvMap = deps._writeEnvMap;
}

const KHY_GATEWAY_SAMPLE_DEFAULT_PROMPT = '只用一句中文回复：已收到，不要调用工具。';
const KHY_GATEWAY_SAMPLE_DEFAULT_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.KHY_GATEWAY_SAMPLE_ATTEMPTS || '4', 10) || 4
);
const KHY_GATEWAY_SAMPLE_DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.KHY_GATEWAY_SAMPLE_FIRST_RESPONSE_TIMEOUT_MS || '20000', 10) || 20000
);
const KHY_GATEWAY_SAMPLE_MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.KHY_GATEWAY_SAMPLE_MAX_ATTEMPTS || '20', 10) || 20
);

/**
 * Explicitly start the web relay server.
 */
async function handleGatewayRelay() {
  const { requireFeatureAccess } = require('../../services/authGuard');
  const auth = requireFeatureAccess(
    getFeatureFamilyPrefix('gateway', 'relay'),
    buildGatewayRelayFeatureLabel()
  );
  if (!auth.ok) {
    printError(auth.error);
    return;
  }

  const gateway = require('../../services/gateway/aiGateway');
  const relay = gateway.getRelayAdapter();

  if (relay.isRunning()) {
    printInfo(`中转服务已在运行: http://localhost:${relay.getPort()}`);
    return;
  }

  const port = await relay.start();
  console.log('');
  printSuccess(`AI 中转服务已启动`);
  console.log('');
  console.log(chalk.bold(`  🌐 打开浏览器访问: ${chalk.cyan(`http://localhost:${port}`)}`));
  console.log('');
  console.log(chalk.dim('  使用方式:'));
  console.log(chalk.dim('    1. 终端发送 AI 请求后，提示会出现在网页上'));
  console.log(chalk.dim('    2. 点击「一键复制」将提示复制到剪贴板'));
  console.log(chalk.dim('    3. 粘贴到任意 AI 网页（ChatGPT、Claude、Gemini 等）'));
  console.log(chalk.dim('    4. 复制 AI 回复，粘贴到网页文本框，点击「提交」'));
  console.log(chalk.dim('    5. 回复将自动返回到终端'));
  console.log('');
}

/**
 * Detect IDE installations and allow manual path configuration.
 */
async function handleGatewayDetect(options = {}) {
  const asJson = !!options.json;
  const isInteractive = !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {
  const { detectAll, setCustomPath, findInstallation, findDataPath } = require('../../services/gateway/adapters/ideDetector');

  const results = detectAll();
  const normalized = results.map((r) => ({
    name: r.name,
    installPath: r.installPath || '',
    dataPath: r.dataPath || '',
    available: !!r.available,
  }));
  const missing = normalized.filter(r => !r.available);

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'detect',
      interactive: false,
      requiresTTY: missing.length > 0,
      count: normalized.length,
      missingCount: missing.length,
      ides: normalized,
      missing: missing.map(r => ({
        name: r.name,
        envKey: `${String(r.name || '').toUpperCase()}_INSTALL_PATH`,
      })),
      message: missing.length > 0
        ? '未检测到的 IDE 可在交互终端手动设置安装路径。'
        : '所有已知 IDE 均已检测完成。',
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${chalk.cyan.bold('IDE 安装检测')}`);
  console.log('');

  printTable(
    ['IDE', '安装路径', '数据路径', '状态'],
    results.map(r => [
      r.name.charAt(0).toUpperCase() + r.name.slice(1),
      r.installPath || chalk.dim('未找到'),
      r.dataPath ? chalk.dim('✓') : chalk.dim('—'),
      r.available ? chalk.green('✓ 已检测') : chalk.yellow('⚠ 未检测到'),
    ])
  );
  console.log('');

  // Offer to set custom paths for missing IDEs
  if (missing.length > 0) {
    if (!isInteractive) {
      printError('gateway detect 需要交互终端才能设置缺失 IDE 的安装路径。可使用 --json 获取检测结果。');
      return;
    }
    printInfo('未检测到的 IDE 可手动设置安装路径');

    const { action } = await promptWithReplGuard([{
      type: 'list',
      name: 'action',
      message: '操作:',
      choices: [
        ...missing.map(r => ({
          name: `设置 ${r.name} 安装路径`,
          value: r.name,
        })),
        { name: '↩️  返回', value: 'back' },
      ],
    }]);

    if (action !== 'back') {
      const { customPath } = await promptWithReplGuard([{
        type: 'input',
        name: 'customPath',
        message: `输入 ${action} 安装路径:`,
        validate: (v) => {
          if (!v.trim()) return '路径不能为空';
          return true;
        },
      }]);

      const envKey = `${action.toUpperCase()}_INSTALL_PATH`;
      _writeEnvMap({ [envKey]: customPath.trim() });
      setCustomPath(action, customPath.trim());

      printSuccess(`${action} 安装路径已设为: ${customPath.trim()}`);
    }
  }
  } finally {
    if (!hadGuard) global.__KHY_INQUIRER_ACTIVE__ = false;
    try { process.stdin.resume(); } catch { /* ignore */ }
  }
}

/**
 * Two-step connectivity test for all or specific adapters.
 * Pattern inspired by cc-haha ProviderTestResult (connectivity + models).
 */
async function handleGatewayTest(targetAdapter, options = {}) {
  const gateway = require('../../services/gateway/aiGateway');
  const asJson = !!options.json;
  if (!gateway._initialized) await gateway.init();

  const statuses = gateway.getStatus();
  const toTest = targetAdapter
    ? statuses.filter(s => s.type === targetAdapter || s.name.toLowerCase().includes(targetAdapter.toLowerCase()))
    : statuses.filter(s => s.enabled);

  if (toTest.length === 0) {
    const message = targetAdapter ? `未找到适配器: ${targetAdapter}` : '无已启用的适配器';
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'test',
        target: targetAdapter || null,
        count: 0,
        adapters: [],
        error: targetAdapter ? 'adapter_not_found' : 'no_enabled_adapters',
        message,
      }, null, 2));
    } else {
      printError(message);
    }
    return;
  }

  if (!asJson) {
    console.log('');
    console.log(`  ${chalk.cyan.bold('AI 通道连通测试')}`);
    console.log('');
  }

  const jsonResults = [];

  for (const s of toTest) {
    if (!asJson) {
      console.log(`  ${chalk.bold(s.name)} ${chalk.dim(`(${s.type})`)}`);
    }

    const item = {
      name: s.name,
      type: s.type,
      enabled: !!s.enabled,
      available: !!s.available,
      detail: s.detail || '',
      connectivity: null,
      models: null,
      generation: null,
    };

    if (!s.available) {
      item.connectivity = {
        success: false,
        latencyMs: 0,
        error: s.detail || 'adapter unavailable',
      };
      jsonResults.push(item);
      if (!asJson) {
        console.log(`    ${chalk.dim('① 检测')}  ${chalk.red('● 不可用')} ${chalk.dim(s.detail || '')}`);
        console.log('');
      }
      continue;
    }

    const probeGenerationTimeoutMs = Math.max(
      1000,
      parseInt(process.env.GATEWAY_LOCAL_LLM_PROBE_TIMEOUT_MS || '30000', 10) || 30000
    );
    const result = await gateway.testAdapter(s.type, {
      probeGenerationTimeoutMs: s.type === 'localLLM' ? probeGenerationTimeoutMs : undefined,
    });
    item.connectivity = result.connectivity || null;
    item.models = result.models || null;
    item.generation = result.generation || null;
    jsonResults.push(item);

    // Step 1: Connectivity
    if (result.connectivity?.success) {
      if (!asJson) {
        console.log(`    ${chalk.dim('① 连接')}  ${chalk.green('● 已连接')} ${chalk.dim(`(${result.connectivity.latencyMs}ms)`)}`);
      }
    } else {
      if (!asJson) {
        console.log(`    ${chalk.dim('① 连接')}  ${chalk.red('● 失败:')} ${chalk.red(result.connectivity?.error || 'unknown')}`);
        console.log('');
      }
      continue;
    }

    // Step 2: Models (if tested)
    if (result.models) {
      if (result.models.success) {
        const modelNames = result.models.list?.slice(0, 3).map(m => m.name || m.id).join(', ') || '';
        const more = result.models.count > 3 ? ` +${result.models.count - 3}` : '';
        if (!asJson) {
          console.log(`    ${chalk.dim('② 模型')}  ${chalk.green('● 可用')} ${chalk.dim(`(${result.models.latencyMs}ms · ${result.models.count} models)`)}${modelNames ? chalk.dim(` ${modelNames}${more}`) : ''}`);
        }
      } else {
        if (!asJson) {
          console.log(`    ${chalk.dim('② 模型')}  ${chalk.red('● 失败:')} ${chalk.red(result.models.error || 'unknown')} ${chalk.dim(`(${result.models.latencyMs}ms)`)}`);
        }
      }
    }

    if (result.generation) {
      if (result.generation.success) {
        if (!asJson) {
          console.log(`    ${chalk.dim('③ 实测')}  ${chalk.green('● 可用')} ${chalk.dim(`(${result.generation.latencyMs}ms)`)}`);
        }
      } else {
        if (!asJson) {
          console.log(`    ${chalk.dim('③ 实测')}  ${chalk.red('● 失败:')} ${chalk.red(result.generation.error || 'unknown')} ${chalk.dim(`(${result.generation.latencyMs}ms)`)}`);
        }
      }
    }

    if (!asJson) {
      console.log('');
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'test',
      target: targetAdapter || null,
      count: jsonResults.length,
      adapters: jsonResults,
    }, null, 2));
  }
}

function _isGatewaySamplePromptInjected(content = '') {
  const text = String(content || '');
  return text.includes('# Language KHY expected output: Simplified Chinese')
    && text.includes('[KHY PRIORITY DIRECTIVE]');
}

function _readGatewaySampleRunSummary(runDir) {
  const summary = {
    runDir: String(runDir || ''),
    requestId: '',
    promptInjected: false,
    firstChunk: null,
    finalResponse: null,
    llmResponse: null,
    typeCounts: {},
    stdoutPreview: '',
    stderrPreview: '',
  };

  const promptFile = path.join(summary.runDir, 'prompt.log');
  const traceFile = path.join(summary.runDir, 'trace-events.jsonl');
  const stdoutFile = path.join(summary.runDir, 'stdout.log');
  const stderrFile = path.join(summary.runDir, 'stderr.log');

  try {
    if (fs.existsSync(promptFile)) {
      summary.promptInjected = _isGatewaySamplePromptInjected(fs.readFileSync(promptFile, 'utf8'));
    }
  } catch { /* best effort */ }

  try {
    if (fs.existsSync(traceFile)) {
      const lines = String(fs.readFileSync(traceFile, 'utf8') || '').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let event = null;
        try { event = JSON.parse(line); } catch { /* ignore malformed lines */ }
        if (!event || typeof event !== 'object') continue;
        const type = String(event.type || '').trim();
        if (!type) continue;
        summary.typeCounts[type] = (summary.typeCounts[type] || 0) + 1;
        if (!summary.requestId && event.requestId) summary.requestId = String(event.requestId);
        if (type === 'agent.language.first_chunk' && !summary.firstChunk) summary.firstChunk = event.data || {};
        if (type === 'agent.language.final_response' && !summary.finalResponse) summary.finalResponse = event.data || {};
        if (type === 'llm.response' && !summary.llmResponse) summary.llmResponse = event.data || {};
      }
    }
  } catch { /* best effort */ }

  try {
    if (fs.existsSync(stdoutFile)) {
      summary.stdoutPreview = _compactReasonText(stripAnsi(fs.readFileSync(stdoutFile, 'utf8')), 220);
    }
  } catch { /* best effort */ }

  try {
    if (fs.existsSync(stderrFile)) {
      summary.stderrPreview = _compactReasonText(stripAnsi(fs.readFileSync(stderrFile, 'utf8')), 220);
    }
  } catch { /* best effort */ }

  return summary;
}

function _summarizeGatewaySampleCounts(runs = []) {
  const summary = {
    attempts: Array.isArray(runs) ? runs.length : 0,
    promptInjectedCount: 0,
    firstChunkCount: 0,
    firstChunkZhCount: 0,
    firstChunkEnCount: 0,
    firstChunkAlignedCount: 0,
    timeoutCount: 0,
    successCount: 0,
    failureCount: 0,
  };

  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.promptInjected) summary.promptInjectedCount += 1;
    const firstChunk = run?.firstChunk || null;
    if (firstChunk) {
      summary.firstChunkCount += 1;
      const detected = String(firstChunk.detectedLanguage || '').trim().toLowerCase();
      if (detected === 'zh') summary.firstChunkZhCount += 1;
      if (detected === 'en') summary.firstChunkEnCount += 1;
      if (firstChunk.matchesExpectation === true) summary.firstChunkAlignedCount += 1;
    }
    const llmResponse = run?.llmResponse || null;
    if (llmResponse && llmResponse.success === true) summary.successCount += 1;
    if (llmResponse && llmResponse.success === false) summary.failureCount += 1;
    if (String(llmResponse?.errorType || '').trim().toLowerCase() === 'timeout') {
      summary.timeoutCount += 1;
    }
  }

  return summary;
}

/**
 * `khy gateway probe-tools [model]` — 手动触发「实测工具调用能力」。
 * 真发一个极小工具 + 提示词,看模型是否回 native tool_calls,把 verdict
 * (native / text)写进 toolCapabilityStore(~/.khyos/tool_capability.json)。
 * 不硬编码、实测为准:此后剥离门/教学门按缓存放行,名字含 flash/lite 但实测
 * 能原生调工具的模型自动晋升 native。确证通过即 sticky 常驻、绝不重复探测浪费资源。
 * adapter:--adapter 指定,否则取最高优先级且已启用的适配器。
 * `khy gateway probe-tools list`:打印已通过的模型数组(不发探测)。
 */
async function handleGatewayProbeTools(args = [], options = {}) {
  const gateway = require('../../services/gateway/aiGateway');
  const store = require('../../services/gateway/toolCapabilityStore');
  const probe = require('../../services/gateway/toolCallingProbe');
  const asJson = !!options.json;
  if (!gateway._initialized) await gateway.init();

  // list 模式:只打印「判断通过的纳入数组」(确证 native)+ 全部新鲜记录,不发探测。
  if (String(args[0] || '').trim().toLowerCase() === 'list' || options.list) {
    const passing = store.listPassing();
    const fresh = store.listFresh();
    if (asJson) {
      console.log(JSON.stringify({ ok: true, action: 'probe-tools-list', passing, fresh }, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${chalk.cyan.bold('已实测「通过」工具调用的模型(纳入数组·sticky 常驻)')}`);
    if (passing.length === 0) {
      console.log(`  ${chalk.dim('(空)—— 尚无确证通过的模型。用 khy gateway probe-tools <model> 探测')}`);
    } else {
      for (const e of passing) {
        console.log(`  ${chalk.green('✓')} ${e.model} ${chalk.dim(`(${e.source || 'probe'}${e.latencyMs != null ? ` · ${e.latencyMs}ms` : ''})`)}`);
      }
    }
    const negatives = fresh.filter(e => e.verdict === 'text');
    if (negatives.length > 0) {
      console.log('');
      console.log(`  ${chalk.dim('暂走文本协议(未确证·有界 TTL 后可重测):')}`);
      for (const e of negatives) console.log(`  ${chalk.dim(`· ${e.model}`)}`);
    }
    console.log('');
    return;
  }

  const model = String(
    args[0] || options.model || process.env.GATEWAY_PREFERRED_MODEL || ''
  ).trim();
  if (!model) {
    const message = '请指定模型: khy gateway probe-tools <model>（或设置 GATEWAY_PREFERRED_MODEL）';
    if (asJson) console.log(JSON.stringify({ ok: false, action: 'probe-tools', error: 'no_model', message }, null, 2));
    else printError(message);
    return;
  }

  // 解析 adapter key:显式 --adapter 优先,否则取最高优先级且 enabled 的适配器。
  let adapterKey = String(options.adapter || '').trim().toLowerCase();
  const adapters = Array.isArray(gateway._adapters) ? gateway._adapters : [];
  if (!adapterKey) {
    const enabled = adapters
      .filter(a => a && a.enabled)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    adapterKey = (enabled[0] && enabled[0].key) || '';
  }
  if (!adapterKey) {
    const message = '无可用适配器进行探测';
    if (asJson) console.log(JSON.stringify({ ok: false, action: 'probe-tools', error: 'no_adapter', message }, null, 2));
    else printError(message);
    return;
  }

  if (!probe.isEnabled()) {
    const message = '工具能力探测已禁用 (KHY_TOOL_CAP_PROBE)。仍可继续本次手动探测。';
    if (!asJson) printInfo(message);
  }

  if (!asJson) {
    console.log('');
    console.log(`  ${chalk.cyan.bold('实测工具调用能力')}  ${chalk.dim(`${adapterKey} · ${model}`)}`);
  }

  const result = await gateway.verifyToolCalling(adapterKey, model);
  const record = store.getRecord(model);

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'probe-tools',
      adapter: adapterKey,
      model,
      verdict: result.verdict,
      latencyMs: result.latencyMs ?? null,
      error: result.error || null,
      recorded: record ? { verdict: record.verdict, source: record.source, measuredAt: record.measuredAt } : null,
    }, null, 2));
    return;
  }

  if (result.verdict === 'native') {
    printSuccess(`原生工具调用 ✓ (native) · ${result.latencyMs ?? '?'}ms — 此后将原生发送 tools`);
  } else if (result.verdict === 'text') {
    printInfo(`无原生工具调用 (text) · ${result.latencyMs ?? '?'}ms — 此后剥离 tools、教学 <tool_call> 文本协议`);
  } else {
    printError(`探测未能判定 (unknown)${result.error ? ` · ${result.error}` : ''} — 未写入缓存,留待重测`);
  }
  if (record) {
    console.log(`  ${chalk.dim(`已缓存: ${record.verdict} (${record.source})`)}`);
  }
  console.log('');
}

async function handleGatewaySample(args = [], options = {}) {
  const adapter = String(args[0] || options.adapter || 'codex').trim().toLowerCase() || 'codex';
  const asJson = !!options.json;
  if (adapter !== 'codex') {
    printError(`gateway sample 当前只支持 codex，收到: ${adapter}`);
    printInfo('用法: gateway sample [codex] [--attempts 4] [--timeout-ms 20000] [--prompt "只用一句中文回复"] [--dir /tmp/khy-gateway-sample] [--json]');
    return;
  }

  const attemptsRaw = options.attempts ?? options.count ?? options.n;
  const timeoutRaw = options['timeout-ms'] ?? options.timeoutMs ?? options.timeout_ms;
  const hardTimeoutRaw = options['hard-timeout-ms'] ?? options.hardTimeoutMs ?? options.hard_timeout_ms;
  const prompt = String(options.prompt || args.slice(1).join(' ') || KHY_GATEWAY_SAMPLE_DEFAULT_PROMPT).trim()
    || KHY_GATEWAY_SAMPLE_DEFAULT_PROMPT;
  const attempts = Math.min(
    KHY_GATEWAY_SAMPLE_MAX_ATTEMPTS,
    _parseIntWithMin(attemptsRaw, KHY_GATEWAY_SAMPLE_DEFAULT_ATTEMPTS, 1)
  );
  const firstResponseTimeoutMs = _parseIntWithMin(
    timeoutRaw,
    KHY_GATEWAY_SAMPLE_DEFAULT_FIRST_RESPONSE_TIMEOUT_MS,
    1000
  );
  const hardTimeoutMs = Math.max(
    firstResponseTimeoutMs + 8000,
    _parseIntWithMin(hardTimeoutRaw, firstResponseTimeoutMs + 8000, firstResponseTimeoutMs + 1000)
  );
  const baseDirInput = String(options.dir || options.out || '').trim();
  const baseDir = baseDirInput
    ? path.resolve(baseDirInput)
    : path.join(os.tmpdir(), `khy-gateway-sample-${adapter}-${Date.now()}`);
  const repoRoot = path.resolve(__dirname, '../../../../');
  const khyBinPath = path.resolve(__dirname, '../../../bin/khy.js');
  const homeContext = _getGatewayHomeRiskSnapshot({ activeAdapterType: adapter });
  fs.mkdirSync(baseDir, { recursive: true });

  if (!asJson) {
    printInfo(`开始 Codex strict 采样（目标=${adapter}，次数=${attempts}，首响超时=${firstResponseTimeoutMs}ms）`);
    printInfo(`采样目录: ${baseDir}`);
    if (homeContext.isTempHome) {
      printInfo(`提示: ${homeContext.hint} ${homeContext.recommendation}`.trim());
    }
  }

  const runs = [];
  for (let index = 0; index < attempts; index += 1) {
    const runNumber = index + 1;
    const runDir = path.join(baseDir, `run-${runNumber}`);
    const promptLog = path.join(runDir, 'prompt.log');
    const stdoutLog = path.join(runDir, 'stdout.log');
    const stderrLog = path.join(runDir, 'stderr.log');
    fs.mkdirSync(runDir, { recursive: true });

    if (!asJson) {
      printInfo(`执行 Codex strict 采样（第 ${runNumber}/${attempts} 次），目标=首块语言证据，超时=${firstResponseTimeoutMs}ms`);
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      KHY_TRACE_AUDIT_DIR: runDir,
      KHY_GATEWAY_DEBUG_PROMPT: '1',
      KHY_GATEWAY_DEBUG_PROMPT_FILE: promptLog,
      GATEWAY_PREFERRED_ADAPTER: adapter,
      GATEWAY_PREFERRED_STRICT: 'true',
      GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS: 'false',
      GATEWAY_ADAPTER_MAX_ATTEMPTS: '1',
      GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED: 'false',
      GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS: String(firstResponseTimeoutMs),
      KHY_GATEWAY_THROW_FALLBACK: 'false',
    };
    const childResult = spawnSync(process.execPath, [khyBinPath, '-p', prompt], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: hardTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(stdoutLog, String(childResult.stdout || ''), 'utf8');
    fs.writeFileSync(stderrLog, String(childResult.stderr || ''), 'utf8');

    const runSummary = _readGatewaySampleRunSummary(runDir);
    runSummary.run = `run-${runNumber}`;
    runSummary.exitCode = Number.isInteger(childResult.status) ? childResult.status : null;
    runSummary.signal = childResult.signal || null;
    runSummary.hardTimeout = !!(childResult.error && childResult.error.code === 'ETIMEDOUT');
    const hasUsableRunEvidence = !!(
      runSummary.requestId
      || runSummary.firstChunk
      || runSummary.finalResponse
      || runSummary.llmResponse
    );
    runSummary.spawnError = (childResult.error && !hasUsableRunEvidence)
      ? _compactReasonText(childResult.error.message || String(childResult.error), 220)
      : '';
    runs.push(runSummary);

    if (!asJson) {
      const firstChunkState = runSummary.firstChunk
        ? `${runSummary.firstChunk.detectedLanguage || '?'}->${runSummary.firstChunk.expectedLanguage || '?'}`
        : 'none';
      const llmState = runSummary.llmResponse
        ? `${runSummary.llmResponse.success ? 'success' : `fail:${runSummary.llmResponse.errorType || 'unknown'}`}`
        : (runSummary.hardTimeout ? 'fail:hard-timeout' : 'missing');
      printInfo(`Codex strict 采样结果（第 ${runNumber}/${attempts} 次）：requestId=${runSummary.requestId || '-'}，firstChunk=${firstChunkState}，llm=${llmState}`);
    }
  }

  const summary = _summarizeGatewaySampleCounts(runs);
  const payload = {
    ok: true,
    generatedAt: Date.now(),
    adapter,
    baseDir,
    prompt,
    attempts,
    firstResponseTimeoutMs,
    hardTimeoutMs,
    environment: {
      homeRisk: {
        homeDir: homeContext.homeDir,
        tmpDir: homeContext.tmpDir,
        isTempHome: homeContext.isTempHome,
        hint: homeContext.hint,
        recommendation: homeContext.recommendation,
      },
    },
    summary,
    runs,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printSuccess(`Codex strict 采样完成：总计 ${summary.attempts} 次，promptInjected=${summary.promptInjectedCount}，firstChunk=${summary.firstChunkCount}，timeout=${summary.timeoutCount}`);
  if (summary.firstChunkCount > 0) {
    printInfo(`首块语言统计: zh=${summary.firstChunkZhCount}，en=${summary.firstChunkEnCount}，aligned=${summary.firstChunkAlignedCount}`);
  } else {
    printInfo('首块语言统计: 当前窗口未拿到任何可见 first_chunk；当前主要结论仍是“注入稳定、响应前超时占主导”');
  }
  printInfo(`采样目录已保留: ${baseDir}`);
}

module.exports = {
  handleGatewayRelay,
  handleGatewayDetect,
  handleGatewayTest,
  _isGatewaySamplePromptInjected,
  _readGatewaySampleRunSummary,
  _summarizeGatewaySampleCounts,
  handleGatewayProbeTools,
  handleGatewaySample,
  setGatewayRuntimeProbesDeps,
};
