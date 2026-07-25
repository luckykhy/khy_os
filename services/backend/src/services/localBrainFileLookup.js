'use strict';

/**
 * localBrainFileLookup.js — Tier-1 本地文件「查找 + 查看」处理器，从 localBrainService.js
 * 按职责抽出以降巨石（沿用 localBrainCalc.js / localBrainTextOps.js /
 * localBrainSessionContext.js 的抽取-再导出谱系，DESIGN-ARCH-051 lineage）。
 *
 * 单一职责：**只读**的本地文件系统检索——在目录树里按关键词 grep（local_search），
 * 以及查看单个文件的前若干行（file_view）。不写盘、不删改、无网络、无模型，仅依赖
 * Node 内置与可选的 localFormat（软依赖，缺失时降级为纯文本）。
 *
 * localBrainService 在 Tier-1 注册表里以 fileLookup.* 引用这些导出，detect → execute →
 * format 三拍行为与原实现一致；对外导出契约不变。
 */

const fs = require('fs');
const path = require('path');

let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

/** 展开 ~ 家目录前缀（与 localBrainService 的同名工具一致）。 */
function _expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(require('os').homedir(), p.slice(1));
  }
  return p;
}

// ── 6. 本地文件搜索 ─────────────────────────────────────────────────

const _SEARCH_RE = /(?:搜索|查找|找|search|find|grep)\s+["'""']?(.+?)["'""']?\s+(?:在|文件|目录|项目|in|from|under)\s+(.+)/i;
const _SEARCH_RE2 = /(?:在|从)\s*(.+?)\s*(?:中|里|内|下)\s*(?:搜索|查找|找)\s+["'""']?(.+?)["'""']?\s*$/i;

function isSearchIntent(text) {
  return (_SEARCH_RE.test(text) || _SEARCH_RE2.test(text)) && text.length < 200;
}

function detectSearch(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  let keyword, searchDir;
  let m = text.match(_SEARCH_RE);
  if (m) {
    keyword = m[1].trim();
    searchDir = _expandHome(m[2].replace(/[""''`]/g, '').trim());
  } else {
    m = text.match(_SEARCH_RE2);
    if (!m) return null;
    searchDir = _expandHome(m[1].replace(/[""''`]/g, '').trim());
    keyword = m[2].trim();
  }
  return { type: 'local_search', category: '本地搜索', label: keyword, keyword, dir: path.resolve(cwd, searchDir) };
}

function executeSearch(plan) {
  const { keyword, dir } = plan;
  if (!fs.existsSync(dir)) return { type: 'local_search', success: false, error: `目录不存在: ${dir}` };

  const results = [];
  const MAX_FILES = 500;
  const MAX_MATCHES = 30;
  let filesScanned = 0;

  function walk(dirPath, depth) {
    if (depth > 6 || filesScanned > MAX_FILES || results.length >= MAX_MATCHES) return;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (filesScanned > MAX_FILES || results.length >= MAX_MATCHES) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        filesScanned++;
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(keyword)) {
              results.push({ file: path.relative(dir, full), line: i + 1, text: lines[i].trim().slice(0, 120) });
              if (results.length >= MAX_MATCHES) break;
            }
          }
        } catch { /* binary or unreadable */ }
      }
    }
  }

  walk(dir, 0);
  return { type: 'local_search', success: true, keyword, dir, results, filesScanned };
}

function formatSearch(result) {
  if (!result.success) return `搜索失败: ${result.error}`;
  if (result.results.length === 0) return `在 ${result.dir} 中搜索 "${result.keyword}"：无匹配（已扫描 ${result.filesScanned} 文件）`;
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: `搜索 "${result.keyword}"`,
      sections: [{
        heading: `${result.results.length} 处匹配`,
        lines: result.results.map(r => `- ${r.file}:${r.line}  ${r.text}`),
      }],
      meta: [`扫描 ${result.filesScanned} 文件`, '本地搜索'],
    });
  }
  const lines = [`搜索 "${result.keyword}" — ${result.results.length} 处匹配（${result.filesScanned} 文件）：`];
  for (const r of result.results) {
    lines.push(`  ${r.file}:${r.line}  ${r.text}`);
  }
  return lines.join('\n');
}

// ── 7. 文件内容查看 ──────────────────────────────────────────────────

