/**
 * Diff Renderer — extracted from aiRenderer.js.
 *
 * Renders unified diffs and structured diffs with Claude Code's exact
 * background colors and optional word-level highlighting.
 */
const { c, THEME } = require('./renderTheme');
// 整宽色条收敛到单一真源 cli/diffFullWidth.js(对齐 CC formatDiff:add/remove 行
// 背景补尾随空格铺到终端右缘;门控 KHY_DIFF_FULL_WIDTH 默认开,关→不补=字节回退)。
// displayWidth 是 CJK 感知的显示宽度 SSOT(cli/formatters.js),用于精确测量已用宽度。
const { diffFullWidthEnabled, diffRowPadCount } = require('./diffFullWidth');
const { displayWidth } = require('./formatters');

const DIFF_CONTEXT_LINES = 3;

// 终端整宽(经典 ANSI 路径直出,无 ink trim,尾随背景空格能存活)。非 TTY → 80。
function _terminalWidth() {
  const cols = process.stdout && process.stdout.columns;
  return Number.isFinite(cols) && cols > 0 ? cols : 80;
}

// 给一行「纯文本(无 ANSI)的已用宽度」补足到整宽的尾随空格串;门控关 → 空串。
// call-site 把返回串接在该行 backgroundColor 跨度内,使色条铺到右缘。
function _padToFull(usedWidth, env) {
  if (!diffFullWidthEnabled(env || process.env)) return '';
  return ' '.repeat(diffRowPadCount(usedWidth, _terminalWidth()));
}

// 经典 ANSI 文件编辑 diff(renderStructuredDiff)是否走「真分 hunk」渲染。
// 门控开(默认)= 复用既有 computeStructuredDiffHunks SSOT(LCS 真编辑脚本 + 按
// 上下文切 hunk + realAdded/realRemoved),与默认 TUI(ToolLines.js)收敛;门控关 =
// 逐字节回退历史单区块渲染(把首末改动间的未改行全当 churn 重绘并虚报 ±计数)。
const _CLASSIC_DIFF_HUNKS_FALSY = new Set(['0', 'false', 'off', 'no']);
function classicDiffHunksEnabled(env = process.env) {
  const flag = String((env && env.KHY_CLASSIC_DIFF_HUNKS) || '').trim().toLowerCase();
  return !_CLASSIC_DIFF_HUNKS_FALSY.has(flag);
}

function splitDiffLines(text) {
  const source = String(text ?? '');
  if (!source) return [];
  const lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function computeStructuredDiffStats(oldContent, newContent) {
  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);

  const commonPrefixLen = (() => {
    let k = 0;
    while (k < oldLines.length && k < newLines.length && oldLines[k] === newLines[k]) k++;
    return k;
  })();

  const commonSuffixLen = (() => {
    let k = 0;
    while (
      k < (oldLines.length - commonPrefixLen)
      && k < (newLines.length - commonPrefixLen)
      && oldLines[oldLines.length - 1 - k] === newLines[newLines.length - 1 - k]
    ) {
      k++;
    }
    return k;
  })();

  const removeStart = commonPrefixLen;
  const removeEnd = oldLines.length - commonSuffixLen;
  const addStart = commonPrefixLen;
  const addEnd = newLines.length - commonSuffixLen;

  return {
    oldLines,
    newLines,
    commonPrefixLen,
    commonSuffixLen,
    removeStart,
    removeEnd,
    addStart,
    addEnd,
    added: Math.max(0, addEnd - addStart),
    removed: Math.max(0, removeEnd - removeStart),
  };
}

