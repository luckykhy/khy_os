'use strict';

/**
 * SidebarPanel — wide-terminal sidebar for the live region (right of the
 * spinner / task panel / prompt / footer column). Shows: task checklist with
 * total progress, tool-call activity, pending message queue, and recent
 * background notifications (notificationPort entries fed by App). 会话主题、
 * 模型+强度、上下文用量已按确认规格移除(页脚/置顶栏另有展示,看板不再重复)。
 *
 * Design constraints:
 *  - Pure Ink Box/Text — zero direct ANSI writes, zero scroll regions.
 *  - Zero new data sources / timers: every prop is fed by App from state it
 *    already reads; repaint rides the existing nowTick heartbeat.
 *  - fail-soft: any exception → render null (the sidebar is auxiliary and must
 *    never take down the TUI).
 *  - `buildSidebarLines` is a pure leaf (line descriptors in → out) so unit
 *    tests can cover content without an Ink runtime.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

// Status-count + per-line status SSOT: reuse the same icon→status inverse map
// the task panel header uses, so sidebar styling/counts can never drift.
const { countTaskLinesByStatus, taskLineStatus } = require('./taskPanelLines');

// 看板侧状态符号/颜色(确认规格):待办 灰 ○、进行中 高亮 ●、完成 绿 ✓。
// error 是 khy 额外状态,保留 ✗ 红(失败必须被看见,绝不静默归错类)。
// TASK_GLYPH 是「任务行状态色映射」单一真源,formatTaskLine 引用它,状态配色绝不散落为字面量。
const TASK_GLYPH = {
  pending: { icon: '○', color: 'gray' },
  in_progress: { icon: '●', color: 'cyan', bold: true },
  completed: { icon: '✓', color: 'green' },
  error: { icon: '✗', color: 'red' },
};

// 非任务行的配色/文案单一真源(具名常量,零硬编码;标识符/注释英文,面向用户文案中文)。
// 空态占位行:无任务时看板仍显示,样式为 dim gray(绝不返空)。
const EMPTY_PLACEHOLDER = { text: '暂无任务', color: 'gray', dim: true };
// 工具活动行:有运行中 → 高亮黄;全部完成 → 绿。
const TOOLS_COLOR = { running: 'yellow', idle: 'green' };
// 已完成项折叠为一行时的配色(与 completed 状态色一致,绿)。
const COMPLETED_FOLD_COLOR = 'green';
// 通知条目 level→颜色单一真源(仿 TASK_GLYPH/TOOLS_COLOR 模式,零散落字面量)。
// 未知 level 一律按 info 处理(诚实降级,绝不抛错)。
const NOTIFY_LEVEL_COLOR = { info: 'gray', warn: 'yellow', error: 'red' };

// Lazy display-width measurer (CJK-aware). Fallback: naive length.
function _measure() {
  try {
    const dw = require('../../formatters').displayWidth;
    if (typeof dw === 'function') {
      return dw;
    }
  } catch {
    /* fall through */
  }
  return (s) => String(s).length;
}

/**
 * Truncate `text` to at most `maxWidth` display columns (CJK-aware) appending
 * `…` when cut. Never throws.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(s: string) => number} measure
 * @returns {string}
 */
function truncateToWidth(text, maxWidth, measure) {
  const s = String(text == null ? '' : text);
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return '';
  }
  // ASCII fast path: printable single-byte text has display width === length,
  // so skip the per-character measure loop. Byte-identical to the generic path
  // below (1 column reserved for the ellipsis when the text is cut).
  if (/^[\x20-\x7e]*$/.test(s)) {
    return s.length <= maxWidth ? s : s.slice(0, maxWidth - 1) + '…';
  }
  if (measure(s) <= maxWidth) {
    return s;
  }
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = measure(ch);
    if (w + cw > maxWidth - 1) {
      break;
    } // reserve 1 col for the ellipsis
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * 单条任务行 → 行描述符:`序号. 状态符号 标题`(如 `3. ● 修复登录校验`)。
 * 行首图标不可识别(status=null)→ 原样文本前加序号(诚实保留,绝不丢行)。
 * @param {string} line - 行首带 ✓/→/✗/○ 图标的原始任务行
 * @param {number} ordinal - 1-based 序号(折叠完成项时仍保持原序号)
 * @param {(s: string) => string} t - 宽度截断器
 * @returns {{text: string, color?: string, dim?: boolean, bold?: boolean}}
 */
