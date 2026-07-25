const { defineTool } = require('./_baseTool');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const compileRegistry = require('../services/compile/registry');
const { createEphemeralDir } = require('../utils/ephemeralTmp');
const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
const { parseDiagnostics } = require('../services/compile/diagnostics');

/**
 * [SAFE] executeCode — arbitrary-JavaScript execution, contained in a separate
 * permission-restricted Node process.
 *
 * History: the original tool ran user code with `vm.runInNewContext` and injected
 * HOST-realm intrinsics, so Agent-controlled code escaped trivially via
 * `Date.constructor("return process")()` → full host RCE (fs / child_process / env
 * exfiltration). An in-process `vm`-only hardening could not be sealed: the context
 * GLOBAL object is unavoidably a host object, so `globalThis.constructor.constructor`
 * still bridged back to the host realm. Node's own docs state plainly: "the vm
 * module is not a security mechanism. Do not use it to run untrusted code."
 *
 * Real isolation requires moving the code OUT of this process's V8 realm. We run it
 * in a freshly-forked `node --permission` process (Node Permission Model, stable in
 * Node 20+/24) with NO `--allow-*` grants, so even if the inner `vm` is escaped the
 * code lands in a powerless process: file-system reads/writes, child-process
 * spawning, worker threads and native addons are all denied at the syscall boundary
 * by Node itself (verified: `require('fs').readFileSync('/etc/passwd')` throws
 * "Access to this API has been restricted"). The child is also handed a MINIMAL env
 * (only the source string — no inherited secrets) and is hard-killed on timeout.
 *
 * Defense in depth, three layers:
 *   1. Disabled by default. Runs only when an operator sets KHY_ENABLE_EXECUTE_CODE=1.
 *   2. Inside the child, the code still runs in a hardened strict-mode vm wrapper
 *      (no host objects injected; top-level `this` is undefined).
 *   3. The child process itself has no fs / process / worker / addon capabilities.
 *
 * Residual (documented, not fatal): the Node Permission Model does not yet gate
 * OUTBOUND NETWORK. An escape could still open a socket — but from a process with no
 * file-system access and no secrets in its environment, so there is nothing local to
 * read or exfiltrate. Bounded blast radius. Closing network egress would require an
 * OS-level sandbox (seccomp/namespaces) or isolated-vm; tracked for future work.
 */

// Default per-execution wall-clock limits. The inner vm timeout bounds synchronous
// code; the outer process timeout is the hard backstop (SIGKILL) for anything the
// vm timeout cannot interrupt. Both are env-tunable for trusted operators.
const VM_TIMEOUT_MS = Math.max(100, Number(process.env.KHY_EXECUTE_CODE_VM_TIMEOUT_MS) || 5000);
const PROC_TIMEOUT_MS = Math.max(VM_TIMEOUT_MS + 1000, Number(process.env.KHY_EXECUTE_CODE_PROC_TIMEOUT_MS) || 8000);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Unique marker so we can recover the JSON verdict from the child's stdout even if
// user code wrote incidental output before being contained.
const RESULT_SENTINEL = '<<<KHY_EXECUTE_CODE_RESULT>>>';

// Code executed INSIDE the sandboxed child. Reads the user source from the env (a
// string primitive carries no realm), runs it in a hardened vm wrapper, and emits a
// single sentinel-prefixed JSON verdict on stdout. No host objects are injected; the
// strict-mode IIFE invoked with `this === undefined` denies the top-level-`this`
// bridge, and `eval`'s completion value preserves "value of the last expression".
const CHILD_RUNNER = [
  'const vm = require("vm");',
  'let out;',
  'try {',
  '  const src = process.env.__KHY_SRC__ || "";',
  '  const wrapper = \'"use strict";\\n\'',
  '    + \'const console = { log:function(){}, error:function(){}, warn:function(){}, info:function(){} };\\n\'',
  '    + \'(function () { return eval(__src); }).call(undefined);\';',
  '  const r = vm.runInNewContext(wrapper, { __src: src }, {',
  '    timeout: ' + VM_TIMEOUT_MS + ', contextName: "executeCode-sandbox" });',
  '  out = { ok: true, result: r !== undefined ? String(r) : undefined };',
  '} catch (e) {',
  '  out = { ok: false, error: e && e.message ? e.message : String(e) };',
  '}',
  'process.stdout.write(' + JSON.stringify(RESULT_SENTINEL) + ' + JSON.stringify(out));',
].join('\n');

