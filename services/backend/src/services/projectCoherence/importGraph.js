'use strict';

/**
 * importGraph.js — 跨文件依赖与导出符号的确定性解析器（[DESIGN-ARCH-050] §3.1）。
 *
 * 「项目整体意识」的第一块基石：把单个源文件坍缩成两份结构化事实——
 *   1) imports：这个文件向外**索取**了什么（模块说明符 + 具体符号名）
 *   2) exports：这个文件向外**承诺**了什么（导出的符号名 + default/动态标记）
 *
 * 设计铁律：
 *   • 零依赖、零模型——纯正则 + Node 内建。解析失败必须 fail-safe（返回保守的空/未知），
 *     绝不抛错，绝不臆造。下游用「高置信度才上报」策略消化不确定性。
 *   • 只认三类语言：js/ts/jsx/tsx/mjs/cjs、py；其余返回空图（不参与一致性判定）。
 *   • 动态/通配导出（Object.assign、export *、运行时拼接）一律标 dynamic，让命名导出
 *     检查对该模块**整体跳过**，从根上避免误报阻塞交付。
 */

const path = require('path');

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const PY_EXT = new Set(['.py', '.pyi']);

/**
 * @param {string} file  文件路径（仅用于按扩展名判定语言）
 * @returns {'js'|'py'|null}
 */
function detectLang(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (JS_EXT.has(ext)) return 'js';
  if (PY_EXT.has(ext)) return 'py';
  return null;
}

/** 去除行内/块注释，降低正则误命中注释里的 import 字样。fail-safe：异常返回原文。 */
function _stripComments(src) {
  try {
    return String(src)
      // 块注释
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // 行注释（避免吃掉 URL 的 //，要求前面不是冒号）
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  } catch {
    return String(src || '');
  }
}