function formatTaskLine(line, ordinal, t) {
  const raw = String(line == null ? '' : line).trimStart();
  const status = taskLineStatus(raw);
  if (!status) {
    return { text: t(`${ordinal}. ${raw}`) };
  }
  const glyph = TASK_GLYPH[status];
  const title = raw.replace(/^[✓→✗○]\s*/, '');
  return {
    text: t(`${ordinal}. ${glyph.icon} ${title}`),
    color: glyph.color,
    bold: !!glyph.bold,
  };
}

/**
 * Pure line builder: props in → array of {text, color?, dim?, bold?} out.
 * Sections(确认规格): tasks(always) / tools / queue / notifications。
 *  - 任务标题行总进度 `任务 已完成数/总数`;图标不可识别 → 诚实回退「任务 m 项」。
 *  - 每项 `序号. 状态符号 标题`(待办 灰○ / 进行中 高亮● / 完成 绿✓)。
 *  - 溢出策略:仅当总行数超过 props.maxRows(看板高度上限)时,把已完成项
 *    折叠为一行 `✓ 已完成 N 项`(优先保证进行中+待办可见);空间足够时
 *    完成项正常列出。maxRows 缺失/0 → 不折叠(下游 capSidebarLines 兄兜底)。
 *  - 无任务 → 灰色提示行「暂无任务」(看板始终显示,不再返空)。
 *  - notifications(props.notifications: Array<{level,title,detail?,timestamp,
 *    count?}>): 有通知时空行分隔 + 标题行「通知 n 条」(bold) + 每条一行,
 *    level 经 NOTIFY_LEVEL_COLOR 映射配色,文本 `title` 或 `title · detail`
 *    经截断器处理;空数组/非法输入 → 不渲染该段(与 tools/queue 一致);
 *    超高折叠由下游 capSidebarLines 兜底。
 * Deterministic, zero IO (aside from the lazy width measurer), never throws
 * on malformed input (callers still wrap in try/catch at the component level).
 * @param {object} props
 * @returns {Array<{text: string, color?: string, dim?: boolean, bold?: boolean}>}
 */