const _VIEW_RE = /(?:看看|查看|显示|打开|读取|cat|show|read|view)\s+(.+)/i;

function isViewIntent(text) {
  if (!_VIEW_RE.test(text)) return false;
  const m = text.match(_VIEW_RE);
  if (!m) return false;
  const target = m[1].replace(/[""''`]/g, '').trim();
  // 必须有文件扩展名或明确的文件/路径标志
  return /\.\w{1,10}$/.test(target) || /[/\\]/.test(target) || /(文件|file|内容|content)/i.test(text);
}

function detectView(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  const m = text.match(_VIEW_RE);
  if (!m) return null;
  let target = m[1].replace(/[""''`的内容文件]/g, '').replace(/(file|content)/gi, '').trim();
  target = _expandHome(target);
  return { type: 'file_view', category: '文件查看', label: path.basename(target), filePath: path.resolve(cwd, target) };
}

function executeView(plan) {
  const { filePath } = plan;
  if (!fs.existsSync(filePath)) return { type: 'file_view', success: false, error: `文件不存在: ${filePath}` };
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return { type: 'file_view', success: false, error: `这是目录，不是文件: ${filePath}` };
  if (stat.size > 512 * 1024) return { type: 'file_view', success: false, error: `文件过大 (${(stat.size / 1024).toFixed(0)} KB)，请使用 Read 工具` };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    return { type: 'file_view', success: true, filePath, lines: lines.length, content: lines.slice(0, 100).map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n'), truncated: lines.length > 100 };
  } catch (e) {
    return { type: 'file_view', success: false, error: e.message };
  }
}

function formatView(result) {
  if (!result.success) return `文件查看失败: ${result.error}`;
  const subtitle = `${result.lines} 行${result.truncated ? ' — 仅显示前 100 行' : ''}`;
  if (_fmt && _fmt.isEnabled()) {
    // 内容含行号，用代码块包裹以保持原样（渲染层不会改写 fenced block）。
    return _fmt.compose({
      title: `${result.filePath}`,
      sections: [{ lines: ['```', ...String(result.content).split('\n'), '```'] }],
      meta: [subtitle, '本地文件查看'],
    });
  }
  const header = `${result.filePath} (${result.lines} 行)${result.truncated ? ' — 仅显示前 100 行' : ''}`;
  return `${header}\n${'─'.repeat(Math.min(60, header.length))}\n${result.content}`;
}

// ── 8. 目录列举（local_list） ─────────────────────────────────────────
//
// Tier A 缺口闭环:无模型 + 无网络时,「看看当前目录有哪些文件」此前只出兜底菜单
// 而不真列目录(search/view 都不覆盖纯列举:_VIEW_RE 的 \s+ 对 CJK 无空格落空,
// 且即便命中也解析成垃圾路径)。本节补一个**只读**目录列举意图,与 file_op(移动/
// 复制/重命名)、regex_extract(需数据类型键)、file_view(需扩展名/路径标志)正交。
//
// 门控 KHY_LOCAL_LIST,默认开;关 → isListIntent 恒 false → 字节回退(无此意图,
// 退回既有兜底菜单)。注册为 cooperative:true 且置于注册表末尾,故仅在无模型(Tier A)
// 时介入,且所有既有 handler 保持优先级 → 零回归。

// 裸命令形式:ls / ll / dir [path]
const _LIST_CMD_RE = /^\s*(?:ls|ll|dir)(?:\s+(.+?))?\s*$/i;
// 自然语言形式(保守匹配,绝不吞掉删除/搜索/查看等其他意图):
//   ①「(目录|文件夹) … (有哪些|有什么|里有|下有|内容|里面|都有|列表)」
//   ②「(列出|列一下|罗列|列) … (目录|文件夹|文件)」
//   ③「列目录」
//   ④ 英文「(list|show) … (files|dir|directory|directories|contents)」
//   ⑤ 计数问法「(目录|文件夹) … (有多少|多少个)」——与列举同一能力(列表输出已含「共 N 项」)
const _LIST_NL_RE = /(?:(?:目录|文件夹)[^。\n]{0,8}(?:有哪些|有什么|里有|下有|内容|里面|都有|列表|有多少|多少个))|(?:(?:列出|列一下|罗列|列)[^。\n]{0,6}(?:目录|文件夹|文件))|列目录|(?:\b(?:list|show)\b[^.\n]{0,20}\b(?:files?|dir|directory|directories|contents?)\b)/i;

