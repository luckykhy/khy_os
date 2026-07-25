'use strict';

/**
 * atPicker.js — 内联 `@` 文件选择器的纯列举内核（从 repl.js startRepl 闭包抽出）。
 *
 * listAtEntries(dir, filter) 列出某目录下可选的文件/子目录条目，按「目录在前、名称
 * 升序」排序，并按 filter 子串过滤。仅 fs.readdirSync 一处只读副作用，无任何渲染/
 * readline/闭包状态依赖，因此可独立单测。
 *
 * 修复（伴随抽取）：原 repl.js:1011 引用 `_DIR_SKIP`，但该名既未在 repl.js 定义也未导入
 * （仅存在于 repl/toolOutputRender），故 `@` 选择器一旦触发即抛 ReferenceError。改为
 * 从 dirSkip 单一真源取 DIR_SKIP，bug 随抽取一并修复。
 *
 * 性能拆分(流畅性 keystroke 路径)：`@` 后每按键都调 listAtEntries → readdirSync + 全量
 * skip-filter + localeCompare 排序 + map。但同一目录内**连续键入 filter** 时,目录列举、
 * skip-filter、排序、dir/file 映射都**不变**,只有子串 filter 逐键收窄。故把内核拆成两段:
 *   - buildAtProjection(dir, readdirFn):readdir + skip-filter + 排序 + map(**昂贵的不变部分**);
 *   - applyAtFilter(projection, filter):对已排好的投影做**廉价子串收窄**(每键现算)。
 * listAtEntries 保持二者的逐字节合成(默认 readdirFn=fs.readdirSync),既有测试不变;有状态的
 * 调用方(经典 REPL)可另经 atProjectionCache 按 (dir, TTL) 记忆 buildAtProjection,去掉每键 IO+排序。
 */

const fs = require('fs');
const { DIR_SKIP } = require('./dirSkip');

const _defaultReaddir = (dir) => fs.readdirSync(dir, { withFileTypes: true });

/**
 * 构建某目录的「已排序、已 skip-filter、已映射」的基础投影(不含子串 filter)。
 * 这是每键调用中真正昂贵且随 filter **不变**的部分。
 * @param {string} dir 目标目录
 * @param {(dir:string)=>Array} [readdirFn] 注入的读目录函数(默认 fs.readdirSync withFileTypes)
 * @returns {Array<{name:string,display:string,isDir:boolean,_lower:string}>} 排序后的基础投影;读失败 → []
 */
function buildAtProjection(dir, readdirFn = _defaultReaddir) {
  let entries;
  try { entries = readdirFn(dir); } catch { return []; }

  const filtered = entries
    .filter(e => !DIR_SKIP.has(e.name))
    // 隐藏文件默认跳过，但保留 .env.example / .claude 两个常被引用的入口
    .filter(e => !e.name.startsWith('.') || e.name === '.env.example' || e.name === '.claude')
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return filtered.map(e => {
    const isDir = e.isDirectory();
    return {
      name: e.name,
      display: isDir ? `${e.name}/` : e.name,
      isDir,
      // 预算好的小写名,供每键子串过滤复用(避免每键对每条 toLowerCase)。
      _lower: e.name.toLowerCase(),
    };
  });
}

/**
 * 对基础投影做大小写不敏感子串过滤,并剥掉内部 `_lower` 字段(输出与历史逐字节一致)。
 * @param {Array<{name,display,isDir,_lower}>} projection buildAtProjection 的结果
 * @param {string} [filter] 名称子串(大小写不敏感)
 * @returns {Array<{name:string,display:string,isDir:boolean}>}
 */
function applyAtFilter(projection, filter) {
  const proj = Array.isArray(projection) ? projection : [];
  const f = filter ? String(filter).toLowerCase() : '';
  const out = [];
  for (let i = 0; i < proj.length; i++) {
    const e = proj[i];
    if (!f || (e._lower !== undefined ? e._lower : String(e.name).toLowerCase()).includes(f)) {
      out.push({ name: e.name, display: e.display, isDir: e.isDir });
    }
  }
  return out;
}

/**
 * @param {string} dir 目标目录
 * @param {string} [filter] 名称子串过滤（大小写不敏感）
 * @param {{ readdirFn?:Function, projection?:Array }} [opts]
 *   - projection:调用方已(经缓存)算好的基础投影 → 跳过 readdir+排序,只做子串过滤;
 *   - readdirFn:注入读目录函数(默认 fs.readdirSync withFileTypes)。
 * @returns {Array<{name:string,display:string,isDir:boolean}>} 排序后的条目；目录读失败时空数组
 */
function listAtEntries(dir, filter, opts = {}) {
  const o = opts || {};
  const projection = Array.isArray(o.projection)
    ? o.projection
    : buildAtProjection(dir, o.readdirFn || _defaultReaddir);
  return applyAtFilter(projection, filter);
}

module.exports = { listAtEntries, buildAtProjection, applyAtFilter, _defaultReaddir };