/**
 * Compute a MULTI-HUNK structured line diff. Unlike computeStructuredDiffStats
 * (which collapses everything between the common prefix/suffix into ONE block —
 * so a file edited at line 5 and line 500 renders the whole 5..500 span as a
 * single, miscounted change), this runs a real line-level LCS over the changed
 * middle and groups the edits into separate hunks, each carrying up to `context`
 * unchanged lines on either side. Unchanged islands longer than 2*context split
 * the diff into multiple hunks (standard unified-diff coalescing).
 *
 * Pure (no ink/ANSI); returns a model the caller turns into rows. The common
 * prefix/suffix are trimmed cheaply first, so the O(m*n) LCS only runs on the
 * residual changed region. Files whose changed region exceeds `maxScan` lines on
 * either side fall back to a single coalesced hunk (preserving the old behaviour
 * and avoiding an O(n²) blow-up on huge rewrites).
 *
 * @param {string} oldContent
 * @param {string} newContent
 * @param {{ context?: number, maxScan?: number }} [opts]
 * @returns {{
 *   oldLines: string[], newLines: string[], added: number, removed: number,
 *   scanned: boolean,
 *   hunks: Array<{ rows: Array<{kind:'ctx'|'del'|'add', num:number, text:string}>, gapBefore: number }>
 * }}
 */
function computeStructuredDiffHunks(oldContent, newContent, opts = {}) {
  const context = Number.isInteger(opts.context) && opts.context >= 0 ? opts.context : DIFF_CONTEXT_LINES;
  const maxScan = Number.isInteger(opts.maxScan) && opts.maxScan > 0 ? opts.maxScan : 4000;

  const {
    oldLines, newLines, removeStart, removeEnd, addStart, addEnd, added, removed,
  } = computeStructuredDiffStats(oldContent, newContent);

  const empty = { oldLines, newLines, added: 0, removed: 0, scanned: true, hunks: [] };
  if (added === 0 && removed === 0) return empty;

  const oldMid = oldLines.slice(removeStart, removeEnd);
  const newMid = newLines.slice(addStart, addEnd);

  // ── Build the ordered edit script over the changed middle ──
  let ops; // [{ kind:'eq'|'del'|'add', oi?, ni? }] with mid-relative indices
  let scanned = true;
  if (oldMid.length > maxScan || newMid.length > maxScan) {
    // Size guard: skip LCS, emit dels then adds as one block (old behaviour).
    scanned = false;
    ops = [];
    for (let k = 0; k < oldMid.length; k++) ops.push({ kind: 'del', oi: k });
    for (let k = 0; k < newMid.length; k++) ops.push({ kind: 'add', ni: k });
  } else {
    ops = _lineDiffOps(oldMid, newMid);
  }

  // Real change counts come from the edit script, NOT computeStructuredDiffStats,
  // whose prefix/suffix collapse over-counts every line between the first and
  // last change as both removed and added (the very bug multi-hunk fixes).
  let realAdded = 0, realRemoved = 0;
  for (const op of ops) {
    if (op.kind === 'add') realAdded++;
    else if (op.kind === 'del') realRemoved++;
  }

  // ── Augment with up to `context` unchanged lines from the common prefix/suffix
  // so hunk boundaries are handled uniformly as eq rows. Prefix/suffix lines are
  // identical in both files, so the old index k maps to a known new index. ──
  const flat = [];
  const preFrom = Math.max(0, removeStart - context);
  for (let k = preFrom; k < removeStart; k++) {
    flat.push({ kind: 'ctx', num: k + 1, text: oldLines[k] });
  }
  for (const op of ops) {
    if (op.kind === 'eq') flat.push({ kind: 'ctx', num: removeStart + op.oi + 1, text: oldLines[removeStart + op.oi] });
    else if (op.kind === 'del') flat.push({ kind: 'del', num: removeStart + op.oi + 1, text: oldLines[removeStart + op.oi] });
    else flat.push({ kind: 'add', num: addStart + op.ni + 1, text: newLines[addStart + op.ni] });
  }
  const sufTo = Math.min(oldLines.length, removeEnd + context);
  for (let k = removeEnd; k < sufTo; k++) {
    flat.push({ kind: 'ctx', num: k + 1, text: oldLines[k] });
  }

  // ── Split into hunks at interior unchanged runs longer than 2*context. A
  // leading run keeps only its last `context`; a trailing run only its first
  // `context`; a long interior run is cut, leaving `context` on each side and a
  // gap between two hunks. Short interior runs (≤ 2*context) are kept whole. ──
  const hunks = [];
  let cur = [];
  let pendingGapTo = -1; // old line number the next hunk resumes at (for gapBefore)
  let i = 0;
  while (i < flat.length) {
    if (flat[i].kind !== 'ctx') { cur.push(flat[i]); i++; continue; }
    let j = i;
    while (j < flat.length && flat[j].kind === 'ctx') j++;
    const runLen = j - i;
    const leading = cur.length === 0;
    const trailing = j === flat.length;
    if (leading) {
      cur.push(...flat.slice(Math.max(i, j - context), j));
    } else if (trailing) {
      cur.push(...flat.slice(i, Math.min(j, i + context)));
    } else if (runLen > 2 * context) {
      cur.push(...flat.slice(i, i + context));
      const lastNum = cur[cur.length - 1].num;
      hunks.push({ rows: cur, gapBefore: pendingGapTo });
      const head = flat.slice(j - context, j);
      pendingGapTo = head.length ? head[0].num - lastNum - 1 : 0;
      cur = [...head];
    } else {
      cur.push(...flat.slice(i, j));
    }
    i = j;
  }
  if (cur.length) hunks.push({ rows: cur, gapBefore: pendingGapTo });
  // The first hunk never has a preceding gap.
  if (hunks.length) hunks[0].gapBefore = -1;

  return { oldLines, newLines, added: realAdded, removed: realRemoved, scanned, hunks };
}

