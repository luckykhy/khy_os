/**
 * Tool: compile_file — compile / type-check a SINGLE source file or snippet in a
 * supported language, returning structured diagnostics (and, when persisted, the
 * artifact path). Per-language toolchain knowledge lives in the shared
 * services/compile/registry single source of truth; diagnostics parsing in
 * services/compile/diagnostics. Missing toolchains route through the dependency
 * self-heal loop (declare-and-retry), never a printed hint.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { defineTool } = require('./_baseTool');
const compileRegistry = require('../services/compile/registry');
const { parseDiagnostics } = require('../services/compile/diagnostics');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
const { createEphemeralDir } = require('../utils/ephemeralTmp');

const DEFAULT_IDLE_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Heuristic: did a spawn failure mean "toolchain binary not found"? */
function _looksLikeMissingBinary(message) {
  return /ENOENT|not found|command not found|无法找到|不是内部或外部命令/i.test(String(message || ''));
}

module.exports = defineTool({
  name: 'compile_file',
  description: 'Compile or type-check a single source file/snippet (C, C++, Rust, Go, Java, Python, TypeScript), returning structured errors/warnings. Missing toolchains trigger an interactive install. Use build_project for whole projects.',
  category: 'execution',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,
  shouldDefer: true,
  searchHint: 'compile build cc gcc rustc javac tsc single file language',

  inputSchema: {
    language: { type: 'string', required: true, description: 'Source language: c | cpp | rust | go | java | python | typescript' },
    code: { type: 'string', required: false, description: 'Inline source to compile (one of code/file required)' },
    file: { type: 'string', required: false, description: 'Path to an existing source file to compile' },
    filename: { type: 'string', required: false, description: 'Base name (controls stem / Java class; defaults Main). e.g. "Main"' },
    outputPath: { type: 'string', required: false, description: 'Persist the compiled artifact here (default: ephemeral, discarded after check)' },
    timeout: { type: 'number', required: false, description: 'Idle timeout in ms (default 60000)' },
  },

  getActivityDescription(input) {
    return `编译 ${input?.language || ''}${input?.file ? `：${input.file}` : ' 片段'}`;
  },

  async execute(params, context = {}) {
    const startMs = Date.now();
    const lang = compileRegistry.getLanguage(params.language);
    if (!lang) {
      return {
        success: false,
        error: `Unsupported language "${params.language}". Supported: ${compileRegistry.listLanguages().join(', ')}.`,
      };
    }

    const hasCode = typeof params.code === 'string' && params.code.length > 0;
    const hasFile = typeof params.file === 'string' && params.file.length > 0;
    if (!hasCode && !hasFile) {
      return { success: false, error: 'compile_file requires either "code" or "file".' };
    }

    // ── toolchain dependency gate (declare → self-heal install → retry) ──
    // Soft-return tagged with a top-level depId (codebase convention, see
    // tests/services/dependency/searchToolHealingWiring): executeTool's
    // dependency self-heal funnel reads result.depId, installs the toolchain,
    // and retries this exact call once. No prompt injection — the missing
    // toolchain is a structured signal, not a printed hint.
    try {
      const dep = require('../services/dependency');
      const miss = dep.ensure(lang.toolchainDepId);
      if (miss) return { ...miss.toStructuredResult(), depId: lang.toolchainDepId };
    } catch { /* resolver unavailable — fall through; ENOENT below still maps */ }

    // ── materialize the source + an output dir (ephemeral unless persisted) ──
    const ephemeral = createEphemeralDir({ prefix: `compile-${lang.id}` });
    const stem = _safeStem(params.filename || (hasFile ? path.basename(params.file).replace(/\.[^.]+$/, '') : 'Main'), lang);
    let src;
    let outDir = ephemeral.path;
    try {
      if (hasFile) {
        src = path.resolve(params.file);
        if (!fs.existsSync(src)) {
          ephemeral.dispose();
          return { success: false, error: `Source file not found: ${src}` };
        }
      } else {
        const srcName = lang.id === 'java' ? `${compileRegistry._javaClass(stem)}.java` : `${stem}${lang.exts[0]}`;
        src = path.join(ephemeral.path, srcName);
        fs.writeFileSync(src, params.code, 'utf-8');
      }
      if (params.outputPath) {
        outDir = path.dirname(path.resolve(params.outputPath));
        fs.mkdirSync(outDir, { recursive: true });
      }

      const argv = lang.buildArgv({ src, outDir, stem });
      const idleMs = Math.max(1000, parseInt(String(params.timeout || DEFAULT_IDLE_MS), 10) || DEFAULT_IDLE_MS);

      let result;
      try {
        result = await spawnWithIdleTimeout(argv[0], argv.slice(1), {
          idleMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          // Java pins its JVM to UTF-8 output (see compile/registry), so decode the
          // pipe as UTF-8 instead of guessing the console code page — otherwise CN
          // Windows mojibakes the compiler diagnostics.
          ...(lang.utf8Output ? { outputEncoding: require('../utils/javaEncoding').outputEncoding() } : {}),
          spawnOpts: { cwd: outDir, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true },
          label: `compile_file:${lang.id}`,
          onActivity: (payload) => { try { context?.onActivity?.({ tool: 'compile_file', language: lang.id, ...payload }); } catch { /* non-critical */ } },
        });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        // Toolchain binary missing at spawn time (raced past the upfront probe):
        // soft-return tagged with depId so the self-heal funnel installs + retries
        // (same convention as the upfront gate above). The ephemeral dir is still
        // reclaimed by the outer finally.
        if (_looksLikeMissingBinary(msg)) {
          try {
            const dep = require('../services/dependency');
            return { ...new dep.MissingDependencyError(lang.toolchainDepId).toStructuredResult(), depId: lang.toolchainDepId };
          } catch { /* dependency subsystem unavailable */ }
          return { success: false, depId: lang.toolchainDepId, error: `Required toolchain not installed: ${lang.bin}` };
        }
        result = { stdout: '', stderr: msg, code: 1 };
      }

      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      const { errors, warnings } = parseDiagnostics(combined, lang.diagnosticsType);
      const exitCode = Number.isFinite(result.code) ? result.code : 1;
      const ok = exitCode === 0 && errors.length === 0;

      // Persist artifact only on success + explicit outputPath; else it dies with
      // the ephemeral dir (compile_file is a check, not an artifact factory).
      let artifact = null;
      if (ok && lang.mode === 'compiled') {
        const built = lang.artifactPath({ outDir, stem });
        if (built && fs.existsSync(built)) {
          if (params.outputPath && path.resolve(params.outputPath) !== built) {
            try { fs.copyFileSync(built, path.resolve(params.outputPath)); artifact = path.resolve(params.outputPath); }
            catch { artifact = built; }
          } else {
            artifact = built;
          }
        }
      }

      const tail = combined.split('\n').slice(-40).join('\n').slice(0, 4000);
      return {
        success: ok,
        data: {
          language: lang.id,
          mode: lang.mode,
          exitCode,
          compiled: ok && lang.mode === 'compiled',
          checked: ok && lang.mode !== 'compiled',
          artifact: params.outputPath && artifact ? artifact : null,
          errors,
          warnings,
          errorCount: errors.length,
          warningCount: warnings.length,
          durationMs: Date.now() - startMs,
          outputTail: tail,
          nextAction: ok ? null : 'Fix the reported diagnostics (file:line:col) and recompile.',
        },
      };
    } finally {
      ephemeral.dispose();
    }
  },
});

/** Sanitize a stem into a safe file/identifier base. */
function _safeStem(raw, lang) {
  let s = String(raw || 'Main').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48);
  if (!s) s = 'Main';
  // Java class names must start with a letter/underscore.
  if (lang.id === 'java' && !/^[A-Za-z_]/.test(s)) s = `C_${s}`;
  return s;
}
