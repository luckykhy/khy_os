'use strict';

/**
 * docPathIndex.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 文档新鲜度系统 Layer 1(过时提醒)的派生核心。
 *
 * 背景(真缺口):代码常更新,文档不能及时跟上。诉求 = 改了源码后,提示「哪些文档可能过时,
 * 请复核」。本仓 docs/ 下多数文档已在**正文用一致约定引用源码路径**(反引号包裹
 * `services/backend/src/...`/`scripts/...`/`kernel/...`,常在「真源:」「实现:」「真源脚本:」后)。
 * 故 source→doc 映射**不手写**,而是**解析正文既有约定派生**(generatedBy:'prose-scan'),零新维护面。
 *
 * 本叶子只做纯字符串解析与匹配:
 *   - extractSourcePaths(docText) → 从一篇文档正文抽出它引用的仓库相对源码路径。
 *   - buildDocPathIndex(docRecords) → 反向索引 source → [doc]。
 *   - matchStaleSuspects(changedSourceRels, index) → 给定本次变更的源码路径,列出可能过时的文档。
 *
 * IO(读 docs/**、跑 git diff)由薄壳 docsFreshnessRunner.js 完成;本叶子不碰文件系统。
 *
 * 门控 KHY_DOCS_FRESHNESS(默认开;{0,false,off,no} 关)。关 → 整个新鲜度系统跳过,
 * runner 短路(byte-identical 今日行为:无此功能)。叶子本身是纯函数,门控只在 runner 层短路;
 * 这里导出 docsFreshnessEnabled 供 runner/handler 共用同一判定。
 *
 * 诚实边界(刻意):
 *   ① 正文解析必有假阳/假阴 → 定位为**复核提醒**非正确性门禁;两级置信(exact 相等 > prefix 目录前缀)。
 *   ② 每篇文档匹配上限,避免一篇巨型文档引用炸开。
 *   ③ 坏输入 / 空 → 返回空结构(绝不抛)。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_DOCS_FRESHNESS 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function docsFreshnessEnabled(env = process.env) {
  const raw = env && env.KHY_DOCS_FRESHNESS;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

// 视为源码的扩展名(触发它们被改 → 引用它们的文档可能过时)。
const SOURCE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'c', 'h', 'sh', 'json', 'vue', 'mbt',
]);

// 仓库相对路径的合法首段(锚定,避免把随手一句 `foo.js` 当路径)。
const ROOT_SEGMENTS = new Set([
  'services', 'scripts', 'kernel', 'packaging', 'tools', 'extensions',
  'frontend', 'src', 'apps', 'packages', 'bin', 'lib',
]);

const MAX_PATHS_PER_DOC = 200;

// 反引号包裹的候选 token(粗抓,后续再精修)。
const _BACKTICK_RE = /`([^`\r\n]{1,200})`/g;

/**
 * 从一个反引号 token 里剥出「干净的仓库相对源码路径」,不合法返回 null。
 *  - 去掉尾部行号/范围/锚点:`router.js:3230` `foo.js:3-14` `foo.js#main` `foo.js:3230:5`
 *  - 去掉包裹空白与可能的前导 `./`
 *  - 只接受首段在 ROOT_SEGMENTS 且扩展名在 SOURCE_EXTS 的路径
 */