/**
 * Line-level LCS producing an ordered edit script. Mirrors wordDiff's token LCS
 * but over whole lines and emitting eq/del/add ops in document order. Ties in
 * the backtrack prefer the ADD move (`>` not `>=`) so a changed block renders as
 * removals-then-additions — the unified-diff convention the row renderer and the
 * existing single-hunk tests expect.
 * @returns {Array<{kind:'eq'|'del'|'add', oi?:number, ni?:number}>}
 */
function _lineDiffOps(oldMid, newMid) {
  const m = oldMid.length;
  const n = newMid.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldMid[i - 1] === newMid[j - 1]
        ? dp[i - 1][j - 1] + 1
        : (dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldMid[i - 1] === newMid[j - 1]) { ops.push({ kind: 'eq', oi: i - 1, ni: j - 1 }); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) { ops.push({ kind: 'del', oi: i - 1 }); i--; }
    else { ops.push({ kind: 'add', ni: j - 1 }); j--; }
  }
  while (i > 0) { ops.push({ kind: 'del', oi: i - 1 }); i--; }
  while (j > 0) { ops.push({ kind: 'add', ni: j - 1 }); j--; }
  ops.reverse();
  return ops;
}

/**
 * Render a unified diff with Claude Code's exact background colors.
 * Added lines: rgb(34,92,43) background
 * Removed lines: rgb(122,41,54) background
 * @@ headers: dim
 * Context lines: dim
 */
function renderDiff(diffText) {
  const lines = diffText.split('\n');
  const rendered = [];
  let _wordDiff;
  try { _wordDiff = require('./wordDiff'); } catch { /* fallback to line-level */ }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.startsWith('+++') || line.startsWith('---')) {
      rendered.push(c().bold.dim(line));
    } else if (line.startsWith('-')) {
      // Try word-level diff: pair adjacent -/+ lines
      if (_wordDiff && idx + 1 < lines.length && lines[idx + 1].startsWith('+')) {
        const oldContent = line.slice(1); // strip leading -
        const newContent = lines[idx + 1].slice(1); // strip leading +
        const result = _wordDiff.renderWordDiffLine(oldContent, newContent, THEME);
        if (result) {
          // 整宽色条:词级高亮内容含 ANSI,用 displayWidth(剥 ANSI)测可见宽度,
          // 末尾补背景空格铺到右缘(对齐 CC formatDiff)。门控关 → _padToFull 返空串。
          const _padR = _padToFull(displayWidth('-') + displayWidth(result.oldRendered));
          const _padA = _padToFull(displayWidth('+') + displayWidth(result.newRendered));
          rendered.push(
            c().bgHex(THEME.diffRemoved).hex('#FFFFFF')('-') + result.oldRendered +
            (_padR ? c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_padR) : ''),
          );
          rendered.push(
            c().bgHex(THEME.diffAdded).hex('#FFFFFF')('+') + result.newRendered +
            (_padA ? c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_padA) : ''),
          );
          idx++; // skip the + line we already consumed
          continue;
        }
      }
      rendered.push(c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(line + _padToFull(displayWidth(line))));
    } else if (line.startsWith('+')) {
      rendered.push(c().bgHex(THEME.diffAdded).hex('#FFFFFF')(line + _padToFull(displayWidth(line))));
    } else if (line.startsWith('@@')) {
      rendered.push(c().dim(line));
    } else {
      rendered.push(c().dim(line));
    }
  }

  return rendered.join('\n');
}

