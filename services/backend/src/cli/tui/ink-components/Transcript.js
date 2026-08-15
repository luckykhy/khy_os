'use strict';

/**
 * Transcript — renders committed conversation messages.
 *
 * Exposes both the list component (Transcript) and the per-message component
 * (MessageBlock) so the App can drive an ink <Static> region directly.
 */
const React = require('react');

const { buildThinkingSummary, buildThinkingHeader } = require('../../thinkingDuration');
const { effectiveCols } = require('../effectiveCols');
const inkRuntime = require('../inkRuntime');

const ProcessGroup = require('./ProcessGroup');
const { sectionGapEnabled } = require('./sectionGap');
const ToolLines = require('./ToolLines');
const { collapseLongUserMessage } = require('./userMessageCollapse');
// 有效列宽单一真源:右栏(railLayout)激活时 ink 只能画到 cols - 栏宽,committed 消息
// 的白底框若仍按全宽排版就会溢出到槽位里。门控关 → 返回真实列宽 → 逐字节 legacy。
// 折叠思考行的真实时长(纯叶子 SSOT):把 CC 的「Thought for Ns」绑到 timeline 条目的
// 真实 durationMs。门控 KHY_THINKING_DURATION 默认开;关 → 回退旧「💭 思考 · N 字」。

// 区块间空行分隔门控(与 StreamingBlock 共用单一真源):thinking/工具组/回答段间恰一空行。

let _renderMarkdownLite = null;
function renderMarkdown(text, cols) {
  if (_renderMarkdownLite === null) {
    try {
      _renderMarkdownLite = require('../../markdownRenderer').renderMarkdownLite || false;
    } catch {
      _renderMarkdownLite = false;
    }
  }
  if (_renderMarkdownLite) {
    // Pass the rail-aware width so committed messages wrap (and generate
    // horizontal rules) at the same column count StreamingBlock used live —
    // otherwise a rule laid out at full width soft-wraps into the "staircase"
    // break when the right rail is active. Omitting cols keeps legacy behavior.
    try {
      return _renderMarkdownLite(text, cols);
    } catch {
      /* fall through */
    }
  }
  return text;
}

// Tier-gated text normalization. Strong models (selfRender) are trusted to format
// their own output — only invisible/control bytes are stripped (terminal safety).
// Small/unknown models (!selfRender) get the full normalizeFinal pass so leaked
// chat-template sentinels, role echoes, repeated paragraphs and unclosed fences
// are cleaned to a uniform shape. Applied BEFORE markdown rendering so the cleaned
// text is what gets laid out (and what the renderer caches).
//
// `continuation` fragments are the sealed prefixes that 1.1 committed mid-stream:
// they were already shown live via the PREFIX-STABLE normalizeStreaming pass at a
// safe boundary (no open fence). Re-normalizing them with normalizeFinal here would
// re-flow that exact text (dedup/trim/fence-close) the instant it crosses from the
// live region to <Static> — a visible vertical jump. So a continuation fragment is
// normalized with the SAME streaming pass it was shown with, landing byte-for-byte
// as the user already saw it. The terminal (non-continuation) commit keeps the full
// pass, which owns closing the final open fence and trimming the tail.
let _normalizer = null;
function normalizeCommitted(text, selfRender, continuation) {
  if (!text) {
    return text;
  }
  if (_normalizer === null) {
    try {
      _normalizer = require('../../modelTextNormalizer') || false;
    } catch {
      _normalizer = false;
    }
  }
  if (!_normalizer) {
    return text;
  }
  try {
    // Continuation fragments are shown with the PREFIX-STABLE streaming pass and must
    // land byte-for-byte with what was already on screen — no fence-closing here, so the
    // output integrity guard (which closes fences) is intentionally NOT applied to them;
    // the terminal commit below owns final fence-closing + soft-bug repair.
    if (continuation) {
      return _normalizer.normalizeStreaming(text);
    }
    if (selfRender) {
      // Strong models self-format and bypass normalizeFinal's built-in integrity guard
      // (sanitize only strips control bytes). Run the same guard here so 乱码 / 未闭合围栏
      // in a strong model's committed output is detected + repaired, not just for small models.
      let out = _normalizer.sanitize(text);
      try {
        out = _normalizer.guardText(out, { source: 'tui-commit-selfrender', render: true }).text;
      } catch {
        /* fail-soft */
      }
      return out;
    }
    // Small/unknown models: normalizeFinal already runs the integrity guard internally.
    return _normalizer.normalizeFinal(text);
  } catch {
    return text;
  }
}

