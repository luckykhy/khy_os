/**
 * Tool: lint_code — run linter and return structured file:line:message results.
 */
'use strict';

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
const { getShellConfiguration } = require('./platformUtils');

// ─── Linter Detection ──────────────────────────────────────────────────────

function _detectLinter(cwd) {
  // ESLint
  const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml',
    '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts'];
  for (const cfg of eslintConfigs) {
    if (fs.existsSync(path.join(cwd, cfg))) {
      return { linter: 'eslint', cmd: 'npx eslint --format json .' };
    }
  }
  // Check package.json for eslint
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.eslintConfig) return { linter: 'eslint', cmd: 'npx eslint --format json .' };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.eslint) return { linter: 'eslint', cmd: 'npx eslint --format json .' };
    } catch { /* ignore */ }
  }

  // Cargo clippy
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { linter: 'clippy', cmd: 'cargo clippy --message-format=json 2>&1' };
  }

  // Go vet + golangci-lint
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { linter: 'go-vet', cmd: 'go vet ./... 2>&1' };
  }

  // Python: pylint or flake8
  for (const cfg of ['.pylintrc', 'pylintrc', '.flake8', 'setup.cfg']) {
    if (fs.existsSync(path.join(cwd, cfg))) {
      const isFlake8 = cfg === '.flake8';
      return isFlake8
        ? { linter: 'flake8', cmd: 'python3 -m flake8 --format=json .' }
        : { linter: 'pylint', cmd: 'python3 -m pylint --output-format=json . 2>&1' };
    }
  }

  return null;
}

// ─── Parsers ───────────────────────────────────────────────────────────────

function _parseEslintJson(output) {
  try {
    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) return null;
    const results = JSON.parse(output.slice(jsonStart));
    const issues = [];
    let errorCount = 0, warningCount = 0;

    for (const file of results) {
      for (const msg of (file.messages || [])) {
        issues.push({
          file: file.filePath ? path.relative(process.cwd(), file.filePath) : '',
          line: msg.line || null,
          col: msg.column || null,
          severity: msg.severity === 2 ? 'error' : 'warning',
          rule: msg.ruleId || '',
          message: msg.message || '',
        });
        if (msg.severity === 2) errorCount++;
        else warningCount++;
      }
    }

    return { issues, errorCount, warningCount, fileCount: results.length };
  } catch { return null; }
}

function _parseGenericLint(output) {
  const issues = [];
  let errorCount = 0, warningCount = 0;

  for (const line of output.split('\n')) {
    // Generic: file:line:col: severity: message (rule)
    const match = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning|note|E\d+|W\d+|C\d+)[\s:]+(.+)/);
    if (match) {
      const severity = match[4].startsWith('E') || match[4] === 'error' ? 'error' : 'warning';
      issues.push({
        file: match[1], line: parseInt(match[2], 10), col: parseInt(match[3], 10),
        severity, rule: match[4], message: match[5].trim(),
      });
      if (severity === 'error') errorCount++; else warningCount++;
    }
  }

  return { issues, errorCount, warningCount, fileCount: 0 };
}

// ─── Tool Definition ───────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'lint_code',
  description: 'Detect linter for project and run it, returning structured file:line:message issues. Supports ESLint, Clippy, go vet, Pylint, Flake8.',
  category: 'execution',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  inputSchema: {
    cwd: { type: 'string', required: false, description: 'Project directory' },
    command: { type: 'string', required: false, description: 'Override lint command' },
    files: { type: 'string', required: false, description: 'Specific files/globs to lint' },
    fix: { type: 'boolean', required: false, description: 'Auto-fix issues (default false)' },
    timeout: { type: 'number', required: false, description: 'Idle timeout in ms (default 60000)' },
    idleTimeout: { type: 'number', required: false, description: 'Alias of timeout; idle timeout in ms' },
  },

  getActivityDescription(input) {
    return `检查代码${input?.cwd ? `：${input.cwd}` : ''}`;
  },

  async execute(params, context = {}) {
    const cwd = params.cwd || process.cwd();
    const idleTimeoutMs = Math.max(
      50,
      parseInt(
        String(params.idleTimeout || params.timeout || process.env.KHY_LINT_IDLE_TIMEOUT_MS || '60000'),
        10
      ) || 60000
    );
    const detected = _detectLinter(cwd);
    const hasCommandOverride = typeof params.command === 'string' && params.command.trim().length > 0;

    if (!detected && !hasCommandOverride) {
      return {
        success: true,
        data: {
          linter: 'none',
          errorCount: 0,
          warningCount: 0,
          issues: [],
          fileCount: 0,
          command: null,
          exitCode: 0,
          idleTimeoutMs,
        },
      };
    }

    const linter = detected ? detected.linter : 'custom';
    let command = hasCommandOverride ? params.command.trim() : detected.cmd;
    if (!hasCommandOverride && params.files) command += ` ${params.files}`;
    if (!hasCommandOverride && params.fix && linter === 'eslint') command += ' --fix';
    if (!hasCommandOverride && params.fix && linter === 'clippy') command = command.replace('clippy', 'clippy --fix');

    const traceCtx = (context && context.traceContext && typeof context.traceContext === 'object')
      ? context.traceContext
      : {};
    const spawnEnv = {
      ...process.env,
      ...(traceCtx.env || {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };

    const { executable: shellBin, argsPrefix } = getShellConfiguration({ login: true });
    const shellArgs = [...argsPrefix, command];
    const label = `lint_code:${linter}`;
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
            try { context.onActivity({ tool: 'lint_code', linter, ...payload }); } catch { /* non-critical */ }
          }
        },
        onStdoutChunk: (chunk) => {
          totalOutBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`lint_code stdout ${Math.round(totalOutBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
        onStderrChunk: (chunk) => {
          totalErrBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`lint_code stderr ${Math.round(totalErrBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
      });
      exitCode = Number.isFinite(result.code) ? result.code : 0;
      output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
    } catch (err) {
      exitCode = 1;
      output = String(err && err.message ? err.message : err || 'lint_code failed');
    }

    // CC `toolErrors.formatError` 对齐:超 maxCaptureBytes 保留**头一半 + 尾一半**(中段标记),
    // 而非历史 pure-head——eslint 等的汇总行/末尾问题不再被丢。门控 KHY_CC_OUTPUT_TRUNCATE(默认开),
    // 关 → 逐字节回退旧 pure-head。
    output = require('./ccOutputTruncate').capOutput(output, maxCaptureBytes, process.env);

    let parsed = null;
    if (linter === 'eslint') parsed = _parseEslintJson(output);
    if (!parsed) parsed = _parseGenericLint(output);

    return {
      success: exitCode === 0 && parsed.errorCount === 0,
      data: {
        linter,
        command,
        exitCode,
        idleTimeoutMs,
        errorCount: parsed.errorCount,
        warningCount: parsed.warningCount,
        fixedCount: params.fix ? 0 : undefined,
        issues: parsed.issues.slice(0, 100),
        fileCount: parsed.fileCount,
      },
    };
  },
});
