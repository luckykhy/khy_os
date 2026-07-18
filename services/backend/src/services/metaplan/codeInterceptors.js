'use strict';

/**
 * codeInterceptors.js — the REAL code-safety nets a Code_Hard strategy mounts
 * (目标11 §3). These are the "锁具" actually clamped onto an executor before it is
 * allowed to write: each returns a pass/fail verdict on candidate content so a
 * syntactically broken edit is rejected BEFORE it ever touches disk.
 *
 * Interceptors are deliberately dependency-light and fail-safe:
 *   - `babel`        → @babel/parser (JS/TS/JSX); the project already ships it.
 *   - `vm_or_native` → JS via the built-in `vm` compile probe; other langs fall
 *                      back to a lightweight bracket/quote-balance probe.
 *   - `python_ast`   → `python3 -c "import ast; ast.parse(...)"` via spawnSync.
 *   - null           → raw, no validation (the Prompt_Soft / raw_string path).
 *
 * A validator NEVER throws to the caller: a missing parser or absent python3 is
 * reported as `{ok:true, skipped:true, note}` so the system degrades to "no worse
 * than today" rather than blocking work — the constraint is a safety net, not a
 * tripwire that halts the agent when tooling is unavailable.
 *
 * Pure w.r.t. the filesystem (python validation spawns a short-lived, sandboxable
 * child that only parses a string passed on argv/stdin; it writes nothing).
 */

const { spawnSync } = require('child_process');
const vm = require('vm');

/** Lazy, cached parser handles so a missing optional dep degrades gracefully. */
let _babel = null;
let _babelTried = false;
function _getBabel() {
  if (_babelTried) return _babel;
  _babelTried = true;
  try { _babel = require('@babel/parser'); } catch { _babel = null; }
  return _babel;
}

/** Validate JS/TS/JSX via @babel/parser. */
function validateJs(code, { typescript = false, jsx = true } = {}) {
  const babel = _getBabel();
  if (!babel) return _vmProbe(code); // fall back to vm compile probe
  const plugins = [];
  if (jsx) plugins.push('jsx');
  if (typescript) plugins.push('typescript');
  try {
    babel.parse(String(code == null ? '' : code), {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
      plugins,
    });
    return { ok: true, validator: 'babel' };
  } catch (e) {
    return {
      ok: false,
      validator: 'babel',
      error: _fmtErr(e),
      line: e && e.loc ? e.loc.line : undefined,
    };
  }
}

/** JS compile probe via the built-in vm (no deps); used as a babel fallback. */
function _vmProbe(code) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(String(code == null ? '' : code), { filename: '__metaplan_probe__.js' });
    return { ok: true, validator: 'vm' };
  } catch (e) {
    if (e instanceof SyntaxError) {
      return { ok: false, validator: 'vm', error: _fmtErr(e) };
    }
    // A non-syntax error (e.g. reference at top level) does not mean bad syntax.
    return { ok: true, validator: 'vm', note: 'vm 非语法错误，视为语法通过。' };
  }
}

/** Validate Python via a short-lived `ast.parse` child process. */
function validatePython(code) {
  const src = String(code == null ? '' : code);
  const py = process.env.KHY_PYTHON_BIN || 'python3';
  let res;
  try {
    res = spawnSync(
      py,
      ['-c', 'import sys,ast; ast.parse(sys.stdin.read())'],
      { input: src, encoding: 'utf8', timeout: 8000 },
    );
  } catch (e) {
    return { ok: true, validator: 'python_ast', skipped: true, note: `无法启动 ${py}：${e.message}` };
  }
  if (res.error) {
    return { ok: true, validator: 'python_ast', skipped: true, note: `python 不可用：${res.error.message}` };
  }
  if (res.status === 0) return { ok: true, validator: 'python_ast' };
  return {
    ok: false,
    validator: 'python_ast',
    error: _firstSyntaxLine(res.stderr) || 'Python 语法错误。',
  };
}

/** Cross-language last-resort: bracket/quote balance probe (no parser). */
function validateBalance(code) {
  const src = String(code == null ? '' : code);
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack = [];
  let inStr = null;
  let prev = '';
  for (const ch of src) {
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      prev = ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; prev = ch; continue; }
    if (opens.has(ch)) stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) {
        return { ok: false, validator: 'balance', error: `括号不配平：意外的 '${ch}'。` };
      }
    }
    prev = ch;
  }
  if (inStr) return { ok: false, validator: 'balance', error: '字符串引号未闭合。' };
  if (stack.length) return { ok: false, validator: 'balance', error: `括号不配平：${stack.length} 个未闭合。` };
  return { ok: true, validator: 'balance', note: '仅做结构配平探测（该语言无 AST 校验器）。' };
}

/**
 * Run the named interceptor on candidate content for a language.
 * @param {(string|null)} validatorKey  from the executor registry
 * @param {string} content
 * @param {object} [ctx] { language }
 * @returns {{ok:boolean, validator?:string, error?:string, skipped?:boolean, note?:string}}
 */
function runInterceptor(validatorKey, content, ctx = {}) {
  const lang = String(ctx.language || '').trim().toLowerCase();
  if (!validatorKey) return { ok: true, validator: 'none', note: '无 AST 校验（裸执行器，风险自担）。' };

  switch (validatorKey) {
    case 'babel':
      return validateJs(content, {
        typescript: lang === 'typescript' || lang === 'tsx',
        jsx: lang !== 'typescript', // ts (non-tsx) disallows jsx ambiguity
      });
    case 'python_ast':
      return validatePython(content);
    case 'vm_or_native':
      if (['javascript', 'typescript', 'jsx', 'tsx', ''].includes(lang)) return _vmProbe(content);
      if (lang === 'python') return validatePython(content);
      return validateBalance(content);
    default:
      return { ok: true, validator: validatorKey, skipped: true, note: `未知校验器 ${validatorKey}，跳过。` };
  }
}

function _fmtErr(e) {
  return String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200);
}
function _firstSyntaxLine(stderr) {
  const text = String(stderr || '');
  const m = text.split('\n').reverse().find((l) => /Error/.test(l));
  return m ? m.trim().slice(0, 200) : '';
}

module.exports = {
  validateJs,
  validatePython,
  validateBalance,
  runInterceptor,
};
