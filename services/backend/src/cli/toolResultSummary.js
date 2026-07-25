'use strict';

/**
 * summarizeToolResult — single source of truth for the one-line, human-facing
 * SUCCESS summary of a tool result ("已读取 N 行" / "找到 N 个匹配" / "已在后台运行"…).
 *
 * Historically this lived only as a closure (`_formatToolResult`) inside
 * repl.js, so the classic REPL produced rich per-tool summaries while the ink
 * TUI showed a flat "✓ 完成" — backend data the UI silently dropped (the same
 * class of bug as the stripped `_khyWriteDiff`). Extracting it here lets BOTH
 * the REPL and the TUI bridge derive the summary from one implementation.
 *
 * Pure and dependency-light: reads only the result object + the tool params.
 * Reads `result.output || result.content || result.text` so it works whether it
 * is handed the raw tool result (REPL, which has output/content) or a
 * view-projected result (TUI, which collapses output/content into `text`).
 */

const path = require('path');

// Noisy/internal keys skipped when building a compact k=v result summary.
// Hoisted to a module constant so _readableObjectSummary() reuses one Set per
// tool-result render instead of allocating a fresh one each call. Consumed
// read-only (`.has`); never mutated, never escapes.
const _READABLE_SUMMARY_SKIP_KEYS = new Set([
  'success', 'ok', 'isError', 'is_error', 'output', 'content', 'text',
]);

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const normalizeToolName = require('../utils/normalizeToolName');