function buildSidebarLines(props = {}) {
  const width = Number(props.width) > 0 ? Number(props.width) : 30;
  const innerW = Math.max(4, width - 2); // border + padding overhead
  const measure = _measure();
  const t = (s) => truncateToWidth(s, innerW, measure);
  const taskLines = Array.isArray(props.taskLines) ? props.taskLines : [];
  const maxRows = Math.max(0, Math.floor(Number(props.maxRows) || 0));
  // 阶段四 (optional): scroll window + selection highlight. Both stay OFF unless
  // the caller passes them, so an absent scrollOffset/selectedIdx leaves every
  // path below byte-identical to the legacy board.
  const _rawScroll = Number(props.scrollOffset);
  const _hasScroll = Number.isFinite(_rawScroll);
  const _scrollOffset = _hasScroll ? Math.max(0, Math.floor(_rawScroll)) : 0;
  const _rawSelected = Number(props.selectedIdx);
  const _selectedIdx = Number.isFinite(_rawSelected) ? Math.floor(_rawSelected) : -1;
  // Section divider glyph line (replaces the old blank spacer between the main
  // sections). innerW already accounts for the border + padding overhead.
  const divider = { text: '─'.repeat(innerW), dim: true };
  // Notification fade inputs (task #4): App threads the SAME now/ttl it uses to
  // filter expired entries, plus the fadeRatio from the sidebarLayout getter —
  // buildSidebarLines stays pure (no env read). Fade is applied ONLY when all
  // three are finite; otherwise entries render at full weight (safe fallback,
  // zero hardcoded threshold).
  const _now = Number(props.now);
  const _notifyTtl = Number(props.notifyTtl);
  const _fadeRatio = Number(props.notifyFadeRatio);
  const _canFade =
    Number.isFinite(_now) &&
    Number.isFinite(_notifyTtl) &&
    _notifyTtl > 0 &&
    Number.isFinite(_fadeRatio);

  const build = (foldCompleted) => {
    const lines = [];

    // 1. Task checklist. App owns the canonical full-width TaskListPanel and
    // passes hideTaskSection here so the optional right rail does not duplicate
    // tasks or show a misleading permanent empty state.
    if (!props.hideTaskSection) {
      if (taskLines.length === 0) {
        lines.push({ ...EMPTY_PLACEHOLDER, text: t(EMPTY_PLACEHOLDER.text) });
        lines.push({ text: t('创建任务或执行计划后将显示'), color: 'gray', dim: true });
      } else {
        const counts = countTaskLinesByStatus(taskLines);
        const total = taskLines.length;
        // 图标不可识别 → 诚实只报总数(绝不臆造完成数)。
        const header = counts.unknown > 0 ? `任务 ${total} 项` : `任务 ${counts.completed}/${total}`;
        lines.push({ text: t(header), bold: true });
        let folded = 0;
        for (let i = 0; i < taskLines.length; i++) {
          const status = taskLineStatus(taskLines[i]);
          if (foldCompleted && status === 'completed') {
            folded += 1;
            continue;
          }
          lines.push(formatTaskLine(taskLines[i], i + 1, t));
        }
        if (folded > 0) {
          lines.push({ text: t(`✓ 已完成 ${folded} 项`), color: COMPLETED_FOLD_COLOR, dim: true });
        }
      }
    }

    // 2. Tool activity: running = tools without a result yet (ToolLines.js
    //    contract: `done = !!t.result`).
    const tools =
      props.streaming && Array.isArray(props.streaming.tools) ? props.streaming.tools : [];
    if (tools.length > 0) {
      const running = tools.filter((x) => !(x && x.result)).length;
      if (lines.length > 0) {
        lines.push({ ...divider });
      }
      lines.push({
        text: t(`工具 · 运行中 ${running}/共 ${tools.length}`),
        color: running > 0 ? TOOLS_COLOR.running : TOOLS_COLOR.idle,
      });
    }

    // 3. Message queue.
    const queueLen = Math.max(0, Number(props.queueLen) || 0);
    if (queueLen > 0) {
      lines.push({ ...divider });
      lines.push({ text: t(`⧗ 队列 ${queueLen} 条待发送`), dim: true });
    }

    // 4. Recent notifications (notificationPort entries). Malformed entries
    //    (non-object / empty title+detail) are skipped honestly; an empty
    //    result renders nothing (same contract as tools/queue above).
    const rawNotifications = Array.isArray(props.notifications) ? props.notifications : [];
    const notifyEntries = rawNotifications.filter((n) => {
      if (!n || typeof n !== 'object') {
        return false;
      }
      return String(n.title || '') !== '' || String(n.detail || '') !== '';
    });
    if (notifyEntries.length > 0) {
      lines.push({ ...divider });
      lines.push({ text: t(`通知 ${notifyEntries.length} 条`), bold: true });
      for (const n of notifyEntries) {
        const title = String(n.title || '');
        const detail = String(n.detail || '');
        const text = detail ? (title ? `${title} · ${detail}` : detail) : title;
        // Age-based fade: entries past the fadeRatio fraction of their TTL dim
        // out as they approach expiry (task #4). Skipped entirely when the
        // fade inputs are absent (see _canFade).
        const nline = {
          text: t(text),
          color: NOTIFY_LEVEL_COLOR[n.level] || NOTIFY_LEVEL_COLOR.info,
        };
        const ts = Number(n.timestamp);
        if (_canFade && Number.isFinite(ts) && (_now - ts) / _notifyTtl > _fadeRatio) {
          nline.dim = true;
        }
        lines.push(nline);
      }
    }

    return lines;
  };

  let lines = build(false);
  // 阶段四 selection highlight: tag the selected content line so the rail's
  // _style paints it reverse-video. Applied to the FULL list BEFORE any window
  // so the tag rides into the visible slice; out-of-range / absent → untouched.
  if (_selectedIdx >= 0 && _selectedIdx < lines.length) {
    const sel = lines[_selectedIdx];
    if (sel && typeof sel === 'object') {
      lines[_selectedIdx] = { ...sel, selected: true };
    }
  }
  if (_hasScroll && maxRows > 0 && lines.length > maxRows) {
    // 阶段四 scroll windowing supersedes completed-folding: show a maxRows-tall
    // window at the clamped offset with ↑/↓ hidden-count indicators.
    lines = _windowLines(lines, _scrollOffset, maxRows, t);
  } else if (maxRows > 0 && lines.length > maxRows) {
    // Legacy overflow (byte-identical): fold completed items into one line.
    const foldedLines = build(true);
    if (foldedLines.length < lines.length) {
      lines = foldedLines;
    }
  }
  return lines;
}