/** 从一段 `{ a, b as c }` 形式的内容提取「源端」符号名。`b as c` → b（被导入的是 b）。 */
function _parseNamedClause(clause) {
  const out = [];
  if (!clause) return out;
  for (const raw of clause.split(',')) {
    const piece = raw.trim();
    if (!piece) continue;
    // `b as c` → 取 as 左侧；`type X` (TS) → 去掉 type 前缀
    const m = piece.replace(/^type\s+/, '').match(/^([A-Za-z_$][\w$]*)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function _parseJs(src) {
  const text = _stripComments(src);
  const imports = [];
  const exportNames = new Set();
  let hasDefaultExport = false;
  let dynamicExports = false;

  const addImport = (spec, names, kind) => {
    if (!spec) return;
    imports.push({ spec, names: names || [], kind: kind || 'esm' });
  };

  // ── ESM: import ... from 'spec' ─────────────────────────────────────
  // 覆盖 default / namespace / named / 副作用 / 混合 五种形态。
  const importRe = /import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    const clause = (m[1] || '').trim();
    const spec = m[2];
    const names = [];
    if (clause) {
      // namespace: * as ns
      if (/\*\s+as\s+[A-Za-z_$]/.test(clause)) names.push('*');
      // named: { ... }
      const braced = clause.match(/\{([\s\S]*?)\}/);
      if (braced) names.push(..._parseNamedClause(braced[1]));
      // default：clause 以标识符开头（非 { 非 *）
      const defM = clause.match(/^([A-Za-z_$][\w$]*)/);
      if (defM && !clause.startsWith('{') && !clause.startsWith('*')) names.push('default');
    }
    addImport(spec, names, 'esm');
  }

  // ── ESM: re-export `export { a } from 'spec'` / `export * from 'spec'` ─
  const reexportRe = /export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{([\s\S]*?)\})\s+from\s+["']([^"']+)["']/g;
  while ((m = reexportRe.exec(text)) !== null) {
    const names = m[1] ? _parseNamedClause(m[1]) : ['*'];
    addImport(m[2], names, 'esm');
    // `export * from` 让本模块导出面变得不可静态确定
    if (!m[1]) dynamicExports = true;
    else for (const n of _parseNamedClause(m[1])) exportNames.add(n);
  }

  // ── CJS: require('spec')，含解构 const { a } = require('spec') ──────
  const requireRe = /(?:(?:const|let|var)\s+(\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s*=\s*)?require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(text)) !== null) {
    const binding = (m[1] || '').trim();
    const names = [];
    if (binding.startsWith('{')) {
      const inner = binding.slice(1, -1);
      names.push(..._parseNamedClause(inner));
    } else if (binding) {
      names.push('default');
    }
    addImport(m[2], names, 'cjs');
  }

  // ── 动态 import('spec') ────────────────────────────────────────────
  const dynImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynImportRe.exec(text)) !== null) addImport(m[1], [], 'esm');

  // ── ESM 导出符号 ───────────────────────────────────────────────────
  let em;
  const namedDeclRe = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((em = namedDeclRe.exec(text)) !== null) exportNames.add(em[1]);
  const exportListRe = /export\s+\{([^}]*)\}(?!\s*from)/g;
  while ((em = exportListRe.exec(text)) !== null) {
    // `a as b` 对外导出名是 b
    for (const raw of em[1].split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const asM = piece.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      if (asM) { exportNames.add(asM[1]); continue; }
      const idM = piece.replace(/^type\s+/, '').match(/^([A-Za-z_$][\w$]*)/);
      if (idM) exportNames.add(idM[1]);
    }
  }
  if (/export\s+default\b/.test(text)) hasDefaultExport = true;

  // ── CJS 导出符号 ───────────────────────────────────────────────────
  // exports.NAME = / module.exports.NAME =
  const cjsPropRe = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((em = cjsPropRe.exec(text)) !== null) exportNames.add(em[1]);
  // module.exports = { a, b, c }  —— 取对象字面量的键
  const cjsObjRe = /module\.exports\s*=\s*\{([\s\S]*?)\}/g;
  while ((em = cjsObjRe.exec(text)) !== null) {
    for (const raw of em[1].split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const keyM = piece.match(/^([A-Za-z_$][\w$]*)\s*[:,]?/);
      if (keyM) exportNames.add(keyM[1]);
    }
    hasDefaultExport = true; // 对象整体也可作为默认导入
  }
  // module.exports = <非对象>（函数/类/标识符/Object.assign…）→ 默认导出 + 动态面
  if (/module\.exports\s*=\s*(?!\{)/.test(text)) {
    hasDefaultExport = true;
    if (/Object\.assign\s*\(\s*(?:module\.)?exports/.test(text)) dynamicExports = true;
  }
  if (/Object\.assign\s*\(\s*(?:module\.)?exports/.test(text)) dynamicExports = true;
  if (/(?:module\.)?exports\s*\[/.test(text)) dynamicExports = true; // exports['x'] 计算键

  return {
    lang: 'js',
    imports,
    exports: { names: exportNames, hasDefault: hasDefaultExport, dynamic: dynamicExports },
  };
}

function _parsePy(src) {
  const text = String(src || '');
  const imports = [];
  const exportNames = new Set();

  // from .mod import a, b   |   from ..pkg import x   |   from . import mod
  const fromRe = /^[ \t]*from\s+(\.+[\w.]*|\.)\s+import\s+([^\n#]+)/gm;
  let m;
  while ((m = fromRe.exec(text)) !== null) {
    const spec = m[1];
    const names = m[2]
      .replace(/[()]/g, '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => s && s !== '*');
    imports.push({ spec, names, kind: 'py-from' });
  }
  // import .mod 不合法；相对只能用 from。绝对 import 不做解析（无法可靠定位项目根）。

  // 顶层定义可视作「导出」：def/class/赋值。__all__ 显式声明优先。
  const allM = text.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (allM) {
    for (const q of allM[1].matchAll(/["']([\w]+)["']/g)) exportNames.add(q[1]);
  } else {
    for (const dm of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) exportNames.add(dm[1]);
    for (const cm of text.matchAll(/^class\s+([A-Za-z_]\w*)/gm)) exportNames.add(cm[1]);
    for (const am of text.matchAll(/^([A-Za-z_]\w*)\s*=/gm)) exportNames.add(am[1]);
  }

  return {
    lang: 'py',
    imports,
    // Python 命名导出过于动态（运行时注入、re-export），标 dynamic 让命名检查整体跳过，
    // 只保留「目标文件是否存在」这一高置信度判定。
    exports: { names: exportNames, hasDefault: false, dynamic: true },
  };
}

/**
 * 解析单个文件内容为依赖图节点。
 * @param {string} file  文件路径（决定语言）
 * @param {string} src   文件文本内容
 * @returns {{lang:string|null, imports:Array, exports:{names:Set<string>,hasDefault:boolean,dynamic:boolean}}}
 */
function parseFile(file, src) {
  const empty = { lang: null, imports: [], exports: { names: new Set(), hasDefault: false, dynamic: true } };
  const lang = detectLang(file);
  if (!lang) return empty;
  try {
    return lang === 'js' ? _parseJs(src) : _parsePy(src);
  } catch {
    return empty; // fail-safe：解析崩了就当作不可分析，绝不阻塞
  }
}

module.exports = { parseFile, detectLang };
