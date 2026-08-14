/**
 * Tool: build_project — detect project type and run build with structured output.
 */
'use strict';

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
const { getShellConfiguration } = require('./platformUtils');
const { parseDiagnostics } = require('../services/compile/diagnostics');

// ─── Project Type Detection ────────────────────────────────────────────────

// Detection is ordered: the FIRST config whose `file` exists (exact name) or
// whose `glob` extension matches a file in `cwd` wins. `projectType` is forwarded
// to the shared diagnostics parser so the right grammar is selected.
const BUILD_CONFIGS = [
  { file: 'package.json', type: 'nodejs', detect: _detectNodeBuild },
  { file: 'Cargo.toml',   type: 'rust',   cmd: 'cargo build --release' },
  { file: 'go.mod',       type: 'go',     cmd: 'go build ./...' },
  { file: 'Makefile',     type: 'make',   cmd: 'make' },
  { file: 'makefile',     type: 'make',   cmd: 'make' },
  { file: 'CMakeLists.txt', type: 'cmake', detect: _detectCmakeBuild },
  { file: 'build.gradle', type: 'gradle', cmd: './gradlew build' },
  { file: 'pom.xml',      type: 'maven',  cmd: 'mvn package -q' },
  // ── extended ecosystems ──
  { glob: '.sln',         type: 'dotnet', cmd: 'dotnet build -nologo' },
  { glob: '.csproj',      type: 'dotnet', cmd: 'dotnet build -nologo' },
  { file: 'moon.mod.json', type: 'moonbit', cmd: 'moon build' },
  { file: 'meson.build',  type: 'meson',  cmd: 'meson setup build && meson compile -C build' },
  { file: 'pyproject.toml', type: 'python', cmd: 'python3 -m build' },
  { file: 'setup.py',     type: 'python', cmd: 'python3 -m build' },
];

// projectType → toolchain dependency id. Only types whose toolchain has a
// registry entry can self-heal; others fall through as a normal build failure.
// (nodejs/gradle/maven/meson intentionally absent — no curated install plan.)
const _PROJECT_TOOLCHAIN = {
  rust: 'rust', go: 'go', make: 'make', cmake: 'cmake',
  dotnet: 'dotnet', moonbit: 'moonbit', python: 'python3',
};

// Shell-level "the build command itself is not on PATH" — distinct from a
// compile error (where the tool DID run and emitted diagnostics). Kept tight to
// avoid false positives from compiler output (e.g. a missing #include prints
// "No such file or directory", which must NOT be read as a missing toolchain).
const _MISSING_BIN_RE = /command not found|not recognized as an internal or external command|不是内部或外部命令|:\s*not found\b|\bENOENT\b/i;

function _detectNodeBuild(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    if (pkg.scripts && pkg.scripts.build) return `npm run build`;
  } catch { /* ignore */ }
  return null;
}

function _detectCmakeBuild() {
  // Portable form: -S/-B avoid platform-specific mkdir/cd, --build wraps the
  // native generator (make/ninja/MSBuild) on both POSIX and Windows.
  return 'cmake -S . -B build && cmake --build build';
}

/** Does `cwd` contain any file ending in `ext` (case-insensitive)? */
function _hasFileWithExt(cwd, ext) {
  try {
    const want = ext.toLowerCase();
    return fs.readdirSync(cwd).some((f) => f.toLowerCase().endsWith(want));
  } catch { return false; }
}

function _detectProject(cwd) {
  for (const config of BUILD_CONFIGS) {
    const matched = config.glob
      ? _hasFileWithExt(cwd, config.glob)
      : fs.existsSync(path.join(cwd, config.file));
    if (matched) {
      const cmd = config.detect ? config.detect(cwd) : config.cmd;
      return { type: config.type, command: cmd };
    }
  }
  return null;
}

// ─── Output Parsers ────────────────────────────────────────────────────────
// Diagnostic parsing lives in the shared services/compile/diagnostics.js single
// source of truth (consumed by both build_project and compile_file).