/**
 * Pure height-cap helper: when maxRows > 0 and the content overflows, keep
 * the first (maxRows - 1) lines and append an honest “… 其余 N 行” marker so
 * the box never exceeds maxRows. Never pads — padding is padSidebarLines' job.
 * Zero-value semantics (D6, aligned with padSidebarLines / buildSidebarLines):
 * maxRows 0, negative, NaN or non-numeric all normalize to 0 = UNCAPPED (hug
 * content, legacy behaviour) — 0 deliberately means "no constraint", NOT "no
 * space". Callers that need a real cap must pass a positive row count;
 * sidebarContentRows only ever returns 0 when the stable height is disabled
 * (hug mode), so an unintended 0 cannot reach here from the render path.
 * @param {Array<{text: string}>} lines
 * @param {number} maxRows - 0/negative/invalid = uncapped (no constraint)
 * @returns {Array<{text: string}>}
 */
function capSidebarLines(lines, maxRows) {
  const arr = Array.isArray(lines) ? lines : [];
  // Normalize garbage (NaN/negative/non-numeric) to 0 = uncapped, one rule.
  const cap = Math.max(0, Math.floor(Number(maxRows) || 0));
  if (cap === 0 || arr.length <= cap) {
    return arr;
  }
  const keep = Math.max(1, cap - 1); // reserve 1 row for the marker
  return arr.slice(0, keep).concat([{ text: `… 其余 ${arr.length - keep} 行`, dim: true }]);
}

/**
 * 阶段四 pure scroll-window helper: given the FULL line list and a window height
 * H (= maxRows), return EXACTLY H rows starting at the clamped offset. The
 * first / last visible row is overlaid with a dim ↑ / ↓ hidden-count indicator
 * whenever content is hidden above / below (reusing the capSidebarLines dim
 * marker style). Called only when len > H (overflow), so the slice is always
 * full height. Never throws.
 * @param {Array<{text: string}>} lines
 * @param {number} scrollOffset
 * @param {number} maxRows
 * @param {(s: string) => string} t - width truncator
 * @returns {Array<object>}
 */
function _windowLines(lines, scrollOffset, maxRows, t) {
  const arr = Array.isArray(lines) ? lines : [];
  const len = arr.length;
  const H = Math.max(1, Math.floor(Number(maxRows) || 0));
  if (len <= H) {
    return arr;
  }
  const maxOff = Math.max(0, len - H);
  const off = Math.min(Math.max(0, Math.floor(Number(scrollOffset) || 0)), maxOff);
  const win = arr.slice(off, off + H); // exactly H rows (len > H guaranteed)
  if (off > 0) {
    // Hidden above = the `off` lines before the window PLUS the content row this
    // indicator now covers.
    win[0] = { text: t(`↑ ${off + 1} 行`), dim: true };
  }
  if (off < maxOff) {
    const below = len - (off + H); // rows strictly below the window
    win[win.length - 1] = { text: t(`↓ ${below + 1} 行`), dim: true };
  }
  return win;
}

/**
 * Pure padding helper (task #20 stable height): when rows > 0 and the content
 * is shorter, append blank line descriptors so the sidebar always fills its
 * stable height — the bg branch renders them as a continuous color block.
 * Combined with capSidebarLines this pins the content to EXACTLY `rows` lines
 * regardless of how much the left column (model output) renders.
 * @param {Array<{text: string}>} lines
 * @param {number} rows - 0/invalid = no padding (hug content)
 * @returns {Array<{text: string}>}
 */
function padSidebarLines(lines, rows) {
  const arr = Array.isArray(lines) ? lines : [];
  const n = Math.max(0, Math.floor(Number(rows) || 0));
  if (n === 0 || arr.length >= n) {
    return arr;
  }
  return arr.concat(Array.from({ length: n - arr.length }, () => ({ text: '' })));
}