/** 门控:KHY_LOCAL_LIST 默认开;显式 0/false/off/no/空串 → 关。 */
function _listEnabled(env) {
  if (!env || env.KHY_LOCAL_LIST == null) return true;
  const v = String(env.KHY_LOCAL_LIST).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '');
}

function isListIntent(text) {
  if (!_listEnabled(process.env)) return false;
  if (typeof text !== 'string' || text.length === 0 || text.length >= 200) return false;
  return _LIST_CMD_RE.test(text) || _LIST_NL_RE.test(text);
}

function detectList(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  let dir = cwd;
  const cmd = text.match(_LIST_CMD_RE);
  if (cmd && cmd[1] && cmd[1].trim()) {
    // 命令形式:裸相对名也是合法目录参数(ls src)。
    dir = path.resolve(cwd, _expandHome(cmd[1].replace(/[""''`]/g, '').trim()));
  } else {
    // NL 形式:仅当出现**显式路径 token**(含分隔符 / \ 或家目录 ~ 或 ./..)才取,
    // 否则默认当前目录——绝不把「当前目录」「这个文件夹」等整句误当路径。
    const pathTok = text.match(/(~\/[\w./\-]*|~|\.{1,2}\/[\w./\-]*|\/[\w./\-]+|[\w.\-]+\/[\w./\-]*)/);
    if (pathTok) dir = path.resolve(cwd, _expandHome(pathTok[1].trim()));
  }
  return { type: 'local_list', category: '目录列举', label: path.basename(dir) || dir, dir };
}

function executeList(plan) {
  const { dir } = plan;
  if (!fs.existsSync(dir)) return { type: 'local_list', success: false, error: `目录不存在: ${dir}` };
  let stat;
  try { stat = fs.statSync(dir); } catch (e) { return { type: 'local_list', success: false, error: e.message }; }
  if (!stat.isDirectory()) return { type: 'local_list', success: false, error: `这不是目录,是文件: ${dir}` };

  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    return { type: 'local_list', success: false, error: e.message };
  }

  const MAX = 200;
  const total = dirents.length;
  // 目录在前,再按名称升序;确定性、无 locale 依赖。
  dirents.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  // 仅对**展示的**文件 statSync 取大小(避免对超大目录全量 stat)。
  const entries = dirents.slice(0, MAX).map((d) => {
    const isDir = d.isDirectory();
    let size = null;
    if (!isDir) {
      try { size = fs.statSync(path.join(dir, d.name)).size; } catch { size = null; }
    }
    return { name: d.name, kind: isDir ? 'dir' : (d.isSymbolicLink() ? 'link' : 'file'), size };
  });

  return { type: 'local_list', success: true, dir, total, entries, truncated: total > MAX };
}

function _fmtListSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatList(result) {
  if (!result.success) return `目录列举失败: ${result.error}`;
  if (result.total === 0) return `目录为空: ${result.dir}`;
  const lineFor = (e) => {
    if (e.kind === 'dir') return `${e.name}/`;
    const s = _fmtListSize(e.size);
    const tag = e.kind === 'link' ? ' @' : '';
    return s ? `${e.name}${tag}  (${s})` : `${e.name}${tag}`;
  };
  const meta = [
    `共 ${result.total} 项${result.truncated ? `,仅显示前 ${result.entries.length}` : ''}`,
    '本地目录列举',
  ];
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: `${result.dir}`,
      sections: [{ lines: result.entries.map((e) => `- ${lineFor(e)}`) }],
      meta,
    });
  }
  const header = `${result.dir} — 共 ${result.total} 项${result.truncated ? `（仅显示前 ${result.entries.length}）` : ''}`;
  return `${header}\n${'─'.repeat(Math.min(60, header.length))}\n${result.entries.map(lineFor).join('\n')}`;
}

module.exports = {
  isSearchIntent,
  detectSearch,
  executeSearch,
  formatSearch,
  isViewIntent,
  detectView,
  executeView,
  formatView,
  isListIntent,
  detectList,
  executeList,
  formatList,
};