// ─── Non-JS execution (Phase 5) ─────────────────────────────────────────────
//
// TRUST BOUNDARY — read before extending. The JavaScript path above achieves
// strong isolation via Node's Permission Model (no fs/process/worker, secret-free
// env). Non-JS languages have NO equivalent in-process gate: a compiled C/Rust/Go
// binary or a python/tsc interpreter is an ordinary user-privilege process that
// CAN read the filesystem. Confinement here is therefore weaker and deliberately
// honest about it:
//   • throwaway ephemeral cwd (createEphemeralDir, auto-reclaimed)
//   • reduced env (PATH/HOME and toolchain-required vars only — NOT secret-free,
//     because compilers need PATH/HOME to function)
//   • idle-timeout SIGKILL (hung/CPU-spinning code is killed) + output byte cap
// This is process+env+fs-tmp confinement, NOT a syscall sandbox. Same residual
// class as the JS path's outbound-network gap; closing it needs an OS-level
// sandbox (seccomp/namespaces). Gated behind the same default-off opt-in.

// Languages executeCode can run. javascript → the hardened subprocess above;
// the rest → compile/registry single source of truth (compile-then-run or
// interpret) under the weaker confinement documented above.
const EXEC_LANGUAGES = ['javascript', 'python', 'c', 'cpp', 'rust', 'go', 'typescript'];

/** Heuristic: did a spawn failure mean "toolchain binary not found"? */
function _looksLikeMissingBinary(message) {
  return /ENOENT|not found|command not found|无法找到|不是内部或外部命令/i.test(String(message || ''));
}

/** Structured missing-toolchain soft failure tagged with depId (self-heal funnel). */
function _missDep(depId) {
  try {
    const dep = require('../services/dependency');
    return { ...new dep.MissingDependencyError(depId).toStructuredResult(), depId };
  } catch {
    return { success: false, depId, error: `Required toolchain not installed: ${depId}` };
  }
}

/** Reduced-but-functional env for a native execution (compilers need PATH/HOME). */
function _nativeEnv(lang, outDir) {
  const e = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || outDir,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  if (process.env.TMPDIR) e.TMPDIR = process.env.TMPDIR;
  if (process.platform === 'win32') {
    e.SystemRoot = process.env.SystemRoot;
    e.USERPROFILE = process.env.USERPROFILE;
    e.TEMP = process.env.TEMP;
    e.TMP = process.env.TMP;
  }
  if (lang.id === 'go') {
    // Keep Go's caches inside the throwaway dir; pin toolchain to avoid network.
    e.GOCACHE = path.join(outDir, '.gocache');
    e.GOPATH = path.join(outDir, '.gopath');
    e.GOTOOLCHAIN = 'local';
    e.GOFLAGS = '-mod=mod';
  }
  return e;
}

/** Compile argv to run BEFORE executing (null for interpreted languages). */
function _compileArgv(lang, ctx) {
  if (lang.id === 'typescript') {
    // executeCode must EMIT JS to run it; the registry buildArgv is --noEmit
    // (type-check only, for compile_file). Emit into the ephemeral outDir.
    return ['tsc', '--outDir', ctx.outDir, '--module', 'commonjs', '--target', 'es2020', ctx.src];
  }
  if (lang.mode === 'compiled') return lang.buildArgv(ctx);
  return null; // interpreted (python) — run directly
}

/**
 * Compile-then-run (or interpret) a non-JS snippet under the weaker confinement
 * documented in the TRUST BOUNDARY note above.
 */