// CC 后端口径对齐:工具结果摘要里的文件路径显示走 CC 的 getDisplayPath 算法
// (CC src/utils/file.ts:155)——而不是旧 Khy 一律 `path.basename`(只剩文件名)。
// CC getDisplayPath 的三档(本函数逐档忠实移植):
//   1. 文件在 cwd 内 → **cwd 相对路径**(`relative(cwd, abs)` 且不以 `..` 开头) → "src/cli/foo.js"
//   2. 文件在 home 内 → **~ 记法** → "~/notes/x.txt"
//   3. 否则 → **绝对路径**(树外文件如实给全路径,不截成裸文件名)
// 旧的裸 basename 丢了目录上下文:两个不同目录里的同名文件("a/config.js" 与 "b/config.js")
// 摘要都塌成 "config.js" 无法区分;CC 显示相对路径正是为消歧。本刀对齐这个后端逻辑。
//   门控 KHY_DISPLAY_PATH_CC(默认开):走 getDisplayPath 三档;关 / 计算异常 → 逐字节
//   回退旧 `path.basename`。cwd/home 可注入(供确定性单测),默认取 process.cwd()/os.homedir()。
// 纯函数、绝不抛(任何异常都退回 basename,摘要永不因路径计算崩)。
function _displayPath(p, env = process.env, cwdOverride, homeOverride) {
  const raw = String(p == null ? '' : p);
  if (!raw) return '';
  const v = String((env && env.KHY_DISPLAY_PATH_CC) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return path.basename(raw);
  try {
    const cwd = cwdOverride != null ? cwdOverride : process.cwd();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    const rel = path.relative(cwd, abs);
    // ① cwd 内:相对路径(不以 .. 开头、非绝对)。CC: `relativePath && !startsWith('..')`。
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    // ② home 内:~ 记法。CC: `filePath.startsWith(homeDir + sep)`。
    let home = homeOverride;
    if (home == null) { try { home = require('os').homedir(); } catch { home = ''; } }
    if (home && (abs === home || abs.startsWith(home + path.sep))) {
      return '~' + abs.slice(home.length);
    }
    // ③ 否则绝对路径。
    return abs;
  } catch {
    return path.basename(raw); // 绝不抛 → 退裸文件名
  }
}

// CC 后端口径对齐:文件编辑摘要里的 ±行数 = 对 old_string/new_string 做**真实行级 diff**
// 后实际新增/删除的行数。CC 的 FileEditToolUpdatedMessage(src/components/FileEditToolUpdatedMessage.tsx:29)
// 是数结构化补丁里以 `+`/`-` 开头的行;Khy 复用已有的 LCS 版 computeStructuredDiffHunks 的
// realAdded/realRemoved——比旧的「净行差」启发式更准:能把「3 行换成 3 行」如实显示成
// `+3/-3`(旧逻辑会塌成 `~3`,丢失了「既删又增」的真相),也能在混合编辑里同时给出 `+a/-b`。
//   门控 KHY_EDIT_DIFF_STAT_CC(默认开):走真实 diff;关 → 逐字节回退旧净差(+net/-net/~same)。
//   diff 计算包在 try 里,任何异常静默回退净差,绝不让摘要抛错。
function _editDiffStat(oldStr, newStr, env = process.env) {
  const v = String((env && env.KHY_EDIT_DIFF_STAT_CC) || '').trim().toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (ccMode) {
    try {
      const { computeStructuredDiffHunks } = require('./diffRenderer');
      const d = computeStructuredDiffHunks(String(oldStr || ''), String(newStr || ''));
      const added = Number(d && d.added) || 0;
      const removed = Number(d && d.removed) || 0;
      const parts = [];
      if (added > 0) parts.push(`+${added}`);
      if (removed > 0) parts.push(`-${removed}`);
      return parts.length ? `（${parts.join('/')}）` : '';
    } catch { /* fall through to the legacy net heuristic below */ }
  }
  // legacy 字节回退:净行差启发式(本刀之前口径)。
  const oldLines = oldStr ? String(oldStr).split('\n').length : 0;
  const newLines = newStr ? String(newStr).split('\n').length : 0;
  const parts = [];
  if (newLines > oldLines) parts.push(`+${newLines - oldLines}`);
  if (oldLines > newLines) parts.push(`-${oldLines - newLines}`);
  if (newLines === oldLines && oldLines > 0) parts.push(`~${oldLines}`);
  return parts.length > 0 ? `（${parts.join('/')}）` : '';
}

// Render a structured (non-string-output) tool result as a short, HUMAN-READABLE
// line — never raw JSON braces. Single source of truth for "object → readable
// one-liner" so both the CLI/TUI summary and the web stream summarizer agree.
//   1. concrete command (the most truthful, readable handle)
//   2. message-like field (message/summary/nextAction/reason)
//   3. compact `k=v` of top-level scalar fields (clipped)
//   4. '' (caller falls back to '完成')
function _readableObjectSummary(result) {
  if (!result || typeof result !== 'object') return '';
  const data = (result.data && typeof result.data === 'object') ? result.data : null;
  const clip = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 60);

  const cmd = result.command || (data && data.command);
  if (cmd) return `$ ${clip(cmd)}`;

  const msg = result.message || result.summary || result.reason
    || (data && (data.nextAction || data.message || data.summary));
  if (msg) return clip(msg);

  // Compact readable k=v from top-level scalar fields. Skip noisy/internal keys
  // and never serialize nested objects/arrays (that is what produced braces).
  const SKIP = _READABLE_SUMMARY_SKIP_KEYS;
  const source = data || result;
  const parts = [];
  for (const k of Object.keys(source)) {
    if (k.startsWith('_') || SKIP.has(k)) continue;
    const v = source[k];
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      parts.push(`${k}=${clip(v)}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join('，');
}

// CC 后端口径对齐:Grep 的结果摘要按 output_mode 分档,镜像 CC GrepTool/UI.tsx 的
// `SearchResultSummary`/`renderToolResultMessage`——CC 按 mode 用不同的计数与名词:
//   content            → numLines                         → "Found N lines"
//   count              → numMatches(+ numFiles secondary) → "Found N matches across M files"
//   files_with_matches → numFiles                         → "Found N files"
// Khy 的 GrepTool 结果天然按 mode 形状不同:content={matches[],count}、
// count={counts[],total}、files_with_matches={files[],count}——刚好携带 CC 需要的三种
// 计数。旧摘要无视 mode 一律「找到 N 个匹配」:对 files_with_matches 把文件数误称匹配数,
// 对 count(结果只有 counts/total、无 count/matches)更直接塌成「找到 0 条结果」(真 bug)。
//   门控 KHY_GREP_MODE_SUMMARY(默认开):按 mode 出对应摘要;关 → 返 null 让调用方逐字节
//   回退旧「找到 N 个匹配 / N 条结果」。判 mode 优先用**工具入参** output_mode(权威、不会被
//   TUI 视图投影裁掉),缺失时按结果形状推断(counts+total → count·files → files·**非空**
//   matches → content),再退 GrepTool 的默认 files_with_matches(空结果 sentinel
//   {matches:[],count:0} 形状不可分时按真实默认档处理)。纯函数、绝不抛。
function _grepModeSummary(result, params, env = process.env) {
  const v = String((env && env.KHY_GREP_MODE_SUMMARY) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
  if (!result || typeof result !== 'object') return null;

  let mode = params && params.output_mode;
  if (mode !== 'content' && mode !== 'count' && mode !== 'files_with_matches') {
    if (Array.isArray(result.counts) && typeof result.total === 'number') mode = 'count';
    else if (Array.isArray(result.files)) mode = 'files_with_matches';
    else if (Array.isArray(result.matches) && result.matches.length > 0) mode = 'content';
    else mode = 'files_with_matches'; // GrepTool 默认(含空结果 sentinel)
  }

  if (mode === 'count') {
    const numMatches = typeof result.total === 'number'
      ? result.total
      : (Array.isArray(result.counts) ? result.counts.reduce((s, c) => s + (Number(c && c.count) || 0), 0) : 0);
    const numFiles = Array.isArray(result.counts)
      ? result.counts.length
      : (typeof result.count === 'number' ? result.count : 0);
    return `找到 ${numMatches} 个匹配，跨 ${numFiles} 个文件`;
  }
  if (mode === 'content') {
    const numLines = Array.isArray(result.matches)
      ? result.matches.length
      : (typeof result.count === 'number' ? result.count : 0);
    return `找到 ${numLines} 行`;
  }
  // files_with_matches
  const numFiles = Array.isArray(result.files)
    ? result.files.length
    : (typeof result.count === 'number' ? result.count : 0);
  return `找到 ${numFiles} 个文件`;
}

// CC 后端口径对齐:Read 的结果摘要按**内容类型**分档,镜像 CC FileReadTool/UI.tsx 的
// `renderToolResultMessage(output)`——CC 按 output.type 用完全不同的话术:
//   image          → "Read image (SIZE)"      (formatFileSize,不数行)
//   pdf            → "Read PDF (SIZE)"
//   parts          → "Read N pages (SIZE)"
//   notebook       → "Read N cells"
//   text           → "Read N lines"
//   file_unchanged → "Unchanged since last read"
// Khy 的 FileReadTool 实际只产出两类:text(含 OCR 兜底、空文件)与 **image**
//(`{type:'image', size, file, ...}`,无 content/lines)。旧摘要对**所有** read 一律
// 数 outStr 的换行 → 图片结果 output/content/text 全缺、`''.split('\n').length===1`
// → 把图片误报成「已读取 a.png(1 行)」(真 bug:图片没有「行」)。CC 对图片报的是
// **大小**而非行数。
//   门控 KHY_READ_TYPE_SUMMARY(默认开):image → 「已读取图片(SIZE)」(SIZE 走
//   ccFormatFileSize SSOT,与 CC formatFileSize 同源);关 / 非 image 类型 → 返 null
//   让调用方逐字节回退旧「已读取 N 行」。只对齐 Khy 真实产出的类型(image),绝不编造
//   Khy 不产出的 pdf/notebook/parts 档。纯函数、绝不抛。
function _readTypeSummary(result, params, env = process.env) {
  const v = String((env && env.KHY_READ_TYPE_SUMMARY) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
  if (!result || typeof result !== 'object') return null;
  if (result.type !== 'image') return null; // Khy 只有 image 是真正的非文本读

  const base = result.file || result.path || (params && params.file_path) || '';
  const bn = base ? _displayPath(base) : '';
  let sizeStr = '';
  if (typeof result.size === 'number' && Number.isFinite(result.size)) {
    try {
      const { ccFormatFileSize } = require('./ccFormat');
      sizeStr = ccFormatFileSize(result.size) || '';
    } catch { sizeStr = ''; }
  }
  if (bn && sizeStr) return `已读取图片 ${bn}（${sizeStr}）`;
  if (bn) return `已读取图片 ${bn}`;
  if (sizeStr) return `已读取图片（${sizeStr}）`;
  return '已读取图片';
}

// CC 后端口径对齐:文本读取命中行上限(或字节超限)时,行数后加 `+` 标记表示「实际不止这些行」。
// CC `src/components/messages/AttachmentMessage.tsx` 渲染 `${numLines}${truncated ? '+' : ''} lines`
// → `Read foo.js (2000+ lines)`。Khy `FileReadTool/index.js` 已返回判定所需的两项数据:
//   `lines`=本次实读行数(切片后)、`totalLines`=文件全量行数、`truncated`=字节超限标记。
// 旧摘要只显 `已读取 foo.js（2000 行）`,与未截断的 2000 行文件完全同形 → 隐藏了被丢弃的行。
// 本刀据既有数据派生截断标记,与 CC `${numLines}${truncated ? '+' : ''}` 逐字对齐(无新数据字段、
// 无新 call-site)。中文无复数塌缩,仅在行数后追加纯 ASCII `+`。
//   门控 KHY_READ_TRUNCATE_MARKER(默认开):命中截断 → `+`;关 → 逐字节回退无 `+`。
// 纯函数、绝不抛。仅当 `totalLines > lineCount`(命中行上限)或 `truncated === true`(字节超限)时返 '+'。
function _readTruncatedMarker(result, lineCount, env = process.env) {
  const v = String((env && env.KHY_READ_TRUNCATE_MARKER) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return '';
  if (!result || typeof result !== 'object') return '';
  const total = result.totalLines;
  const moreByLines =
    typeof total === 'number' && Number.isFinite(total) &&
    typeof lineCount === 'number' && Number.isFinite(lineCount) &&
    total > lineCount;
  return (moreByLines || result.truncated === true) ? '+' : '';
}

// CC 后端口径对齐:写文件摘要里的「行数」用 CC 的 countLines 算法——
// CC FileWriteTool/UI.tsx:36 `countLines(content)` 把**末尾换行当成行终止符**(不是新空行):
//   const parts = content.split('\n'); return content.endsWith('\n') ? parts.length - 1 : parts.length;
// 而且**永远按 `\n` 切**(刻意不用 os.EOL,否则 Windows `\r\n` 会把所有文件算成 1 行,见 CC 注释)。
// 旧 Khy 写摘要用裸 `contentStr.split('\n').length`——对任何以换行结尾的内容(绝大多数文件的常态)
// **多算 1 行**(把末尾换行当成一个空行)。本刀对齐 CC 的行计数算法。
//   门控 KHY_WRITE_COUNT_LINES_CC(默认开):末尾换行当终止符;关 → 逐字节回退旧 `split('\n').length`。
// 算法现已提升为单一真源 `cli/ccCountLines`(pre-exec toolDisplay._estimateLines 与本处 post-exec
// 摘要共同委派、同门控),此处只保留 Khy 的「空内容 → 0 行(省略行数段)」产品守卫。
// 纯函数、绝不抛。空串由调用方 `contentStr ?` 守卫短路成 0(保留 Khy「空内容省略行数段」的既有产品行为)。
function _writeLineCount(content, env = process.env) {
  const s = String(content == null ? '' : content);
  if (s === '') return 0;
  try {
    return require('./ccCountLines').countLinesOr(s, env);
  } catch {
    return s.split('\n').length; // legacy 字节回退
  }
}

// CC 后端口径对齐:写文件摘要里的「字节大小」humanize——CC 全程用 formatFileSize(bytes)
// (FileWriteTool/UI.tsx 等)把字节数转成 "30 bytes"/"5KB"/"1.5MB" 给人看。Khy 早把这套
// 算法移植成 ccFormatFileSize SSOT,且 image-read(:206)、webfetch(:267)两处摘要都已走它;
// **唯独写摘要(:360-361)仍直接打印裸 `${result.bytes}B`**——大文件 51200B 这种完全不可读,
// 还和同模块另两处不一致。本刀把这最后一支孤儿收敛进 ccFormatFileSize SSOT(平行于 image/webfetch)。
//   门控 KHY_WRITE_SIZE_CCFORMAT(默认开):字节 → ccFormatFileSize humanize;
//   关 → 逐字节回退旧 `${bytes}B`。require 失败/空返回时同样回退,绝不抛、绝不丢大小。
function _writeSizeDisplay(bytes, env = process.env) {
  const v = String((env && env.KHY_WRITE_SIZE_CCFORMAT) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return `${bytes}B`;
  try {
    const { ccFormatFileSize } = require('./ccFormat');
    return ccFormatFileSize(bytes) || `${bytes}B`;
  } catch { return `${bytes}B`; }
}

// CC 后端口径对齐:Web 工具结果摘要按工具种类分档——CC 每个工具有独立 renderToolResultMessage:
//   WebFetchTool/UI.tsx:36 → "Received {formatFileSize(bytes)} ({code} {codeText})"(bytes=
//     "Size of the fetched content in bytes"=Buffer.byteLength(content));
//   WebSearchTool/UI.tsx → "Found N results"(N=结果块数)。
// 旧 Khy 把 websearch/webfetch 揉成一个分支:webfetch 的成功结果只有 content/contentLength、
// **没有 results/count/status** → 一路落空到末尾 `return '网络搜索完成'`——**把"抓取网页"误报成
// "网络搜索"(真 bug),且把已有的内容大小丢弃**。本刀把 webfetch 分出来,出"已获取网页(大小)",
// 大小=抓取内容的真实字节数(CC 同口径 Buffer.byteLength,走 ccFormatFileSize SSOT)。
//   门控 KHY_WEB_RESULT_SUMMARY(默认开):webfetch → 大小摘要;关 / 非 webfetch → 返 null 让
//   调用方逐字节回退旧分支(websearch 的"搜索到 N 条"本就对齐 CC 的 Found N results,不动)。
// Khy 成功结果不带 HTTP 状态码(statusCode 只用于内部重定向/错误判定),故诚实只显大小不编造 (code)。
function _webFetchContentBytes(result) {
  // CC 口径:抓取内容的字节大小。优先对真实交付内容算 Buffer.byteLength(精确字节,UTF-8),
  // 内容字段缺失时退回 contentLength(字符数近似)。纯函数、绝不抛。
  const content = (result && typeof result.content === 'string') ? result.content : '';
  if (content) {
    try { return Buffer.byteLength(content, 'utf8'); } catch { /* fall through */ }
  }
  if (result && typeof result.contentLength === 'number' && Number.isFinite(result.contentLength)) {
    return result.contentLength;
  }
  return null;
}

function _webResultSummary(name, result, env = process.env) {
  const v = String((env && env.KHY_WEB_RESULT_SUMMARY) || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
  if (!result || typeof result !== 'object') return null;
  if (name !== 'webfetch') return null; // websearch keeps its already-CC-aligned count summary
  const bytes = _webFetchContentBytes(result);
  let sizeStr = '';
  if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) {
    try {
      const { ccFormatFileSize } = require('./ccFormat');
      sizeStr = ccFormatFileSize(bytes) || '';
    } catch { sizeStr = ''; }
  }
  return sizeStr ? `已获取网页（${sizeStr}）` : '已获取网页';
}

function summarizeToolResult(toolName, result, params) {
  if (!result) return '完成';
  const name = normalizeToolName(toolName);
  // output/content for the REPL's raw result; text for the TUI's projected one.
  const out = result.output || result.content || result.text || '';
  const outStr = typeof out === 'string' ? out : JSON.stringify(out);

  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    // Gate ON (default): content-type-aware summary (image → size, not line count).
    const typeSummary = _readTypeSummary(result, params);
    if (typeSummary !== null) return typeSummary;
    // Gate OFF / text reads: byte-identical legacy line-count summary.
    const lineCount = typeof result.lines === 'number' ? result.lines : outStr.split('\n').length;
    const mark = _readTruncatedMarker(result, lineCount);
    const base = (result.path || (params && params.file_path) || '');
    const bn = base ? _displayPath(base) : '';
    return bn ? `已读取 ${bn}（${lineCount}${mark} 行）` : `已读取 ${lineCount}${mark} 行`;
  }
  if (name === 'websearch' || name === 'webfetch') {
    // Gate ON (default): webfetch → 已获取网页(大小), distinct from a search.
    const webSummary = _webResultSummary(name, result);
    if (webSummary !== null) return webSummary;
    // Gate OFF / websearch: byte-identical legacy "搜索到 N 条网页结果".
    if (Array.isArray(result.results)) return `搜索到 ${result.results.length} 条网页结果`;
    if (result.data && Array.isArray(result.data.results)) return `搜索到 ${result.data.results.length} 条网页结果`;
    if (typeof result.count === 'number') return `搜索到 ${result.count} 条网页结果`;
    if (typeof result.status === 'number') return `已获取网页（HTTP ${result.status}）`;
    return '网络搜索完成';
  }
  if (name === 'ls') {
    if (typeof result.count === 'number') return `列出 ${result.count} 个条目`;
    if (Array.isArray(result.entries)) return `列出 ${result.entries.length} 个条目`;
    return '已列出目录内容';
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    if (result._background) return '已在后台运行（↓ 管理）';
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
    const exitTag = (exitCode !== null && exitCode !== 0) ? ` [退出码 ${exitCode}]` : '';
    // Prefer showing the concrete command the user ran over a possibly-empty
    // output dump — "人难以阅读的 {braces}" came from output-less results. The
    // command itself is the most readable, truthful one-liner.
    const cmd = (params && (params.command || params.cmd)) || '';
    const trimmedOut = outStr.trim();
    if (!trimmedOut && cmd) return `$ ${String(cmd).replace(/\s+/g, ' ').slice(0, 76)}${exitTag}`;
    const lines = trimmedOut.split('\n');
    if (lines.length <= 2) return (lines.join(' ').slice(0, 80) || (cmd ? `$ ${String(cmd).slice(0, 76)}` : '命令完成')) + exitTag;
    return `命令输出 ${lines.length} 行${exitTag}`;
  }
  // build_project / ProjectBlueprint build path: the real result lives under
  // `result.data` (command/exitCode/errorCount), so the generic JSON fallback
  // used to dump raw {braces}. Show the concrete build command + diagnostics.
  if (name === 'buildproject' || name === 'build' || name === 'projectblueprint') {
    const d = (result.data && typeof result.data === 'object') ? result.data : result;
    const cmd = d.command ? String(d.command).replace(/\s+/g, ' ').slice(0, 76) : '';
    const exitCode = typeof d.exitCode === 'number' ? d.exitCode : null;
    const exitTag = (exitCode !== null && exitCode !== 0) ? ` [退出码 ${exitCode}]` : '';
    const ec = typeof d.errorCount === 'number' ? d.errorCount
      : (Array.isArray(d.errors) ? d.errors.length : null);
    const wc = typeof d.warningCount === 'number' ? d.warningCount
      : (Array.isArray(d.warnings) ? d.warnings.length : null);
    const diagParts = [];
    if (ec) diagParts.push(`${ec} 个错误`);
    if (wc) diagParts.push(`${wc} 个警告`);
    const diag = diagParts.length ? `（${diagParts.join('、')}）` : '';
    if (cmd) return `${result.success === false ? '构建失败' : '已构建'}：${cmd}${diag}${exitTag}`;
    // No command surfaced (e.g. ProjectBlueprint match/scaffold mode) → fall
    // through to the readable structured summary, never raw braces.
  }
  if (name === 'grep' || name === 'search' || name === 'searchcontent') {
    // Gate ON (default): CC-aligned, mode-aware summary (lines/matches/files).
    const modeSummary = _grepModeSummary(result, params);
    if (modeSummary !== null) return modeSummary;
    // Gate OFF: byte-identical legacy "找到 N 个匹配 / N 条结果".
    if (typeof result.count === 'number') return `找到 ${result.count} 个匹配`;
    if (Array.isArray(result.matches)) return `找到 ${result.matches.length} 个匹配`;
    const matches = outStr.split('\n').filter(Boolean).length;
    return `找到 ${matches} 条结果`;
  }
  if (name === 'glob' || name === 'find' || name === 'findfiles') {
    if (typeof result.count === 'number') return `找到 ${result.count} 个文件`;
    if (Array.isArray(result.files)) return `找到 ${result.files.length} 个文件`;
    const files = outStr.split('\n').filter(Boolean).length;
    return `找到 ${files} 个文件`;
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile') {
    const bn = result.path ? _displayPath(result.path) : '';
    const contentStr = (params && params.content) || '';
    const lineCount = contentStr ? _writeLineCount(contentStr) : 0;
    if (typeof result.bytes === 'number' && bn) {
      const sizeStr = _writeSizeDisplay(result.bytes);
      return lineCount > 0 ? `已写入 ${bn}（${lineCount} 行，${sizeStr}）` : `已写入 ${bn}（${sizeStr}）`;
    }
    if (bn) return lineCount > 0 ? `已写入 ${bn}（${lineCount} 行）` : `已写入 ${bn}`;
    return lineCount > 0 ? `已写入 ${lineCount} 行` : '文件写入完成';
  }
  if (name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    const bn = result.file ? _displayPath(result.file) : '';
    const diffStr = _editDiffStat((params && params.old_string) || '', (params && params.new_string) || '');
    const fuzzyNote = result.fuzzyMatch ? ` [模糊匹配 ${result.similarity || '?'}%]` : '';
    const repCount = typeof result.replacements === 'number' ? result.replacements : (typeof result.editsApplied === 'number' ? result.editsApplied : 1);
    return bn
      ? `已修改 ${bn}，${repCount} 处替换${diffStr}${fuzzyNote}`
      : `已替换 ${repCount} 处${diffStr}${fuzzyNote}`;
  }
  if (name === 'todowrite') {
    if (typeof result.count === 'number') return `已更新 ${result.count} 条待办`;
    return '待办列表已更新';
  }
  if (name === 'agent' || name === 'task') {
    if (result.message) return String(result.message).slice(0, 90);
    return '子任务已完成';
  }

  // Generic. The raw output may be a plain string (show a brief) OR a structured
  // object with no string `output/content/text` (build results, blueprints,
  // domain tools). The latter used to be JSON.stringify'd into unreadable
  // `{"k":"v",...}` braces shown straight to the user. Never emit raw braces:
  // prefer a concrete command, then a message-like field, then a readable k=v
  // rendering of top-level scalars, finally just "完成".
  let brief;
  if (typeof out === 'string') {
    brief = out.replace(/\n/g, ' ').slice(0, 60);
    // Empty string output but a structured result → derive a readable line from
    // the result's fields (command / message / k=v), never raw braces.
    if (!brief) brief = _readableObjectSummary(result);
  } else {
    brief = _readableObjectSummary(out) || _readableObjectSummary(result);
  }
  const base = brief || '完成';
  // Append truncation warning if tool output was truncated.
  if (result.truncated || result._truncated) {
    const truncLen = result.truncatedChars || result._truncatedChars || 0;
    return truncLen > 0 ? `${base} [已截断 ${truncLen} 字符]` : `${base} [输出已截断]`;
  }
  return base;
}

module.exports = { summarizeToolResult, normalizeToolName, _readableObjectSummary, _displayPath };
