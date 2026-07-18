'use strict';

/**
 * dependencyImpactScanner.js — 依赖影响扫描器（§3.2 正交隔离舱：降维理解负担）。
 *
 * 把「修改某文件会波及谁」从人脑全局记忆中解放出来：扫描 `require('./x')` 相对引用建立
 * 正向 + 反向依赖图，给定一个改动文件，沿反向边求**传递闭包**，输出受影响下游清单与深度。
 *
 * 简单模型据此精准评估影响面（防呆④）：改动若无下游依赖，即可放心盲改内部实现；若有下游，
 * 标红逐一列出，强制评估后再动公共契约。
 *
 * 纯函数核心 `buildGraph(fileMap)` / `impactedBy(changedFile, graph)`；`scanDir` 是 fs 薄封装。
 * 仅解析相对引用（`./` `../`）——第三方包与内置模块不构成项目内耦合，刻意忽略。
 */

const fs = require('fs');
const path = require('path');

const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const IMPORT_RE = /\bimport\b[^'"]*['"](\.[^'"]+)['"]/g;

/** 把相对 spec 规范化为相对 fromFile 的 posix key（补 .js / index.js）。 */
function _resolveSpec(fromFile, spec, keys) {
  const dir = path.posix.dirname(fromFile);
  let base = path.posix.normalize(path.posix.join(dir, spec)).replace(/\\/g, '/');
  const candidates = [base];
  if (!/\.[A-Za-z]+$/.test(base)) {
    candidates.push(base + '.js', base + '.json', path.posix.join(base, 'index.js'));
  }
  for (const c of candidates) if (keys.has(c)) return c;
  return candidates.find((c) => c.endsWith('.js')) || base;   // 未命中也返回规范名（孤儿边）
}

class DependencyImpactScanner {
  /**
   * 从 {path: source} 映射构建依赖图（纯函数）。
   * @param {Object<string,string>} fileMap  key=posix 相对路径，value=源码
   * @returns {{forward:Object<string,string[]>, reverse:Object<string,string[]>, files:string[]}}
   */
  buildGraph(fileMap) {
    const files = Object.keys(fileMap || {});
    const keys = new Set(files);
    const forward = {};
    const reverse = {};
    for (const f of files) { forward[f] = []; if (!(f in reverse)) reverse[f] = []; }

    for (const f of files) {
      const src = String(fileMap[f] || '');
      const deps = new Set();
      for (const re of [REQUIRE_RE, IMPORT_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) deps.add(_resolveSpec(f, m[1], keys));
      }
      for (const d of deps) {
        if (d === f) continue;
        forward[f].push(d);
        if (!(d in reverse)) reverse[d] = [];
        if (!reverse[d].includes(f)) reverse[d].push(f);
      }
    }
    return { forward, reverse, files };
  }

  /**
   * 求改动文件的受影响下游传递闭包（沿反向边 BFS）。
   * @param {string} changedFile  posix 相对路径
   * @param {object} graph        buildGraph 的输出
   * @returns {{changed:string, impacted:Array<{file:string, depth:number}>, count:number, hasDownstream:boolean}}
   */
  impactedBy(changedFile, graph) {
    const reverse = (graph && graph.reverse) || {};
    const seen = new Set([changedFile]);
    const impacted = [];
    let frontier = [{ file: changedFile, depth: 0 }];
    while (frontier.length) {
      const next = [];
      for (const { file, depth } of frontier) {
        for (const up of reverse[file] || []) {
          if (seen.has(up)) continue;
          seen.add(up);
          impacted.push({ file: up, depth: depth + 1 });
          next.push({ file: up, depth: depth + 1 });
        }
      }
      frontier = next;
    }
    impacted.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
    return { changed: changedFile, impacted, count: impacted.length, hasDownstream: impacted.length > 0 };
  }

  /**
   * 扫描目录下所有 .js 构建 fileMap（唯一触盘处），key 相对 baseDir。
   * @param {string} baseDir
   * @param {object} [opts] { exts, exclude }
   * @returns {Object<string,string>}
   */
  scanDir(baseDir, opts = {}) {
    const exts = opts.exts || ['.js'];
    const exclude = opts.exclude || [/node_modules/, /\.test\.js$/];
    const fileMap = {};
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (exclude.some((re) => re.test(full))) continue;
        if (e.isDirectory()) { walk(full); continue; }
        if (!exts.some((x) => e.name.endsWith(x))) continue;
        const key = path.relative(baseDir, full).split(path.sep).join('/');
        try { fileMap[key] = fs.readFileSync(full, 'utf-8'); } catch { /* skip */ }
      }
    };
    walk(baseDir);
    return fileMap;
  }
}

module.exports = { DependencyImpactScanner };
