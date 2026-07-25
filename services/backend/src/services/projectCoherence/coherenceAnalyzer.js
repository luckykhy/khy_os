'use strict';

/**
 * coherenceAnalyzer.js — 项目整体一致性分析（[DESIGN-ARCH-050] §3.3）。
 *
 * 把「一批刚写好的文件」当作一个**整体**来审视，回答用户那句核心痛点：
 * 「单个文件没问题，聚在一起就出问题」。它只揪三类**高/中置信度、聚合期才暴露**的断裂：
 *
 *   1) unresolved_import (HIGH)  —— 文件 import 了一个本地模块，但那个文件在
 *      「本会话产物 + 磁盘」里根本不存在。这是装配失败的头号原因。
 *   2) broken_manifest   (HIGH)  —— package.json 的 main/module/bin/exports 指向不存在的文件，
 *      或脚本入口缺失。装出来的包一跑就崩。
 *   3) missing_export    (MED)   —— 文件按名导入 `{ foo }`，但目标模块确实没导出 foo
 *      （仅当目标导出面可静态确定、非动态时才判，零容忍误报）。
 *
 * 绝不上报低置信度结论（孤儿文件、无入口、风格不一致）——宁可漏报，不可错误阻塞交付。
 */

const fs = require('fs');
const path = require('path');
const { parseFile, detectLang } = require('./importGraph');
const { resolveImport, makeIoFromSet } = require('./resolver');

const SEVERITY = { HIGH: 'high', MEDIUM: 'medium' };
const DEFAULT_MAX_FILES = 400;

function _defaultRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 仅检查「看起来是项目内相对/本地路径」的清单值，跳过 URL、glob、纯条件键。 */
function _looksLikeLocalPath(v) {
  if (typeof v !== 'string' || !v) return false;
  if (/^https?:|^[a-z]+:\/\//i.test(v)) return false;
  if (v.includes('*')) return false; // glob/exports 模式不逐一判定
  return v.startsWith('.') || v.startsWith('/') || /\.[cm]?[jt]sx?$|\.json$/.test(v);
}

/** 递归收集 exports 字段里的字符串叶子（条件导出可深层嵌套）。 */
function _collectExportLeaves(node, out) {
  if (typeof node === 'string') { out.push(node); return; }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) _collectExportLeaves(v, out);
  }
}

function _analyzeManifest(file, content, manifestDir, io, gaps) {
  let pkg;
  try { pkg = JSON.parse(content); } catch { return; } // 坏 JSON 由语法门处理，这里只看引用
  if (!pkg || typeof pkg !== 'object') return;

  const refs = [];
  for (const key of ['main', 'module', 'types', 'typings', 'browser']) {
    if (_looksLikeLocalPath(pkg[key])) refs.push({ key, value: pkg[key] });
  }
  // bin: string 或 { name: path }
  if (typeof pkg.bin === 'string' && _looksLikeLocalPath(pkg.bin)) refs.push({ key: 'bin', value: pkg.bin });
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, p] of Object.entries(pkg.bin)) {
      if (_looksLikeLocalPath(p)) refs.push({ key: `bin.${name}`, value: p });
    }
  }
  // exports: 收集字符串叶子
  if (pkg.exports != null) {
    const leaves = [];
    _collectExportLeaves(pkg.exports, leaves);
    for (const p of leaves) if (_looksLikeLocalPath(p)) refs.push({ key: 'exports', value: p });
  }

  for (const ref of refs) {
    const abs = path.resolve(manifestDir, ref.value);
    // 清单引用通常带扩展名；也容忍省略扩展名的入口
    const ok = io.exists(abs) && !io.isDir(abs);
    const okAlt = !ok && ['.js', '.mjs', '.cjs', '.json'].some((e) => io.exists(abs + e));
    if (!ok && !okAlt) {
      gaps.push({
        kind: 'broken_manifest',
        severity: SEVERITY.HIGH,
        file,
        field: ref.key,
        target: ref.value,
        detail: `package.json 的 "${ref.key}" 指向 "${ref.value}"，但该文件不存在。`,
      });
    }
  }
}

/**
 * 分析一批文件的整体一致性。
 * @param {object} opts
 * @param {string[]} opts.files            被创建/修改的文件路径（绝对或相对 cwd）
 * @param {string}   [opts.cwd]            项目根，用于解析相对路径，默认 process.cwd()
 * @param {function} [opts.readFile]       (absPath)=>string|null，可注入；默认 fs
 * @param {Iterable<string>} [opts.knownFiles] 额外「视为存在」的文件（默认 = files）
 * @param {number}   [opts.maxFiles]
 * @returns {{gaps:Array, analyzed:number, skipped:number}}
 */
function analyze(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const read = opts.readFile || _defaultRead;
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;

  const absFiles = (opts.files || [])
    .filter(Boolean)
    .map((f) => path.resolve(cwd, f));
  const knownAbs = [...new Set([...absFiles, ...[...(opts.knownFiles || [])].map((f) => path.resolve(cwd, f))])];
  const io = makeIoFromSet(knownAbs, true);

  const gaps = [];
  let analyzed = 0;
  let skipped = 0;

  // 目标模块导出面缓存：resolvedPath → exports 对象（避免重复读取/解析）
  const exportCache = new Map();
  const getExports = (resolvedPath) => {
    if (exportCache.has(resolvedPath)) return exportCache.get(resolvedPath);
    const src = read(resolvedPath);
    const parsed = src == null ? null : parseFile(resolvedPath, src);
    const ex = parsed ? parsed.exports : null;
    exportCache.set(resolvedPath, ex);
    return ex;
  };

  for (const file of absFiles.slice(0, maxFiles)) {
    const base = path.basename(file).toLowerCase();

    // package.json 走清单检查
    if (base === 'package.json') {
      const content = read(file);
      if (content != null) _analyzeManifest(file, content, path.dirname(file), io, gaps);
      analyzed += 1;
      continue;
    }

    const lang = detectLang(file);
    if (!lang) { skipped += 1; continue; }
    const content = read(file);
    if (content == null) { skipped += 1; continue; }

    const node = parseFile(file, content);
    analyzed += 1;

    for (const imp of node.imports) {
      const res = resolveImport(imp.spec, file, lang, io);
      if (!res.local) continue; // 裸包：不归我们管

      if (!res.resolved) {
        gaps.push({
          kind: 'unresolved_import',
          severity: SEVERITY.HIGH,
          file,
          spec: imp.spec,
          detail: `从 "${path.relative(cwd, file)}" 导入的本地模块 "${imp.spec}" 解析不到任何文件——装配后会立即报模块找不到。`,
        });
        continue;
      }

      // 命名导出一致性（仅 JS、目标导出面可静态确定、非动态时才判）
      if (lang === 'js') {
        const named = (imp.names || []).filter((n) => n !== 'default' && n !== '*');
        if (named.length === 0) continue;
        const ex = getExports(res.resolved);
        if (!ex || ex.dynamic || ex.names.size === 0) continue; // 无法确定导出面 → 跳过，零误报
        for (const name of named) {
          if (!ex.names.has(name)) {
            gaps.push({
              kind: 'missing_export',
              severity: SEVERITY.MEDIUM,
              file,
              spec: imp.spec,
              name,
              target: path.relative(cwd, res.resolved),
              detail: `"${path.relative(cwd, file)}" 按名导入了 "${name}"（来自 "${imp.spec}"），但目标模块并未导出该符号。`,
            });
          }
        }
      }
    }
  }

  return { gaps, analyzed, skipped };
}

module.exports = { analyze, SEVERITY };