function _cleanSourcePath(token) {
  if (typeof token !== 'string') return null;
  let s = token.trim();
  if (!s) return null;
  // 反引号 token 里可能夹带说明文字(如 `router.js:3230 的 case`)→ 只取第一个空白前。
  s = s.split(/\s/)[0];
  // 剥锚点 #... 与行号 :N / :N-M / :N:C。
  s = s.replace(/#.*$/, '');
  s = s.replace(/:(\d+)(?:[-:]\d+)?$/, '');
  // 去前导 ./ 或 /。
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  // 统一分隔符(容忍 Windows 反斜杠)。
  s = s.replace(/\\/g, '/');
  if (!s || s.includes('..')) return null;
  const parts = s.split('/');
  if (parts.length < 2) return null; // 需至少 dir/file,单个裸文件名不锚定
  if (!ROOT_SEGMENTS.has(parts[0])) return null;
  const ext = (s.split('.').pop() || '').toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return null;
  // 路径段合法性(不含空白/引号)。
  if (/[\s"'`<>|]/.test(s)) return null;
  return s;
}

/**
 * 从一篇文档正文抽出它引用的仓库相对源码路径(去重、上限)。
 * @param {string} docText
 * @returns {string[]}
 */
function extractSourcePaths(docText) {
  const out = new Set();
  try {
    if (typeof docText !== 'string' || !docText) return [];
    let m;
    _BACKTICK_RE.lastIndex = 0;
    while ((m = _BACKTICK_RE.exec(docText)) !== null) {
      const cleaned = _cleanSourcePath(m[1]);
      if (cleaned) {
        out.add(cleaned);
        if (out.size >= MAX_PATHS_PER_DOC) break;
      }
    }
  } catch {
    /* fail-soft */
  }
  return [...out];
}

/**
 * 构造 source → [doc] 反向索引。
 * @param {Array<{id?:string, path?:string, text:string}>} docRecords
 * @returns {{bySource:Map<string,string[]>, docCount:number, sourceCount:number, generatedBy:string}}
 */
function buildDocPathIndex(docRecords) {
  const bySource = new Map();
  let docCount = 0;
  try {
    for (const rec of Array.isArray(docRecords) ? docRecords : []) {
      if (!rec || typeof rec.text !== 'string') continue;
      const docId = rec.path || rec.id || '';
      if (!docId) continue;
      docCount += 1;
      for (const src of extractSourcePaths(rec.text)) {
        const list = bySource.get(src) || [];
        if (!list.includes(docId)) list.push(docId);
        bySource.set(src, list);
      }
    }
  } catch {
    /* fail-soft */
  }
  return { bySource, docCount, sourceCount: bySource.size, generatedBy: 'prose-scan' };
}

/**
 * 归一化一个源码相对路径(供匹配比较)。
 */
function _normRel(rel) {
  return String(rel == null ? '' : rel).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 给定本次变更的源码路径,列出可能过时的文档。
 *  - exact:变更路径与文档引用路径**完全相等** → 高置信。
 *  - prefix:变更路径落在文档引用的**目录**之下(引用是目录 / 引用是同目录兄弟)→ 低置信。
 * @param {string[]} changedSourceRels
 * @param {{bySource:Map<string,string[]>}} index
 * @returns {{suspects:Array<{doc:string,matchedSources:string[],confidence:'exact'|'prefix'}>, unmatchedChanges:string[]}}
 */
function matchStaleSuspects(changedSourceRels, index) {
  const suspects = new Map(); // doc → {matchedSources:Set, confidence}
  const unmatched = [];
  try {
    const bySource = (index && index.bySource) || new Map();
    // 预备:源码路径 → 其所在目录集合(供 prefix 判定)。
    const changed = (Array.isArray(changedSourceRels) ? changedSourceRels : [])
      .map(_normRel)
      .filter(Boolean);

    for (const ch of changed) {
      let hit = false;

      // exact:文档直接引用了这个文件。
      if (bySource.has(ch)) {
        hit = true;
        for (const doc of bySource.get(ch)) {
          _addSuspect(suspects, doc, ch, 'exact');
        }
      }

      // prefix:文档引用了某个**目录**(ROOT_SEGMENTS/... 且无扩展名不会进 bySource,
      //   但引用同目录另一文件时,我们把「同目录」视为低置信关联)。
      const chDir = ch.includes('/') ? ch.slice(0, ch.lastIndexOf('/')) : '';
      if (chDir) {
        for (const [src, docs] of bySource.entries()) {
          if (src === ch) continue; // exact 已处理
          const srcDir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
          if (srcDir && srcDir === chDir) {
            hit = true;
            for (const doc of docs) _addSuspect(suspects, doc, ch, 'prefix');
          }
        }
      }

      if (!hit) unmatched.push(ch);
    }
  } catch {
    /* fail-soft */
  }

  const list = [];
  for (const [doc, info] of suspects.entries()) {
    list.push({
      doc,
      matchedSources: [...info.matchedSources].sort(),
      confidence: info.confidence,
    });
  }
  // 确定性排序:exact 优先,再按文档路径。
  list.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'exact' ? -1 : 1;
    return a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0;
  });
  return { suspects: list, unmatchedChanges: unmatched };
}

function _addSuspect(map, doc, source, confidence) {
  const cur = map.get(doc) || { matchedSources: new Set(), confidence: 'prefix' };
  cur.matchedSources.add(source);
  // exact 一旦出现就升级(exact 覆盖 prefix)。
  if (confidence === 'exact') cur.confidence = 'exact';
  map.set(doc, cur);
}

module.exports = {
  docsFreshnessEnabled,
  extractSourcePaths,
  buildDocPathIndex,
  matchStaleSuspects,
  // 供测试/runner 复用的内部工具(带下划线前缀,非稳定契约)。
  _cleanSourcePath,
  SOURCE_EXTS,
  ROOT_SEGMENTS,
};