/**
 * Render a structured diff for file edits (Claude Code style).
 * Shows line numbers + add/remove markers with exact background colors.
 *
 * @param {string} oldContent - original file content
 * @param {string} newContent - modified file content
 * @param {string} [filePath] - file path for header
 * @returns {string} rendered diff
 */
function renderStructuredDiff(oldContent, newContent, filePath = '') {
  // 门控开(默认):走真分 hunk 渲染(消费既有 computeStructuredDiffHunks SSOT),
  // 多处编辑各自成块、块间插 dim「⋯ N unchanged lines」分隔、±计数取真值;
  // 门控关:逐字节回退历史单区块 churn 渲染。
  if (classicDiffHunksEnabled(process.env)) {
    const hunked = _renderStructuredDiffHunked(oldContent, newContent);
    if (hunked != null) return hunked;
    // hunk 计算判定无改动(理论不可达,maybeRenderWriteDiff 仅在有 diff 时调用)→
    // 回退 legacy 以保留任何遗留可见行为,绝不静默吞掉。
  }
  return _renderStructuredDiffLegacy(oldContent, newContent, filePath);
}

// 经典 ANSI 路径的单个「改动块」渲染:把一段连续的删除行 dels[] 与紧随的新增行 adds[]
// 按 1:1 配对做词级高亮(配对外的多余删/增行各自单独渲染)。与历史 renderStructuredDiff
// 的逐行渲染**逐字节同构**(同前缀格式 / 同 bgHex 着色 / 同 wordDiff / 同整宽补白),
// 只是改为对「按 hunk 切分后的局部 del/add 行」而非「整个首末改动跨度」操作。
function _emitChangeBlock(rendered, dels, adds, pad, _wd) {
  const pairCount = Math.min(dels.length, adds.length);
  for (let p = 0; p < pairCount; p++) {
    const rm = dels[p];
    const ad = adds[p];
    const numRm = String(rm.num).padStart(pad);
    const numAd = String(ad.num).padStart(pad);
    if (_wd) {
      const result = _wd.renderWordDiffLine(rm.text, ad.text, THEME);
      if (result) {
        const _pfxRm = `  ${numRm} - `;
        const _pfxAd = `  ${numAd} + `;
        const _padRm = _padToFull(displayWidth(_pfxRm) + displayWidth(result.oldRendered));
        const _padAd = _padToFull(displayWidth(_pfxAd) + displayWidth(result.newRendered));
        rendered.push(
          c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_pfxRm) + result.oldRendered +
          (_padRm ? c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_padRm) : ''),
        );
        rendered.push(
          c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_pfxAd) + result.newRendered +
          (_padAd ? c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_padAd) : ''),
        );
        continue;
      }
    }
    const _bodyRm = `  ${numRm} - ${rm.text}`;
    const _bodyAd = `  ${numAd} + ${ad.text}`;
    rendered.push(c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_bodyRm + _padToFull(displayWidth(_bodyRm))));
    rendered.push(c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_bodyAd + _padToFull(displayWidth(_bodyAd))));
  }
  for (let p = pairCount; p < dels.length; p++) {
    const rm = dels[p];
    const num = String(rm.num).padStart(pad);
    const _body = `  ${num} - ${rm.text}`;
    rendered.push(c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body))));
  }
  for (let p = pairCount; p < adds.length; p++) {
    const ad = adds[p];
    const num = String(ad.num).padStart(pad);
    const _body = `  ${num} + ${ad.text}`;
    rendered.push(c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body))));
  }
}