async function _runNative(langId, code, context) {
  const lang = compileRegistry.getLanguage(langId);
  if (!lang) {
    return { success: false, error: `Unsupported language "${langId}". Supported: ${EXEC_LANGUAGES.join(', ')}.` };
  }

  // Toolchain gate → self-heal install + retry once via executeTool funnel.
  try {
    const dep = require('../services/dependency');
    const miss = dep.ensure(lang.toolchainDepId);
    if (miss) return { ...miss.toStructuredResult(), depId: lang.toolchainDepId };
  } catch { /* resolver unavailable — ENOENT below still maps */ }

  const ephemeral = createEphemeralDir({ prefix: `exec-${lang.id}` });
  const stem = 'Main';
  const outDir = ephemeral.path;
  const procTimeout = PROC_TIMEOUT_MS;
  try {
    const src = path.join(outDir, `${stem}${lang.exts[0]}`);
    fs.writeFileSync(src, code, 'utf-8');
    const env = _nativeEnv(lang, outDir);

    // 1) compile (compiled langs + typescript emit); interpreted → skip.
    const compileArgv = _compileArgv(lang, { src, outDir, stem });
    if (compileArgv) {
      let cres;
      try {
        cres = await spawnWithIdleTimeout(compileArgv[0], compileArgv.slice(1), {
          idleMs: procTimeout, maxOutputBytes: MAX_OUTPUT_BYTES,
          // Java forces UTF-8 JVM output (compile/registry) — decode as UTF-8 so CN
          // Windows compiler diagnostics don't mojibake.
          ...(lang.utf8Output ? { outputEncoding: require('../utils/javaEncoding').outputEncoding() } : {}),
          spawnOpts: { cwd: outDir, env, windowsHide: true },
          label: `executeCode:compile:${lang.id}`,
          onActivity: (p) => { try { context?.onActivity?.({ tool: 'executeCode', phase: 'compile', language: lang.id, ...p }); } catch { /* non-critical */ } },
        });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        if (err && err.idleTimeout) return { success: false, error: `Compilation timed out after ${procTimeout}ms (process killed).` };
        if (_looksLikeMissingBinary(msg)) return _missDep(lang.toolchainDepId);
        return { success: false, error: `Compile failed: ${msg.slice(0, 500)}` };
      }
      if ((Number.isFinite(cres.code) ? cres.code : 1) !== 0) {
        const combined = `${cres.stdout || ''}\n${cres.stderr || ''}`;
        const { errors } = parseDiagnostics(combined, lang.diagnosticsType);
        return {
          success: false,
          error: `Compilation failed (${errors.length} error(s)) before execution.`,
          data: { language: lang.id, phase: 'compile', errors, errorCount: errors.length, outputTail: combined.split('\n').slice(-30).join('\n').slice(0, 3000) },
        };
      }
    }

    // 2) run the artifact / interpret the source.
    const artifact = lang.mode === 'compiled' ? lang.artifactPath({ outDir, stem }) : null;
    const runArgv = lang.runArgv({ artifact, outDir, stem, src });
    if (!runArgv || !runArgv.length) return { success: false, error: `Language ${lang.id} has no run command.` };
    // Prefer this runtime's own node binary over a bare 'node' on PATH.
    if (runArgv[0] === 'node') runArgv[0] = process.execPath;

    let rres;
    try {
      rres = await spawnWithIdleTimeout(runArgv[0], runArgv.slice(1), {
        idleMs: procTimeout, maxOutputBytes: MAX_OUTPUT_BYTES,
        // Same UTF-8 decode for the Java program's own stdout/stderr.
        ...(lang.utf8Output ? { outputEncoding: require('../utils/javaEncoding').outputEncoding() } : {}),
        spawnOpts: { cwd: outDir, env, windowsHide: true },
        label: `executeCode:run:${lang.id}`,
        onActivity: (p) => { try { context?.onActivity?.({ tool: 'executeCode', phase: 'run', language: lang.id, ...p }); } catch { /* non-critical */ } },
      });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (err && err.idleTimeout) return { success: false, error: `Execution timed out after ${procTimeout}ms (process killed).` };
      if (_looksLikeMissingBinary(msg)) return _missDep(lang.toolchainDepId);
      return { success: false, error: `Execution failed: ${msg.slice(0, 500)}` };
    }

    const stdout = String(rres.stdout || '');
    const stderr = String(rres.stderr || '');
    const exit = Number.isFinite(rres.code) ? rres.code : 0;
    return {
      success: exit === 0,
      result: stdout.slice(0, MAX_OUTPUT_BYTES),
      ...(exit !== 0 ? { error: (stderr.trim() || `Process exited with code ${exit}`).slice(0, 500) } : {}),
      data: {
        language: lang.id,
        exitCode: exit,
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 10000),
        trustBoundary: 'process+env+fs-tmp confinement (NOT a syscall sandbox)',
      },
    };
  } finally {
    ephemeral.dispose();
  }
}