/**
 * Pure: pad `text` with trailing spaces up to `innerW` display columns
 * (CJK-aware). With a background color active every rendered row then paints
 * the FULL column width — the flat block stays visually continuous even for
 * short lines and blank filler rows (a bare '' would only paint one cell).
 * Never throws; over-wide text is returned untouched (truncation is
 * truncateToWidth's job upstream).
 * @param {string} text
 * @param {number} innerW
 * @param {(s: string) => number} measure
 * @returns {string}
 */
function padLineToWidth(text, innerW, measure) {
  const s = String(text == null ? '' : text);
  const w = Number(innerW);
  if (!Number.isFinite(w) || w <= 0) {
    return s;
  }
  const m = typeof measure === 'function' ? measure : (x) => String(x).length;
  const used = m(s);
  if (used >= w) {
    return s;
  }
  return s + ' '.repeat(w - used);
}

/**
 * Pure: rows available for CONTENT inside the box so the box's TOTAL vertical
 * footprint equals the stable height. Task #23 removed the marginTop offset
 * (the startup banner now sits in the SAME row, left column — top edges
 * align instead of stacking), so the bg branch spends nothing on chrome and
 * the legacy border branch spends 2 rows on its borders.
 * @param {string|null} bg - resolved sidebar background (null = border branch)
 * @param {number} stableRows - sidebarLayout.sidebarStableRows value
 * @returns {number} 0 = disabled (hug content)
 */
function sidebarContentRows(bg, stableRows) {
  const stable = Math.max(0, Math.floor(Number(stableRows) || 0));
  if (stable === 0) {
    return 0;
  }
  return Math.max(1, stable - (bg ? 0 : 2));
}

/**
 * Pure Box-props builder (task #20/#21/#23): stable height is enforced via
 * minHeight (NOT flex) so the sidebar can never be squeezed by a tall left
 * column, and content is explicitly TOP-ALIGNED (justifyContent flex-start —
 * lines start at the box top, filler rows sit BELOW the content). Task #23:
 * NO marginTop — at startup the banner renders in the SAME row's left
 * column, so the version line and the sidebar top edge share one terminal
 * row (left/right split; the flex row keeps the columns from colliding).
 * Total vertical footprint = minHeight = `stable`, keeping the live-region
 * budget intact. stableRows ≤ 0 → no minHeight (hug content, legacy).
 * @param {string|null} bg
 * @param {number} width
 * @param {number} stableRows
 * @returns {object}
 */
function sidebarBoxProps(bg, width, stableRows) {
  const base = bg
    ? // Borderless flat column — every row paints a full-width bg line
      // (padLineToWidth), keeping the block visually continuous top to bottom.
      {
        flexDirection: 'column',
        width,
        flexShrink: 0,
        backgroundColor: bg,
        paddingX: 1,
        justifyContent: 'flex-start',
      }
    : // Disabled state: keep the pre-existing bordered visual untouched.
      {
        flexDirection: 'column',
        width,
        flexShrink: 0,
        borderStyle: 'round',
        borderColor: 'gray',
        paddingX: 1,
        justifyContent: 'flex-start',
      };
  const stable = Math.max(0, Math.floor(Number(stableRows) || 0));
  if (stable > 0) {
    base.minHeight = bg ? Math.max(1, stable) : Math.max(3, stable);
  }
  return base;
}

/**
 * Pure mode selector for the rendered line set:
 *  - default (fitContent falsy): cap then pad — the box always fills exactly
 *    `contentRows` lines (startup stable height, task #20/#23 behaviour).
 *  - fitContent mode (post-first-message, 任务#11): cap ONLY — the box hugs
 *    its content (shown rows = min(content, contentRows)); overflow is still
 *    truncated behind the honest “… 其余 N 行” marker so the height ceiling
 *    (sidebarFillRows) holds and the board can never reach the prompt chrome.
 * contentRows ≤ 0 → hug content untouched (legacy). Zero-value semantics
 * (D6): contentRows 0/negative/invalid means "no constraint" for BOTH the cap
 * (capSidebarLines) and the padding (padSidebarLines) — the two helpers share
 * one normalization rule so the shown height can never disagree between them.
 * @param {Array<{text: string}>} lines
 * @param {number} contentRows
 * @param {boolean} [fitContent]
 * @returns {Array<{text: string}>}
 */
function sidebarShownLines(lines, contentRows, fitContent) {
  const capped = capSidebarLines(lines, contentRows);
  return fitContent ? capped : padSidebarLines(capped, contentRows);
}

