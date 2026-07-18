'use strict';

/**
 * compile/diagnostics.js — single source of truth for turning raw compiler /
 * build output into structured diagnostics.
 *
 * Extracted from buildProject.js `_parseErrors` (behavior-preserving for the
 * project types build_project already handled: nodejs, cmake, rust, go, and the
 * generic gcc/make line) and extended with per-language parsers for the single
 * file compile tool: clang (same gcc grammar), tsc, javac, dotnet/MSBuild,
 * python (py_compile / pyflakes), moonbit.
 *
 * Output shape (superset of the original {file,line,col,message} so build_project
 * keeps working unchanged):
 *   { file, line, col, severity: 'error'|'warning', code: string|null, message }
 */

function _int(s) { return s ? parseInt(s, 10) : null; }

/**
 * Parse raw build/compile output into structured errors and warnings.
 * @param {string} output   combined stdout+stderr
 * @param {string} type     project/language hint (nodejs|cmake|rust|go|c|cpp|
 *                           make|typescript|java|csharp|dotnet|python|moonbit|…)
 * @returns {{errors: Array, warnings: Array}}
 */
function parseDiagnostics(output, type) {
  const errors = [];
  const warnings = [];
  const lines = String(output == null ? '' : output).split('\n');
  const push = (sev, entry) => (sev === 'error' ? errors : warnings).push(entry);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Webpack / TypeScript-via-bundler / ESBuild: "ERROR in ./path:line:col"
    if (type === 'nodejs' || type === 'cmake') {
      const errMatch = line.match(/ERROR\s+in\s+(.+?)(?::(\d+):(\d+))?/);
      if (errMatch) { push('error', { file: errMatch[1], line: _int(errMatch[2]), col: _int(errMatch[3]), severity: 'error', code: null, message: lines[i + 1]?.trim() || '' }); continue; }
      const warnMatch = line.match(/WARNING\s+in\s+(.+?)(?::(\d+):(\d+))?/);
      if (warnMatch) { push('warning', { file: warnMatch[1], line: _int(warnMatch[2]), col: _int(warnMatch[3]), severity: 'warning', code: null, message: lines[i + 1]?.trim() || '' }); continue; }
    }

    // ── tsc: "file(line,col): error TS2304: message"
    if (type === 'typescript' || type === 'ts' || type === 'nodejs') {
      const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/);
      if (tsMatch) { push(tsMatch[4], { file: tsMatch[1], line: _int(tsMatch[2]), col: _int(tsMatch[3]), severity: tsMatch[4], code: tsMatch[5], message: tsMatch[6] }); continue; }
    }

    // ── dotnet / MSBuild: "file(line,col): error CS0103: message [proj]"
    if (type === 'csharp' || type === 'dotnet') {
      const csMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+?)(?:\s*\[[^\]]+\])?$/);
      if (csMatch) { push(csMatch[4], { file: csMatch[1], line: _int(csMatch[2]), col: _int(csMatch[3]), severity: csMatch[4], code: csMatch[5], message: csMatch[6] }); continue; }
    }

    if (type === 'rust') {
      const errMatch = line.match(/^error(?:\[(E\d+)\])?: (.+)/);
      if (errMatch) { push('error', { file: '', line: null, col: null, severity: 'error', code: errMatch[1] || null, message: errMatch[2] }); continue; }
      const warnMatch = line.match(/^warning(?:\[(.+?)\])?: (.+)/);
      if (warnMatch) { push('warning', { file: '', line: null, col: null, severity: 'warning', code: warnMatch[1] || null, message: warnMatch[2] }); continue; }
    }

    if (type === 'go') {
      const goMatch = line.match(/^\.?\/?(.+?):(\d+):(\d+):\s*(.+)/);
      if (goMatch) {
        const sev = goMatch[4].includes('error') ? 'error' : 'warning';
        push(sev, { file: goMatch[1], line: _int(goMatch[2]), col: _int(goMatch[3]), severity: sev, code: null, message: goMatch[4] });
        continue;
      }
    }

    // ── javac: "file:line: error: message" (no column)
    if (type === 'java') {
      const jMatch = line.match(/^(.+?):(\d+):\s*(error|warning):\s*(.+)/);
      if (jMatch) { push(jMatch[3], { file: jMatch[1], line: _int(jMatch[2]), col: null, severity: jMatch[3], code: null, message: jMatch[4] }); continue; }
    }

    // ── python py_compile / traceback: '  File "x.py", line N' then 'XxxError: msg'
    if (type === 'python') {
      const fileMatch = line.match(/^\s*File "(.+?)", line (\d+)/);
      if (fileMatch) {
        // The actual message is on a following line ("SyntaxError: ...").
        let msg = '';
        for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
          const m = lines[j].match(/^(\w*Error):\s*(.+)/);
          if (m) { msg = `${m[1]}: ${m[2]}`; break; }
        }
        push('error', { file: fileMatch[1], line: _int(fileMatch[2]), col: null, severity: 'error', code: null, message: msg || lines[i + 1]?.trim() || '' });
        continue;
      }
      // pyflakes/ruff: "file:line:col: message"
      const pyf = line.match(/^(.+?\.py):(\d+):(\d+):\s*(.+)/);
      if (pyf) { push('warning', { file: pyf[1], line: _int(pyf[2]), col: _int(pyf[3]), severity: 'warning', code: null, message: pyf[4] }); continue; }
    }

    // ── moonbit: "file:line:col-...: Error: message"
    if (type === 'moonbit') {
      const mbMatch = line.match(/^(.+?):(\d+):(\d+).*?:\s*(Error|Warning):\s*(.+)/);
      if (mbMatch) { const sev = mbMatch[4].toLowerCase() === 'error' ? 'error' : 'warning'; push(sev, { file: mbMatch[1], line: _int(mbMatch[2]), col: _int(mbMatch[3]), severity: sev, code: null, message: mbMatch[5] }); continue; }
    }

    // ── GCC / Clang / Make generic: "path:line:col: error|warning: message"
    //    Runs for EVERY type (the catch-all that the original kept outside the
    //    type-specific blocks), so c/cpp/make and unknown types are covered.
    const gccMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)/);
    if (gccMatch) {
      push(gccMatch[4], { file: gccMatch[1], line: _int(gccMatch[2]), col: _int(gccMatch[3]), severity: gccMatch[4], code: null, message: gccMatch[5] });
    }
  }

  return { errors, warnings };
}

module.exports = { parseDiagnostics, _int };
