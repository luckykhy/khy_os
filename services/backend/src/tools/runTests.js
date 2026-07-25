/**
 * Tool: run_tests — detect test framework and run tests with structured results.
 */
'use strict';

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
const { getShellConfiguration } = require('./platformUtils');

// ─── Framework Detection ───────────────────────────────────────────────────

function _detectTestFramework(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (allDeps.jest || allDeps['@jest/core']) return { framework: 'jest', cmd: 'npx jest --json --no-coverage' };
      if (allDeps.vitest) return { framework: 'vitest', cmd: 'npx vitest run --reporter=json' };
      if (allDeps.mocha) return { framework: 'mocha', cmd: 'npx mocha --reporter json' };
      if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return { framework: 'npm-script', cmd: 'npm test' };
      }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { framework: 'cargo', cmd: 'cargo test 2>&1' };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { framework: 'go', cmd: 'go test -v ./... 2>&1' };

  // Python test detection
  for (const f of ['pytest.ini', 'setup.cfg', 'pyproject.toml', 'tox.ini']) {
    if (fs.existsSync(path.join(cwd, f))) {
      return { framework: 'pytest', cmd: 'python3 -m pytest -q --tb=short 2>&1' };
    }
  }
  if (fs.existsSync(path.join(cwd, 'tests')) || fs.existsSync(path.join(cwd, 'test'))) {
    return { framework: 'pytest', cmd: 'python3 -m pytest -q --tb=short 2>&1' };
  }

  return null;
}

// ─── Result Parsers ────────────────────────────────────────────────────────

function _parseJestJson(output) {
  try {
    // Jest --json outputs a single JSON line (may have preceding text)
    const jsonStart = output.indexOf('{');
    if (jsonStart === -1) return null;
    const json = JSON.parse(output.slice(jsonStart));
    const failures = [];
    for (const suite of (json.testResults || [])) {
      for (const test of suite.assertionResults.filter(t => t.status === 'failed')) {
        failures.push({
          testName: test.fullName || test.title,
          file: path.relative(process.cwd(), suite.name),
          message: (test.failureMessages || []).join('\n').slice(0, 500),
        });
      }
    }
    return {
      passed: json.numPassedTests || 0,
      failed: json.numFailedTests || 0,
      skipped: json.numPendingTests || 0,
      total: json.numTotalTests || 0,
      failures,
    };
  } catch { return null; }
}

function _parseGenericOutput(output) {
  const lines = output.split('\n');
  let passed = 0, failed = 0, skipped = 0;
  const failures = [];

  for (const line of lines) {
    // pytest summary: "X passed, Y failed, Z skipped"
    const pytestMatch = line.match(/(\d+)\s+passed/);
    if (pytestMatch) passed = parseInt(pytestMatch[1], 10);
    const pytestFailed = line.match(/(\d+)\s+failed/);
    if (pytestFailed) failed = parseInt(pytestFailed[1], 10);
    const pytestSkipped = line.match(/(\d+)\s+skipped/);
    if (pytestSkipped) skipped = parseInt(pytestSkipped[1], 10);

    // cargo test: "test result: ok. X passed; Y failed; Z ignored"
    const cargoMatch = line.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+ignored/);
    if (cargoMatch) { passed = parseInt(cargoMatch[1], 10); failed = parseInt(cargoMatch[2], 10); skipped = parseInt(cargoMatch[3], 10); }

    // go test: "ok"/"FAIL" per package, "--- FAIL: TestName"
    const goFail = line.match(/--- FAIL:\s+(\S+)/);
    if (goFail) { failures.push({ testName: goFail[1], file: '', message: '' }); }
    if (line.startsWith('ok ')) passed++;
    if (line.startsWith('FAIL\t')) failed++;

    // Generic FAIL/PASS patterns
    if (line.includes('FAILED') && line.includes('::')) {
      failures.push({ testName: line.trim(), file: '', message: '' });
    }
  }

  return { passed, failed, skipped, total: passed + failed + skipped, failures };
}