// Lazy CJK-aware width (string-width under the hood); falls back to code-unit
// length. Used to pad/wrap the user-message white box so its fill is solid and
// width-safe regardless of full-width characters.
let _dispW = null;
function _displayWidth(s) {
  if (_dispW === null) {
    try {
      _dispW = require('../../formatters').displayWidth || false;
    } catch {
      _dispW = false;
    }
  }
  if (_dispW) {
    try {
      return _dispW(s);
    } catch {
      /* fall through */
    }
  }
  return String(s == null ? '' : s).length;
}

// 米白色 (warm off-white / eggshell) rather than pure white: pure 'white' against
// dark text is too high-contrast / glaring in a terminal. This softer cream keeps
// the user-message box visually distinct from the default-background output while
// being easy on the eyes. Overridable with KHY_USER_MSG_BG (any chalk-accepted
// color: a hex like '#F0EAD6' or a named color) for users who want a different tint.
const DEFAULT_USER_MSG_BG = '#F0EAD6';
function userMsgBgColor() {
  const v = String(process.env.KHY_USER_MSG_BG == null ? '' : process.env.KHY_USER_MSG_BG).trim();
  return v || DEFAULT_USER_MSG_BG;
}

// Foreground for the user-message text on the cream box. The named color 'black'
// combined with `bold` gets promoted to the terminal's BRIGHT-black palette slot
// (= gray) on most emulators — which is exactly why the text read as washed-out,
// low-contrast gray on the off-white box instead of black. A truecolor hex is
// immune to the bold→bright promotion, so the text renders as true, high-contrast
// black against the cream. Overridable with KHY_USER_MSG_FG (any chalk-accepted
// color: a hex like '#000000' or a named color).
const DEFAULT_USER_MSG_FG = '#1A1A1A';
function userMsgFgColor() {
  const v = String(process.env.KHY_USER_MSG_FG == null ? '' : process.env.KHY_USER_MSG_FG).trim();
  return v || DEFAULT_USER_MSG_FG;
}

/**
 * Gate for the off-white (米白) USER MESSAGE box in the workspace (默认开). This
 * paints the user's OWN submitted content (committed in the transcript) on a soft
 * cream background so it reads as a distinct box vs the default-background AI/tool
 * output — the INPUT box stays transparent (terminal-native). Set
 * KHY_USER_MSG_WHITE_BG ∈ {0,false,off,no} to revert to the legacy transparent
 * echo (byte-identical).
 */
