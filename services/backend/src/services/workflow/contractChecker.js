/**
 * contractChecker.js — Intent contract checker: verifies the post-condition
 * assertions declared in a flow's `_meta.contract` after a deterministic replay.
 *
 * Assertion schema (5 types, whitelisted by flowRegistry.save):
 *   { type: 'fileExists',   path }            local fs.existsSync check
 *   { type: 'fileContains', path, text }      read file (utf8), check inclusion
 *   { type: 'varContains',  var,  text }      stringify ctx.vars[var], check inclusion
 *   { type: 'windowTitle',  pattern }         regex over titles from
 *                                             ctx.executeTool('DesktopControl', { action: 'listWindows' })
 *   { type: 'httpStatus',   url,  expect }    axios GET, 30s timeout, status === expect (default 200)
 *
 * ctx contract: { vars: object, executeTool?: async (toolName, params) => result }.
 *
 * Design (fail-soft everywhere, aligned with flowRegistry/flowStats):
 * - String assertion values support {{var}} interpolation from ctx.vars —
 *   same syntax as workflowExecutor.interpolate; undefined vars keep the
 *   original text.
 * - One assertion throwing yields { passed:false, reason:'校验执行异常...' }
 *   for that assertion only; the loop continues.
 * - windowTitle/httpStatus whose runtime dependency is unavailable
 *   (executeTool not injected, desktop gate closed/denied, axios missing)
 *   yield { passed:true, skipped:true } so a missing environment never fails
 *   the whole contract.
 * - Overall passed = every non-skipped assertion passed. Non-array / empty
 *   assertions → { passed:true, results:[] }. checkContract itself never throws.
 */
'use strict';

const fs = require('fs');

// Same wall-clock as the executor's http primitive (workflowExecutor.defaultPrimitives).
const HTTP_TIMEOUT_MS = 30000;

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Resolve a dotted path ("a.b.c") inside an object bag. Prototype-chain keys
// (__proto__ / prototype / constructor) are rejected as a pollution guard:
// the whole lookup returns undefined so interpolation keeps the raw text.
function _getPath(obj, dotted) {
  let acc = obj;
  for (const k of String(dotted).split('.')) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') {
      return undefined;
    }
    if (acc == null) {
      return undefined;
    }
    acc = acc[k];
  }
  return acc;
}

// {{ var.path }} interpolation, aligned with workflowExecutor.interpolate.
// Undefined variables keep the original "{{...}}" text (lenient by design).
function interpolateVars(value, vars) {
  if (value == null) {
    return '';
  }
  const bag = vars && typeof vars === 'object' ? vars : {};
  return String(value).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, key) => {
    const v = _getPath(bag, key);
    if (v === undefined) {
      return raw;
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Extract window titles from a DesktopControl listWindows result. The tool
// returns { success, backend, stdout }: on Windows stdout is ConvertTo-Json of
// { ProcessName, MainWindowTitle } (object or array); on mac/Linux backends it
// is plain text lines. Fall back to raw non-empty lines when not JSON.
function extractWindowTitles(result) {
  const out = [];
  const stdout = result && typeof result.stdout === 'string' ? result.stdout : '';
  const t = stdout.trim();
  if (!t) {
    return out;
  }
  try {
    const parsed = JSON.parse(t);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const it of items) {
      if (!it || typeof it !== 'object') {
        continue;
      }
      const title = it.MainWindowTitle || it.title || it.name || '';
      if (title) {
        out.push(String(title));
      }
    }
    if (out.length) {
      return out;
    }
  } catch {
    /* not JSON — fall through to raw lines */
  }
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (s) {
      out.push(s);
    }
  }
  return out;
}

// ── Per-assertion checkers ───────────────────────────────────────────────────