/**
 * 真分 hunk 的结构化 diff 渲染(门控开路径)。消费既有 computeStructuredDiffHunks SSOT
 * —— 同一引擎已被默认 TUI(ToolLines.js)采用 —— 故经典 ANSI 路径与 TUI 收敛:
 *  - 每个 hunk 的 ctx/del/add 行各自渲染(ctx dim、del/add bgHex + 词级高亮);
 *  - 相邻 hunk 间按 gapBefore 插 dim「⋯ N unchanged lines」分隔(对齐 TUI 的 ⋯ 行),
 *    绝不再把首末改动间的未改行重绘成 churn;
 *  - 末尾 └ 摘要走 editStatLine SSOT,喂 hunk 的**真**±计数(realAdded/realRemoved)。
 * 无改动(空 hunks)→ 返回 ''(maybeRenderWriteDiff 仅在有 diff 时调用,实务不可达)。
 * @returns {string} 渲染结果
 */
function _renderStructuredDiffHunked(oldContent, newContent) {
  const { added, removed, hunks } = computeStructuredDiffHunks(
    oldContent, newContent, { context: DIFF_CONTEXT_LINES },
  );
  if ((added === 0 && removed === 0) || !hunks.length) return '';

  let _wd;
  try { _wd = require('./wordDiff'); } catch { /* fallback to line-level */ }

  // gutter 数字位宽:取所有 hunk 行号的最大位数(单一真源 diffGutter,门控关 → 恒 4 位)。
  const allRows = [];
  for (const h of hunks) for (const r of h.rows) allRows.push(r);
  const _pad = require('./diffGutter').computeDiffGutterWidth(allRows, process.env);

  const rendered = [];
  for (const hunk of hunks) {
    if (hunk.gapBefore > 0) {
      const word = `${hunk.gapBefore} unchanged line${hunk.gapBefore !== 1 ? 's' : ''}`;
      rendered.push(`  ${c().dim(`⋯ ${word}`)}`);
    } else if (hunk.gapBefore === 0) {
      rendered.push(`  ${c().dim('⋯')}`);
    }
    const rows = hunk.rows;
    let p = 0;
    while (p < rows.length) {
      const r = rows[p];
      if (r.kind === 'ctx') {
        const num = String(r.num).padStart(_pad);
        rendered.push(`  ${c().dim(num)}   ${c().dim(r.text)}`);
        p++;
        continue;
      }
      // 收集一段连续的 del 行 + 紧随的 add 行,交给 _emitChangeBlock 做配对词级高亮。
      const dels = [];
      while (p < rows.length && rows[p].kind === 'del') { dels.push(rows[p]); p++; }
      const adds = [];
      while (p < rows.length && rows[p].kind === 'add') { adds.push(rows[p]); p++; }
      _emitChangeBlock(rendered, dels, adds, _pad, _wd);
    }
  }

  // Stats — 摘要串构造收敛到单一真源 cli/editStatLine.js(真 ±计数,绝不虚报)。
  const statLine = require('./editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) {
    rendered.push(`    ${c().dim('└')} ${c().dim(statLine)}`);
  }

  return rendered.join('\n');
}