// ─── Tool Definition ───────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'build_project',
  description: 'Detect project type and run build command, returning structured errors/warnings. Supports Node.js, Rust, Go, Make, CMake, Gradle, Maven, .NET, MoonBit, Meson, Python. Missing toolchains trigger an interactive install.',
  category: 'execution',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,

  inputSchema: {
    cwd: { type: 'string', required: false, description: 'Project directory (defaults to process.cwd)' },
    command: { type: 'string', required: false, description: 'Override build command' },
    timeout: { type: 'number', required: false, description: 'Idle timeout in ms (default 120000)' },
    idleTimeout: { type: 'number', required: false, description: 'Alias of timeout; idle timeout in ms' },
  },

  getActivityDescription(input) {
    return `构建项目${input?.cwd ? `：${input.cwd}` : ''}`;
  },

  async execute(params, context = {}) {
    const cwd = params.cwd || process.cwd();
    const idleTimeoutMs = Math.max(
      50,
      parseInt(
        String(params.idleTimeout || params.timeout || process.env.KHY_BUILD_IDLE_TIMEOUT_MS || '120000'),
        10
      ) || 120000
    );
    const startMs = Date.now();

    // Detect or use override
    const detected = _detectProject(cwd);
    const command = params.command || (detected ? detected.command : null);
    const projectType = detected ? detected.type : 'unknown';

    if (!command) {
      return {
        success: false,
        error: `No build configuration found in ${cwd}. Provide a command or ensure a build file exists.`,
      };
    }

    const traceCtx = (context && context.traceContext && typeof context.traceContext === 'object')
      ? context.traceContext
      : {};
    // JVM-based builds (gradle/maven) emit console output in the JVM's file.encoding,
    // which mojibakes on a legacy-locale (GBK) Windows host. Pin them to UTF-8 via
    // GRADLE_OPTS/MAVEN_OPTS and decode the pipe as UTF-8 so the two sides agree.
    const _javaEnc = require('../utils/javaEncoding');
    const isJvmBuild = projectType === 'gradle' || projectType === 'maven'
      || /(^|[\\/\s])(gradlew?|mvn|maven)([\s.]|$)/i.test(String(command));
    const spawnEnv = {
      ...process.env,
      ...(traceCtx.env || {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...(isJvmBuild ? _javaEnc.buildToolEnv(process.env) : {}),
    };

    const { executable: shellBin, argsPrefix } = getShellConfiguration({ login: true });
    const shellArgs = [...argsPrefix, command];
    const label = `build_project:${projectType}`;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let totalOutBytes = 0;
    let totalErrBytes = 0;
    const maxCaptureBytes = 10 * 1024 * 1024;

    try {
      const result = await spawnWithIdleTimeout(shellBin, shellArgs, {
        idleMs: idleTimeoutMs,
        ...(isJvmBuild ? { outputEncoding: _javaEnc.outputEncoding() } : {}),
        spawnOpts: {
          cwd,
          env: spawnEnv,
          windowsHide: true,
        },
        label,
        onActivity: (payload) => {
          if (typeof context?.onActivity === 'function') {
            try { context.onActivity({ tool: 'build_project', projectType, ...payload }); } catch { /* non-critical */ }
          }
        },
        onStdoutChunk: (chunk) => {
          totalOutBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`build_project stdout ${Math.round(totalOutBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
        onStderrChunk: (chunk) => {
          totalErrBytes += Buffer.byteLength(String(chunk || ''), 'utf8');
          if (typeof context?.onProgress === 'function') {
            try { context.onProgress(`build_project stderr ${Math.round(totalErrBytes / 1024)}KB`); } catch { /* non-critical */ }
          }
        },
      });
      exitCode = Number.isFinite(result.code) ? result.code : 0;
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (err) {
      exitCode = 1;
      stderr = String(err && err.message ? err.message : err || 'build_project failed');
    }

    const combined = stdout + '\n' + stderr;
    // CC `toolErrors.formatError` 对齐:超 maxCaptureBytes 时保留**头一半 + 尾一半**(中段标记),
    // 而非历史 pure-head——否则 linker/编译器的「N errors generated」末尾汇总与下方 outputTail
    // (从 capped 再取尾)都会被丢。门控 KHY_CC_OUTPUT_TRUNCATE(默认开),关 → 逐字节回退旧 pure-head。
    const capped = require('./ccOutputTruncate').capOutput(combined, maxCaptureBytes, process.env);
    const { errors, warnings } = parseDiagnostics(capped, projectType);
    const outputLines = capped.split('\n');
    const tail = outputLines.slice(-50).join('\n');

    // Toolchain binary genuinely absent (build exited non-zero AND the shell
    // could not resolve the build command) → tag the result with the toolchain
    // depId. executeTool's dependency self-heal funnel reads this top-level
    // depId, installs the toolchain, and retries this exact build once. A real
    // compile error (the tool ran, exit≠0) carries no depId and falls through
    // to structured diagnostics untouched (no prompt injection, no false heal).
    let toolchainDepId = null;
    if (exitCode !== 0) {
      const depId = _PROJECT_TOOLCHAIN[projectType];
      if (depId && _MISSING_BIN_RE.test(capped)) toolchainDepId = depId;
    }

    // Transparent compile→fix contract (Phase 4): we deliberately do NOT run a
    // hidden model-driven auto-edit loop here — that would fight the top-level
    // agent loop and burn tokens. Toolchain/dependency failures self-heal
    // deterministically through executeTool's bounded dependency funnel
    // (install + retry exactly once, see depId above). CODE errors are NOT
    // auto-fixed: we return precise, actionable diagnostics and let the agent
    // drive edit→rebuild. nextAction makes that contract explicit.
    const nextAction = exitCode === 0
      ? null
      : toolchainDepId
        ? `Install the ${projectType} toolchain (auto-heal will retry), then rebuild.`
        : errors.length > 0
          ? `Fix the ${errors.length} reported diagnostic(s) (file:line:col) and run build_project again.`
          : `Build failed (exit ${exitCode}); inspect outputTail, fix the cause, and rebuild.`;

    return {
      success: exitCode === 0,
      ...(toolchainDepId ? { depId: toolchainDepId } : {}),
      data: {
        projectType,
        command,
        exitCode,
        idleTimeoutMs,
        errors,
        warnings,
        errorCount: errors.length,
        warningCount: warnings.length,
        durationMs: Date.now() - startMs,
        outputTail: tail.slice(0, 5000),
        nextAction,
      },
    };
  },
});