function userMsgWhiteBgEnabled() {
  const v = String(
    process.env.KHY_USER_MSG_WHITE_BG == null ? '' : process.env.KHY_USER_MSG_WHITE_BG
  )
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** CJK-aware width-bounded wrap of one logical line into ≤cap visual pieces. */
function _wrapByWidth(line, cap) {
  const lim = Math.max(1, cap | 0);
  if (line === '') {
    return [''];
  }
  const segs = [];
  let start = 0;
  let w = 0;
  let idx = 0;
  for (const ch of line) {
    const cw = _displayWidth(ch);
    if (w + cw > lim && idx > start) {
      segs.push(line.slice(start, idx));
      start = idx;
      w = 0;
    }
    w += cw;
    idx += ch.length;
  }
  segs.push(line.slice(start, idx));
  return segs;
}

/**
 * Pure: lay out a user message into white-box rows. Each row is marker + text +
 * a trailing pad that fills the box to its full inner width (cols-1, the same
 * one-cell slack the border uses to dodge the terminal pending-wrap margin), so
 * the white background renders as a SOLID box edge-to-edge. Long / multi-line
 * content is wrapped (CJK-aware) so every row stays within the box. No Ink —
 * exported for regression tests.
 *
 * @param {string} content
 * @param {{cols?:number}} opts
 * @returns {Array<{segments:Array<{text:string,role:string}>, contentWidth:number, pad:number, totalWidth:number, innerWidth:number}>}
 *   role ∈ 'marker' | 'text' | 'pad'
 */
function buildUserMessageBox(content, { cols = 80 } = {}) {
  const innerWidth = Math.max(1, (Number(cols) > 0 ? Number(cols) : 80) - 1);
  const markerW = 2; // "❯ " / "  " — both 2 columns
  const avail = Math.max(1, innerWidth - markerW);
  // Cap the DISPLAYED text (head + `… +N lines …` + tail) before wrapping so a
  // giant piped-stdin prompt doesn't re-wrap every frame. Perf guard only; the
  // stored/submitted message is untouched. Gate off → verbatim. See CC parity
  // note in ./userMessageCollapse.js.
  const capped = collapseLongUserMessage(String(content == null ? '' : content), process.env);
  const logical = String(capped == null ? '' : capped).split('\n');
  const pieces = [];
  for (const ln of logical) {
    for (const seg of _wrapByWidth(ln, avail)) {
      pieces.push(seg);
    }
  }
  if (pieces.length === 0) {
    pieces.push('');
  }
  return pieces.map((text, i) => {
    const marker = i === 0 ? '❯ ' : '  ';
    const segments = [
      { text: marker, role: 'marker' },
      { text, role: 'text' },
    ];
    const contentWidth = markerW + _displayWidth(text);
    const pad = Math.max(0, innerWidth - contentWidth);
    if (pad > 0) {
      segments.push({ text: ' '.repeat(pad), role: 'pad' });
    }
    return { segments, contentWidth, pad, totalWidth: contentWidth + pad, innerWidth };
  });
}

/**
 * Adapt a PERSISTED turn timeline (msg._timeline, the light projection written
 * by queryBridgeTimeline.buildTurnArtifacts) into the live-timeline shape that
 * ProcessGroup.groupTimeline understands. Pure & fail-soft: any unexpected
 * shape → null → the caller keeps the legacy render path byte-identical.
 *
 * Persisted entries: {type:'text',text} | {type:'thinking',text,durationMs?} |
 * {type:'tools',tools:[{name,paramsSummary,status}]}. groupTimeline only
 * recognises per-tool {type:'tool',tool} entries, so each persisted group is
 * EXPANDED back into consecutive tool entries; each light descriptor becomes a
 * render-ready pseudo tool (paramsSummary → input string; status → a result
 * object so the row shows ✓/✗ instead of a forever-pending ◆). durationMs and
 * error text are joined IN ORDER from msg._toolCalls with a name guard — real
 * recorded values only; missing stays missing (the header omits the tag).
 */
function adaptPersistedTimeline(tl, toolCalls) {
  if (!Array.isArray(tl) || tl.length === 0) {
    return null;
  }
  try {
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    let callIdx = 0;
    const out = [];
    for (const e of tl) {
      if (!e || typeof e !== 'object') {
        continue;
      }
      if (e.type === 'text' || e.type === 'thinking') {
        out.push(e);
        continue;
      }
      if (e.type === 'tools' && Array.isArray(e.tools)) {
        for (const light of e.tools) {
          if (!light || typeof light !== 'object') {
            continue;
          }
          const cand = calls[callIdx];
          callIdx += 1;
          // Name guard: never attribute a duration/error to the wrong tool.
          const call =
            cand && (!light.name || !cand.name || cand.name === light.name) ? cand : null;
          const tool = { name: light.name || (call && call.name) || 'tool' };
          const params = light.paramsSummary || (call && call.paramsSummary) || '';
          if (params) {
            tool.input = String(params);
          }
          const status = light.status || (call && call.status) || '';
          if (status === 'error') {
            tool.result = { isError: true };
            if (call && call.error) {
              tool.result.error = String(call.error);
            }
          } else if (status) {
            tool.result = { success: true };
          }
          if (call && Number(call.durationMs) > 0) {
            tool.durationMs = Number(call.durationMs);
          }
          out.push({ type: 'tool', tool });
        }
        continue;
      }
      // Unknown entry types are skipped (forward-compatible fail-soft).
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function MessageBlock({ msg, expanded }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  if (msg.role === 'user') {
    // White-background box (默认开) so the user's OWN content stands apart from the
    // default-background output region; the input box itself stays transparent.
    if (userMsgWhiteBgEnabled()) {
      const cols = effectiveCols();
      const rows = buildUserMessageBox(msg.content, { cols });
      const bg = userMsgBgColor(); // 米白 by default — softer than pure white
      const fg = userMsgFgColor(); // truecolor near-black — high contrast, never gray
      const styleFor = (role) => {
        switch (role) {
          case 'marker':
            return { backgroundColor: bg, color: 'blue', bold: true };
          case 'pad':
            return { backgroundColor: bg };
          case 'text':
          default:
            return { backgroundColor: bg, color: fg, bold: true };
        }
      };
      return h(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        ...rows.map((row, ri) =>
          h(
            Box,
            { key: `u${ri}` },
            ...row.segments.map((seg, si) =>
              h(Text, { key: `s${si}`, ...styleFor(seg.role) }, seg.text)
            )
          )
        ),
        msg.imageCount > 0 ? h(Text, { color: 'blue' }, `📎×${msg.imageCount}`) : null
      );
    }
    // Legacy transparent echo — byte-identical when gated off. Same display cap
    // as the white-bg path so the perf guard holds in both layouts.
    return h(
      Box,
      { marginTop: 1 },
      h(Text, { bold: true, color: 'cyan' }, '❯ '),
      h(
        Text,
        { bold: true },
        collapseLongUserMessage(String(msg.content == null ? '' : msg.content), process.env)
      ),
      msg.imageCount > 0 ? h(Text, { color: 'blue' }, `  📎×${msg.imageCount}`) : null
    );
  }

  if (msg.role === 'assistant') {
    const children = [];
    const selfRender = !!msg.selfRender;
    const render = (text) =>
      renderMarkdown(normalizeCommitted(text, selfRender, !!msg.continuation), effectiveCols());
    // Live commits carry msg.timeline; RESTORED sessions may instead carry the
    // persisted msg._timeline light projection — adapt it to the same shape.
    // Neither present → legacy path, byte-identical (old-session compat).
    const timeline =
      Array.isArray(msg.timeline) && msg.timeline.length > 0
        ? msg.timeline
        : adaptPersistedTimeline(msg._timeline, msg._toolCalls);
    if (timeline && timeline.length > 0) {
      // 思考/工具组/回答三段之间恰一空行(仅相邻段都渲染时插入,绝不连续、绝不用横线)。
      const gapOn = sectionGapEnabled(process.env);
      const pushSection = (node) => {
        if (gapOn && children.length > 0) {
          children.push(h(Text, { key: `gap${children.length}` }, ' '));
        }
        children.push(node);
      };
      // Persistent record in REAL interleaved order: text segments and tool
      // steps exactly as they streamed. Consecutive tool steps are merged into a
      // single collapsible ProcessGroup (过程组). Within each phase (delimited by
      // tool runs) thinking is coalesced and the answer text is concatenated, so
      // a reasoning model that interleaves thinking mid-answer (text → thinking →
      // text) still renders the deliverable as ONE contiguous block instead of
      // being split by a folded "💭 思考" line ("displayed then hidden").
      const hasText = timeline.some((e) => e.type === 'text' && e.text);
      // Non-streaming adapter fallback: timeline carried only tools, the visible
      // answer came from result.reply → render msg.content as the leading text.
      if (!hasText && msg.content) {
        pushSection(h(Text, { key: 'content' }, render(msg.content)));
      }
      ProcessGroup.groupTimeline(timeline).forEach((e, i) => {
        if (e.type === 'text') {
          if (e.text) {
            pushSection(h(Text, { key: `t${i}` }, render(e.text)));
          }
        } else if (e.type === 'thinking') {
          // Thinking is preserved in scrollback, folded by default. Collapsed
          // shows a one-line summary; Ctrl+O expands every group + thinking.
          if (!e.text) {
            return;
          }
          const chars = String(e.text).replace(/\s+/g, '').length;
          // CC「Thought for Ns」:折叠/展开两态都用 timeline 条目的真实 durationMs
          // 显示思考时长(门控关或无时长 → 旧文案,逐字节回退)。
          if (expanded) {
            pushSection(
              h(
                Box,
                { key: `k${i}`, flexDirection: 'column' },
                h(
                  Text,
                  { color: 'cyan', dimColor: true },
                  buildThinkingHeader({ durationMs: e.durationMs })
                ),
                h(Text, { dimColor: true }, String(e.text).trim())
              )
            );
          } else {
            pushSection(
              h(
                Text,
                { key: `k${i}`, color: 'cyan', dimColor: true },
                buildThinkingSummary({ chars, durationMs: e.durationMs })
              )
            );
          }
        } else if (e.type === 'tools' && e.tools.length > 0) {
          pushSection(h(ProcessGroup, { key: `g${i}`, tools: e.tools, expanded }));
        }
      });
    } else {
      // Backward-compat path: messages without a timeline (legacy / restored).
      if (msg.content) {
        children.push(h(Text, { key: 'content' }, render(msg.content)));
      }
      if (msg.tools && msg.tools.length > 0) {
        children.push(h(ToolLines, { key: 'tools', tools: msg.tools, expanded }));
      }
    }
    if (children.length === 0) {
      return null;
    }
    // Continuation fragments (incremental mid-turn commits) render flush against
    // the previous fragment so a multi-stage turn reads as one contiguous block;
    // the first fragment of a turn keeps the top margin that separates turns.
    return h(Box, { flexDirection: 'column', marginTop: msg.continuation ? 0 : 1 }, ...children);
  }

  if (msg.role === 'error') {
    return h(Box, { marginTop: 1 }, h(Text, { color: 'red' }, '✗ 错误：' + msg.content));
  }

  if (msg.role === 'bash-command') {
    return h(
      Box,
      { marginTop: 1 },
      h(Text, { bold: true, color: 'magenta' }, '! '),
      h(Text, { bold: true }, msg.content)
    );
  }

  if (msg.role === 'bash-output') {
    const text = (msg.content || '').replace(/\n+$/, '');
    if (!text) {
      return h(Box, null, h(Text, { dimColor: true }, '（无输出）'));
    }
    // Claude Code "⎿" elbow (same as agent command output in ToolLines) so all
    // literal terminal output shares one visual language, distinct from AI prose.
    return h(
      Box,
      { flexDirection: 'column' },
      ...text
        .split('\n')
        .map((ln, j) =>
          h(
            Box,
            { key: j },
            h(Text, { dimColor: true }, j === 0 ? '⎿ ' : '  '),
            h(Text, { dimColor: true }, ln)
          )
        )
    );
  }

  if (msg.role === 'notice') {
    // Gateway status notices are collapsible: they carry { content, detail, gateway: true }
    // Collapsed state is encoded in msg.content._collapsed so <Static> can pick it up
    // when we swap content on toggle (Static doesn't re-render committed items).
    const isGateway =
      msg.content && typeof msg.content === 'object' && msg.content.gateway === true;
    if (isGateway && msg.content.detail) {
      const gw = msg.content;
      const summaryText =
        typeof gw.content === 'string' ? gw.content : String(gw.detail.split('\n')[0] || '');
      const detailLines = String(gw.detail).split('\n');
      const hiddenCount = detailLines.length - 1;
      if (hiddenCount <= 0) {
        return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '· ' + summaryText));
      }
      const collapsed = msg.content._collapsed !== false;
      if (collapsed) {
        return h(
          Box,
          { marginTop: 1 },
          h(Text, { dimColor: true }, '· '),
          h(Text, { dimColor: true, color: 'cyan' }, summaryText),
          h(Text, { dimColor: true }, `  (+${hiddenCount} 行 · 按 Ctrl+G 展开)`)
        );
      }
      return h(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        h(
          Text,
          { dimColor: true },
          '· ' + summaryText + `  (共 ${detailLines.length} 行 · 按 Ctrl+G 收起)`
        ),
        ...detailLines.slice(1).map((ln, i) => h(Text, { key: i, dimColor: true }, '  ' + ln))
      );
    }
    return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '· ' + msg.content));
  }

  // Turn-completion stats — CC-style dim one-liner (`✓ 1m30s · 3 工具 · 1.2k tokens`)
  // built by useQueryBridge from REAL backend state (wall-clock elapsed, the
  // backend's toolCallLog length, the reported tokenUsage). Display-only; never
  // fed back to the model. The whole content is precomposed by the turnStats leaf.
  if (msg.role === 'turn-stats') {
    if (!msg.content) {
      return null;
    }
    return h(Box, { marginTop: 0 }, h(Text, { dimColor: true }, msg.content));
  }

  // Permission decision — the user's approve/deny choice, kept in scrollback so
  // the history shows what was authorized.
  if (msg.role === 'decision') {
    const denied = msg.decision === 'deny';
    const discuss = msg.decision === 'discuss';
    const label = discuss
      ? '先一起讨论'
      : msg.decision === 'always'
        ? '已批准（始终允许）'
        : denied
          ? '已拒绝'
          : '已批准';
    const arg = msg.argSummary ? `(${msg.argSummary})` : '';
    const mark = discuss ? '✻ ' : denied ? '✗ ' : '✓ ';
    const color = discuss ? 'cyan' : denied ? 'yellow' : 'green';
    return h(
      Box,
      { marginTop: 1 },
      h(Text, { color }, mark + label + '：'),
      h(Text, { bold: true }, msg.tool || 'tool'),
      arg ? h(Text, { dimColor: true }, arg) : null
    );
  }

  // Expansion view — a fully-expanded copy of the most recent foldable turn.
  // App renders new expansions in its removable live layer because Ink's <Static>
  // never re-renders printed items; keeping this role renderer also preserves
  // compatibility with expansion records produced by older in-process paths.
  if (msg.role === 'expansion') {
    const children = [h(Text, { key: 'hdr', color: 'cyan', dimColor: true }, '⤷ 展开上一步详情')];
    const timeline = Array.isArray(msg.timeline) ? msg.timeline : null;
    if (timeline && timeline.length > 0) {
      ProcessGroup.groupTimeline(timeline).forEach((e, i) => {
        if (e.type === 'thinking' && e.text) {
          children.push(
            h(
              Box,
              { key: `k${i}`, flexDirection: 'column' },
              h(
                Text,
                { color: 'cyan', dimColor: true },
                buildThinkingHeader({ durationMs: e.durationMs })
              ),
              h(Text, { dimColor: true }, String(e.text).trim())
            )
          );
        } else if (e.type === 'tools' && e.tools && e.tools.length > 0) {
          children.push(h(ProcessGroup, { key: `g${i}`, tools: e.tools, expanded: true }));
        }
      });
    } else if (Array.isArray(msg.tools) && msg.tools.length > 0) {
      children.push(h(ToolLines, { key: 'tools', tools: msg.tools, expanded: true }));
    }
    if (children.length <= 1) {
      return null;
    }
    return h(Box, { marginTop: 1, flexDirection: 'column' }, ...children);
  }

  // AskUserQuestion record — the question(s) and the option(s) the user picked.
  if (msg.role === 'qa') {
    if (msg.cancelled) {
      return h(Box, { marginTop: 1 }, h(Text, { color: 'yellow' }, '✗ 已取消提问'));
    }
    const rows = [];
    (Array.isArray(msg.qa) ? msg.qa : []).forEach((item, i) => {
      rows.push(h(Text, { key: `q${i}`, color: 'cyan' }, '❓ ' + String(item.question || '')));
      rows.push(h(Text, { key: `a${i}` }, '   → ' + String(item.choice || '')));
    });
    if (rows.length === 0) {
      return null;
    }
    return h(Box, { marginTop: 1, flexDirection: 'column' }, ...rows);
  }

  return null;
}

// Memoized: committed messages never change after they land, so a new live
// chunk (new <Static> item, or a Transcript re-render) must not re-render
// existing rows. `msg` refs are stable (one object per committed message) and
// `expanded` is a primitive, so the default shallow compare is correct.
const MemoMessageBlock = React.memo(MessageBlock);

function Transcript({ messages }) {
  const { Box } = inkRuntime.get();
  const h = React.createElement;
  if (!messages || messages.length === 0) {
    return null;
  }
  return h(
    Box,
    { flexDirection: 'column' },
    ...messages.map((msg, i) => h(MemoMessageBlock, { key: i, msg }))
  );
}

Transcript.MessageBlock = MemoMessageBlock;
Transcript.buildUserMessageBox = buildUserMessageBox;
Transcript.adaptPersistedTimeline = adaptPersistedTimeline;
Transcript.userMsgWhiteBgEnabled = userMsgWhiteBgEnabled;
Transcript.userMsgBgColor = userMsgBgColor;
Transcript.userMsgFgColor = userMsgFgColor;
module.exports = Transcript;