async function _checkOne(assertion, ctx) {
  const a = assertion && typeof assertion === 'object' ? assertion : {};
  const vars = (ctx && ctx.vars) || {};
  switch (a.type) {
    case 'fileExists': {
      const p = interpolateVars(a.path, vars);
      const ok = !!p && fs.existsSync(p);
      return {
        type: 'fileExists',
        passed: ok,
        reason: `检查文件 ${p || '(空路径)'} 存在:${ok ? '通过' : '文件不存在'}`,
      };
    }
    case 'fileContains': {
      const p = interpolateVars(a.path, vars);
      const text = interpolateVars(a.text, vars);
      if (!p || !fs.existsSync(p)) {
        return {
          type: 'fileContains',
          passed: false,
          reason: `检查文件 ${p || '(空路径)'} 包含「${text}」:文件不存在`,
        };
      }
      const ok = fs.readFileSync(p, 'utf8').includes(text);
      return {
        type: 'fileContains',
        passed: ok,
        reason: `检查文件 ${p} 包含「${text}」:${ok ? '通过' : '未包含'}`,
      };
    }
    case 'varContains': {
      const name = String(a.var == null ? '' : a.var);
      const text = interpolateVars(a.text, vars);
      const v = _getPath(vars, name);
      if (v === undefined) {
        return {
          type: 'varContains',
          passed: false,
          reason: `检查变量 ${name || '(空变量名)'} 包含「${text}」:变量未定义`,
        };
      }
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const ok = s.includes(text);
      return {
        type: 'varContains',
        passed: ok,
        reason: `检查变量 ${name} 包含「${text}」:${ok ? '通过' : '未包含'}`,
      };
    }
    case 'windowTitle': {
      const pattern = interpolateVars(a.pattern, vars);
      // ReDoS guard: an interpolated pattern longer than 256 chars is almost
      // certainly data (not a title regex) — skip instead of risking a
      // catastrophic-backtracking test below.
      if (pattern.length > 256) {
        return {
          type: 'windowTitle',
          passed: true,
          skipped: true,
          reason: `检查窗口标题匹配「${pattern.slice(0, 80)}…」:模式过长,跳过校验`,
        };
      }
      if (!ctx || typeof ctx.executeTool !== 'function') {
        return {
          type: 'windowTitle',
          passed: true,
          skipped: true,
          reason: `检查窗口标题匹配「${pattern}」:executeTool 未注入,跳过校验`,
        };
      }
      const res = await ctx.executeTool('DesktopControl', { action: 'listWindows' });
      if (!res || res.success !== true) {
        const why = (res && (res.error || res.reason)) || '桌面操控不可用';
        return {
          type: 'windowTitle',
          passed: true,
          skipped: true,
          reason: `检查窗口标题匹配「${pattern}」:窗口列表工具不可用(${String(why).slice(0, 120)}),跳过校验`,
        };
      }
      let re;
      try {
        re = new RegExp(pattern, 'i');
      } catch (err) {
        // Invalid regex syntax is a spec problem, not a contract miss — skip.
        return {
          type: 'windowTitle',
          passed: true,
          skipped: true,
          reason: `检查窗口标题匹配「${pattern}」:正则语法错误(${String((err && err.message) || err).slice(0, 120)}),跳过校验`,
        };
      }
      const titles = extractWindowTitles(res);
      const hit = titles.find((t) => re.test(t));
      return hit
        ? {
            type: 'windowTitle',
            passed: true,
            reason: `检查窗口标题匹配「${pattern}」:通过(命中「${String(hit).slice(0, 80)}」)`,
          }
        : {
            type: 'windowTitle',
            passed: false,
            reason: `检查窗口标题匹配「${pattern}」:未命中(共 ${titles.length} 个窗口)`,
          };
    }
    case 'httpStatus': {
      let axios;
      try {
        axios = require('axios');
      } catch {
        return {
          type: 'httpStatus',
          passed: true,
          skipped: true,
          reason: '检查 HTTP 状态:axios 依赖不可用,跳过校验',
        };
      }
      const url = interpolateVars(a.url, vars);
      // Protocol allowlist: only http/https make sense for an axios GET; an
      // unparsable or non-http URL is a spec problem, not a contract miss.
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return {
          type: 'httpStatus',
          passed: true,
          skipped: true,
          reason: `检查 ${url} HTTP 状态:URL 非法,跳过校验`,
        };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return {
          type: 'httpStatus',
          passed: true,
          skipped: true,
          reason: `检查 ${url} HTTP 状态:协议 ${parsedUrl.protocol} 不受支持,跳过校验`,
        };
      }
      const expect = Number.isFinite(Number(a.expect)) ? Number(a.expect) : 200;
      try {
        const res = await axios({
          method: 'GET',
          url,
          timeout: HTTP_TIMEOUT_MS,
          validateStatus: () => true,
        });
        const ok = res.status === expect;
        return {
          type: 'httpStatus',
          passed: ok,
          reason: `检查 ${url} HTTP 状态:期望 ${expect},实际 ${res.status},${ok ? '通过' : '不通过'}`,
        };
      } catch (err) {
        // Network-level failure (DNS/refused/timeout): a real contract miss.
        return {
          type: 'httpStatus',
          passed: false,
          reason: `检查 ${url} HTTP 状态:请求失败(${(err && err.message) || String(err)})`,
        };
      }
    }
    default:
      return {
        type: String(a.type || 'unknown'),
        passed: false,
        reason: `检查断言类型「${String(a.type)}」:不支持的类型,不通过`,
      };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check a contract assertion array against the execution context.
 * @param {Array<object>} assertions  flow `_meta.contract`
 * @param {{vars?:object, executeTool?:(toolName:string,params:object)=>Promise<object>}} [ctx]
 * @returns {Promise<{passed:boolean, results:Array<{type:string,passed:boolean,reason:string,skipped?:boolean}>}>}
 *   Never throws; overall passed = all non-skipped assertions passed.
 */
async function checkContract(assertions, ctx) {
  try {
    if (!Array.isArray(assertions) || assertions.length === 0) {
      return { passed: true, results: [] };
    }
    const results = [];
    for (const a of assertions) {
      try {
        results.push(await _checkOne(a, ctx || {}));
      } catch (err) {
        const type = a && typeof a === 'object' && a.type ? String(a.type) : 'unknown';
        results.push({
          type,
          passed: false,
          reason: `校验执行异常: ${(err && err.message) || String(err)}`,
        });
      }
    }
    const passed = results.every((r) => r.skipped === true || r.passed === true);
    return { passed, results };
  } catch (err) {
    return {
      passed: false,
      results: [
        {
          type: 'contract',
          passed: false,
          reason: `校验执行异常: ${(err && err.message) || String(err)}`,
        },
      ],
    };
  }
}

module.exports = {
  checkContract,
  // pure helpers (unit-tested)
  interpolateVars,
  extractWindowTitles,
};