function SidebarPanel(props = {}) {
  try {
    const { Box, Text } = inkRuntime.get();
    const h = React.createElement;
    const width = Number(props.width) > 0 ? Number(props.width) : 30;
    // opencode-style flat background block (ink 6+ Box backgroundColor; the
    // renderer fills the whole content area row by row and Text children
    // inherit it via backgroundContext). Resolution lives in the sidebarLayout
    // pure leaf (KHY_SIDEBAR_BG); null → disabled → legacy bordered visual.
    let bg = null;
    try {
      bg = require('../sidebarLayout').sidebarBg(process.env);
    } catch {
      bg = null;
    }
    const fitContent = !!props.fitContent;
    const contentRows = sidebarContentRows(bg, props.stableRows);
    // maxRows = 内容行上限:让 buildSidebarLines 的「已完成项折叠」溢出策略在
    // 折叠就能救回的场景下优先于 capSidebarLines 的硬截断生效。
    const lines = buildSidebarLines({ ...props, maxRows: contentRows });
    if (!lines.length) {
      return null;
    }
    // Height semantics via props (任务#11):
    //  - startup (fitContent falsy): props.stableRows pins the sidebar to a
    //    constant vertical footprint (sidebarLayout.sidebarStableRows, task
    //    #20) — short content is TOP-ALIGNED with filler rows appended BELOW
    //    it and minHeight guarantees a tall left column can never collapse
    //    the box (behaviour unchanged).
    //  - post-first-message (fitContent=true): the box HUGS its content — no
    //    filler rows, no minHeight — while props.stableRows (sidebarLayout.
    //    sidebarFillRows) stays the CEILING: overflow is truncated behind the
    //    honest “… 其余 N 行” marker so the board never grows past
    //    rows - minChrome (anti scroll-jump).
    // stableRows ≤ 0 (env off-writing / leaf missing) → legacy hug behaviour.
    const shown = sidebarShownLines(lines, contentRows, fitContent);
    const boxProps = sidebarBoxProps(bg, width, fitContent ? 0 : props.stableRows);
    // bg branch: right-pad every row to the full inner width so the flat
    // color block reads as one continuous panel (blank filler rows included).
    const innerW = Math.max(4, width - 2);
    const measure = bg ? _measure() : null;
    return h(
      Box,
      boxProps,
      ...shown.map((ln, i) =>
        h(
          Text,
          {
            key: `sb-${i}`,
            color: ln.color,
            dimColor: !!ln.dim,
            bold: !!ln.bold,
          },
          bg ? padLineToWidth(ln.text, innerW, measure) : ln.text || ' '
        )
      )
    );
  } catch (err) {
    // D5: fail-soft must stay (the sidebar is auxiliary and must never break
    // the TUI), but swallowing silently hides real regressions — surface the
    // error behind an explicit debug gate (same pattern as KHY_DEBUG_TASK_PANEL).
    if (process.env.KHY_DEBUG_SIDEBAR === '1') {
      try {
        console.error('[sidebar-debug]', err);
      } catch {
        /* never throw from the guard */
      }
    }
    return null; // fail-soft: the sidebar must never break the TUI
  }
}

module.exports = SidebarPanel;
module.exports.buildSidebarLines = buildSidebarLines;
module.exports.formatTaskLine = formatTaskLine;
module.exports.capSidebarLines = capSidebarLines;
module.exports.padSidebarLines = padSidebarLines;
module.exports.padLineToWidth = padLineToWidth;
module.exports.sidebarContentRows = sidebarContentRows;
module.exports.sidebarBoxProps = sidebarBoxProps;
module.exports.sidebarShownLines = sidebarShownLines;
module.exports.truncateToWidth = truncateToWidth;
// 配色/文案具名常量单一真源(供测试断言引用,防止字面量回流散落)。
module.exports.TASK_GLYPH = TASK_GLYPH;
module.exports.EMPTY_PLACEHOLDER = EMPTY_PLACEHOLDER;
module.exports.TOOLS_COLOR = TOOLS_COLOR;
module.exports.COMPLETED_FOLD_COLOR = COMPLETED_FOLD_COLOR;
module.exports.NOTIFY_LEVEL_COLOR = NOTIFY_LEVEL_COLOR;