module.exports = defineTool({
  name: 'executeCode',
  description: 'Execute a code snippet and return its output. JavaScript runs in a permission-restricted subprocess (no fs/process access). Python/C/C++/Rust/Go/TypeScript compile-then-run under weaker process+tmp confinement (see trust boundary). Disabled unless KHY_ENABLE_EXECUTE_CODE=1.',
  category: 'execution',
  risk: 'high',
  isReadOnly: false,
  isConcurrencySafe: false,
  inputSchema: {
    code: { type: 'string', required: true, description: 'Source code to execute' },
    language: { type: 'string', required: false, enum: EXEC_LANGUAGES, description: 'Code language (default javascript). Non-JS runs under weaker confinement.' },
  },

  async execute(params, context) {
    // Layer 1: disabled by default — opt-in only, an operator's informed decision.
    const enabled = String(process.env.KHY_ENABLE_EXECUTE_CODE || '').trim() === '1';
    if (!enabled) {
      return {
        success: false,
        error: 'executeCode is disabled by default (it executes arbitrary code). Set ' +
               'KHY_ENABLE_EXECUTE_CODE=1 to enable it; execution is then confined to a ' +
               'permission-restricted subprocess with no filesystem/process/worker access.',
      };
    }

    const code = String(params.code == null ? '' : params.code);

    // Dispatch: javascript → hardened subprocess; everything else → native path.
    const canon = compileRegistry._canon(String(params.language || 'javascript').trim().toLowerCase());
    if (canon !== 'javascript') {
      return await _runNative(canon, code, context);
    }

    // The fine-grained permission policy may impose a tighter code-execution
    // timeout (codeExecution.limits.timeoutMs). Honor it as an additional cap —
    // it can only SHORTEN the wall clock, never extend it. Fail-soft: any error
    // leaves the default PROC_TIMEOUT_MS unchanged.
    let effProcTimeout = PROC_TIMEOUT_MS;
    try {
      const policyLimits = require('../services/permissionPolicy').getCodeExecutionLimits();
      if (policyLimits && policyLimits.timeoutMs > 0) {
        effProcTimeout = Math.min(PROC_TIMEOUT_MS, policyLimits.timeoutMs);
      }
    } catch { /* policy middleware optional */ }

    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      let child;
      try {
        // Layer 3: fresh `node --permission` process with NO --allow-* grants.
        // Minimal env (only the source) so no host secret reaches the child.
        child = execFile(
          process.execPath,
          ['--permission', '-e', CHILD_RUNNER],
          {
            env: { __KHY_SRC__: code },
            timeout: effProcTimeout,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            const out = String(stdout || '');
            const idx = out.indexOf(RESULT_SENTINEL);
            if (idx >= 0) {
              // Inner runner produced a verdict (success OR a caught user error).
              try {
                const verdict = JSON.parse(out.slice(idx + RESULT_SENTINEL.length));
                if (verdict && verdict.ok) {
                  return done({ success: true, result: verdict.result });
                }
                return done({ success: false, error: verdict ? verdict.error : 'Unknown error' });
              } catch (parseErr) {
                return done({ success: false, error: 'Sandbox result parse failed: ' + parseErr.message });
              }
            }
            // No verdict: process was killed (timeout) or failed to start. Fail closed —
            // never fall back to in-process execution.
            if (err && err.killed) {
              return done({ success: false, error: `Execution timed out after ${effProcTimeout}ms (process killed).` });
            }
            const detail = (String(stderr || '').trim() || (err && err.message) || 'no output').slice(0, 500);
            return done({ success: false, error: 'Sandbox execution failed: ' + detail });
          },
        );
      } catch (spawnErr) {
        return done({ success: false, error: 'Failed to start sandbox process: ' + spawnErr.message });
      }

      if (child) {
        child.on('error', (e) => done({ success: false, error: 'Sandbox process error: ' + e.message }));
      }
    });
  },
});