function _renderStructuredDiffLegacy(oldContent, newContent, filePath = '') {
  const {
    oldLines,
    newLines,
    removeStart,
    removeEnd,
    addStart,
    addEnd,
    added,
    removed,
  } = computeStructuredDiffStats(oldContent, newContent);

  const rendered = [];

  // Context before
  const ctxStart = Math.max(0, removeStart - DIFF_CONTEXT_LINES);
  const ctxEnd = Math.min(oldLines.length, removeEnd + DIFF_CONTEXT_LINES);
  // gutter 数字位宽收敛到单一真源 cli/diffGutter.js(对齐 CC 动态位宽,门控关→恒 4 位字节回退)。
  const _pad = require('./diffGutter')
    .computeDiffGutterWidthForMax(Math.max(removeEnd, addEnd, ctxEnd), process.env);
  for (let k = ctxStart; k < removeStart; k++) {
    const num = String(k + 1).padStart(_pad);
    rendered.push(`  ${c().dim(num)}   ${c().dim(oldLines[k])}`);
  }

  // Word-level diff: pair removed/added lines for inline highlighting
  let _wd;
  try { _wd = require('./wordDiff'); } catch { /* fallback to line-level */ }

  const removedLines = [];
  for (let k = removeStart; k < removeEnd; k++) removedLines.push({ num: k + 1, text: oldLines[k] });
  const addedLines = [];
  for (let k = addStart; k < addEnd; k++) addedLines.push({ num: k + 1, text: newLines[k] });

  // Pair removed/added lines 1:1 for word-level diff, extras go unpaired
  const pairCount = Math.min(removedLines.length, addedLines.length);

  for (let p = 0; p < pairCount; p++) {
    const rm = removedLines[p];
    const ad = addedLines[p];
    const numRm = String(rm.num).padStart(_pad);
    const numAd = String(ad.num).padStart(_pad);

    if (_wd) {
      const result = _wd.renderWordDiffLine(rm.text, ad.text, THEME);
      if (result) {
        // 整宽色条:前缀(纯文本)+ 词级高亮内容(含 ANSI,displayWidth 剥 ANSI 测宽)。
        const _pfxRm = `  ${numRm} - `;
        const _pfxAd = `  ${numAd} + `;
        const _padRm = _padToFull(displayWidth(_pfxRm) + displayWidth(result.oldRendered));
        const _padAd = _padToFull(displayWidth(_pfxAd) + displayWidth(result.newRendered));
        rendered.push(
          c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_pfxRm) + result.oldRendered +
          (_padRm ? c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_padRm) : ''),
        );
        rendered.push(
          c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_pfxAd) + result.newRendered +
          (_padAd ? c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_padAd) : ''),
        );
        continue;
      }
    }
    // Fallback: line-level
    const _bodyRm = `  ${numRm} - ${rm.text}`;
    const _bodyAd = `  ${numAd} + ${ad.text}`;
    rendered.push(c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_bodyRm + _padToFull(displayWidth(_bodyRm))));
    rendered.push(c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_bodyAd + _padToFull(displayWidth(_bodyAd))));
  }

  // Unpaired removed lines (more removals than additions)
  for (let p = pairCount; p < removedLines.length; p++) {
    const rm = removedLines[p];
    const num = String(rm.num).padStart(_pad);
    const _body = `  ${num} - ${rm.text}`;
    rendered.push(c().bgHex(THEME.diffRemoved).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body))));
  }

  // Unpaired added lines (more additions than removals)
  for (let p = pairCount; p < addedLines.length; p++) {
    const ad = addedLines[p];
    const num = String(ad.num).padStart(_pad);
    const _body = `  ${num} + ${ad.text}`;
    rendered.push(c().bgHex(THEME.diffAdded).hex('#FFFFFF')(_body + _padToFull(displayWidth(_body))));
  }

  // Context after (ctxEnd computed once above for gutter-width sizing)
  for (let k = removeEnd; k < ctxEnd; k++) {
    if (k < oldLines.length) {
      const num = String(k + 1).padStart(_pad);
      rendered.push(`  ${c().dim(num)}   ${c().dim(oldLines[k])}`);
    }
  }

  // Stats — 摘要串构造收敛到单一真源 cli/editStatLine.js(含 CC 句首 "Removed" 大写规则)。
  const statLine = require('./editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) {
    rendered.push(`    ${c().dim('└')} ${c().dim(statLine)}`);
  }

  return rendered.join('\n');
}

/**
 * Detect and render inline diffs within AI response text.
 * Looks for fenced diff blocks: ```diff ... ```
 */
function renderResponseWithDiffs(text) {
  const parts = text.split(/(```diff\n[\s\S]*?```)/g);
  const rendered = [];

  for (const part of parts) {
    if (part.startsWith('```diff\n') && part.endsWith('```')) {
      const diffContent = part.slice(8, -3);
      rendered.push(renderDiff(diffContent));
    } else {
      rendered.push(part);
    }
  }

  return rendered.join('\n');
}

module.exports = {
  computeStructuredDiffStats,
  computeStructuredDiffHunks,
  renderDiff,
  renderStructuredDiff,
  renderResponseWithDiffs,
};