// ─── Tool Definition ───────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'run_tests',
  description: 'Detect test framework and run tests, returning structured pass/fail/skip counts and failure details. Supports Jest, Vitest, Mocha, pytest, cargo test, go test.',
  category: 'execution',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,

  inputSchema: {
    cwd: { type: 'string', required: false, description: 'Project directory' },
    command: { type: 'string', required: false, description: 'Override test command' },
    filter: { type: 'string', required: false, description: 'Test name/pattern filter' },
    timeout: { type: 'number', required: false, description: 'Idle timeout in ms (default 120000)' },
    idleTimeout: { type: 'number', required: false, description: 'Alias of timeout; idle timeout in ms' },
  },

  getActivityDescription(input) {
    return `运行测试${input?.cwd ? `：${input.cwd}` : ''}`;
  },

  async execute(params, context = {}) {
    const cwd = params.cwd || process.cwd();
    const idleTimeoutMs = Math.max(
      50,
      parseInt(
        String(params.idleTimeout || params.timeout || process.env.KHY_RUN_TESTS_IDLE_TIMEOUT_MS || '120000'),
        10
      ) || 120000
    );
    const startMs = Date.now();

    const detected = _detectTestFramework(cwd);
    let command = params.command || (detected ? detected.cmd : null);
    const framework = detected ? detected.framework : 'unknown';

    if (!command) {
      return { success: false, error: `No test framework detected in ${cwd}. Provide a command.` };
    }

    // Append filter if provided
    if (params.filter && !params.command) {
      if (framework === 'jest' || framework === 'vitest') command += ` -t "${params.filter}"`;
      else if (framework === 'pytest') command += ` -k "${params.filter}"`;
      else if (framework === 'cargo') command += ` ${params.filter}`;
      else if (framework === 'go') command += ` -run "${params.filter}"`;
    }

    const traceCtx = (context && context.traceContext && typeof context.traceContext === 'object')
      ? context.traceContext
      : {};
    const spawnEnv = {
      ...process.env,
      ...(traceCtx.env || {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      CI: '1',
    };

    const { executable: shellBin, argsPrefix } = getShellConfiguration({ login: true });
    const shellArgs = [...argsPrefix, command];
    const label = `run_tests:${framework}`;

    let output = '';
    let exitCode = 0;
    let totalOutBytes = 0;
    let totalErrBytes = 0;
    const maxCaptureBytes = 10 * 1024 * 1024;

    try {
      const result = await spawnWithIdleTimeout(shellBin, shellArgs, {
        idleMs: idleTimeoutMs,
        spawnOpts: {
          cwd,
          env: spawnEnv,
          windowsHide: true,
        },
        label,
        onActivity: (payload) => {
          if (typeof context?.onActivity === 'function') {
            try { context.onActivity({ tool: 'run_tests', framework, ...payload }); } catch { /* non-critical */ }
          }
        },
        onStdoutChunk: (chunk) => {
          totalOutBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`run_tests stdout ${Math.round(totalOutBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
        onStderrChunk: (chunk) => {
          totalErrBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`run_tests stderr ${Math.round(totalErrBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
      });
      exitCode = Number.isFinite(result.code) ? result.code : 0;
      output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
    } catch (err) {
      exitCode = 1;
      output = String(err && err.message ? err.message : err || 'run_tests failed');
    }

    // CC `toolErrors.formatError` 对齐:超 maxCaptureBytes 保留**头一半 + 尾一半**(中段标记),
    // 而非历史 pure-head——jest/vitest 的机读 JSON 摘要与 `Tests: N failed` 汇总行在 **stdout 末尾**,
    // pure-head 会丢掉它们 → 下方 `_parseJestJson` 解析失败回退泛化、`outputTail` 取不到真结尾。
    // 门控 KHY_CC_OUTPUT_TRUNCATE(默认开),关 → 逐字节回退旧 pure-head。
    output = require('./ccOutputTruncate').capOutput(output, maxCaptureBytes, process.env);

    // Parse results
    let parsed = null;
    if (framework === 'jest' || framework === 'vitest') {
      parsed = _parseJestJson(output);
    }
    if (!parsed) {
      parsed = _parseGenericOutput(output);
    }

    return {
      success: exitCode === 0 && parsed.failed === 0,
      data: {
        framework,
        command,
        exitCode,
        idleTimeoutMs,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        total: parsed.total,
        failures: parsed.failures.slice(0, 20),
        durationMs: Date.now() - startMs,
        outputTail: output.split('\n').slice(-30).join('\n').slice(0, 3000),
      },
    };
  },
});
