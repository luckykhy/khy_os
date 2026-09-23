'use strict';

/**
 * ccMessageProjection — CC 模式「live 区」的纯字符串行投影（单一真源）。
 *
 * 背景（为什么需要它）：
 *   终端原生拖选在鼠标追踪态下不可用 —— `press` 一进 stdin 就被 ink 读走，
 *   `return false` 物理上回不到终端（[DESIGN-ARCH-119] §二 缺陷 A）。参考实现
 *   （Claude Code 全屏模式）的做法是「不向终端要选择，自己画」：拖选 → 反色 →
 *   松手即复制。这需要一张「屏幕行 → 文本」的映射表，而 ink 不对外暴露渲染树。
 *
 * 为什么 legacy 的做法不能照抄：
 *   legacy `App.js` 的 `_mainContentLines` 把「整块 live 区」都交给那个 Viewport，
 *   所以 `屏幕行 == lines 下标` 天然成立（[DESIGN-ARCH-119] 的关键洞察）。
 *   CC 模式的主布局不是这样：消息区只是 live 区中间的一段，它上面有 CcLogo /
 *   AgentTree / 窗口化提示，里面有流式消息，下面有 CcMessageBar / CcToastContainer
 *   / CcStatusLine / CcPromptInput —— **六处高度可变**的兄弟节点。照抄
 *   `line = row + offset` 会随 AgentTree 展开、toast 数量变化而**静默错位**。
 *
 *   所以本模块投影的是**从屏幕第 0 行开始的整块 live 区**（与 legacy 同一不变式），
 *   上位组件拿到的坐标就是屏幕坐标，不需要再加偏移。
 *
 * 契约（与 scrollActions / selection / transcriptLines 同范式）：
 *   - 纯叶子：零 IO、绝不读 env、绝不触 React/ink、绝不抛、确定性；
 *   - 返回值 `{ lines, anchors, truncated }`：
 *       lines[i]   = 屏幕第 i 行的**纯文本**（无 ANSI；软换行已按宽度折好）
 *       anchors[i] = 该行对应的语义锚点（见 Anchor）
 *       truncated  = 消息已窗口化（首行是「⋯ 已收起上方 N 条消息」那条提示）
 *   - **不变式：`row === index`**（严格 1:1）。这是选择模型能成立的全部前提。
 *
 * Anchor（软换行元数据，补 [DESIGN-ARCH-119] §六 不做的事 4 的欠账）：
 *   `{ msgId, start, end, soft }`
 *   - `start`/`end` 是本行在**该消息的逻辑行**里对应的 UTF-16 区间；
 *   - `soft === true` 表示「本行结尾没有真实换行符，下一行是同一逻辑行的续行」
 *     （即 ink 的软换行）。抽取文本时据此决定行间连 `''` 还是 `'\n'` ——
 *     这正是 legacy 版「跨软换行复制会多一个硬 \n」的修法。
 *   - 结构行（Logo / Toast / 状态栏 / 输入框…）→ `null`。
 *
 * 与 ink 的一致性（C3 方案的核心）：
 *   运行时用手写投影（零 ink 开销），**测试用 `renderToString` 当 oracle 对拍**
 *   （见 tests/cli/tui/ccMessageProjection.oracle.test.js）——正确性由 ink 背书，
 *   性能不付 ink 的代价。任何一条视觉规则的改动都必须同时改这里和 oracle 测试，
 *   两者漂移会被测试立刻抓住。
 *
 * 对应关系（file:line，改动组件时请同步本文件）：
 *   CcLogo            ink-components/CcLogo.js:22（两行都是 `<Text color=…>`）
 *   AgentTree         ink-components/AgentTree.js:42（折叠语义 :61 / :65）
 *   CcAssistantMessage ink-components/CcAssistantMessage.js（● 在 width:1/flexShrink:0
 *                     的 Box 里 —— 固定 1 列；正文 `<Text>{' ' + line}</Text>`）
 *   CcStreamingMessage ink-components/CcAssistantMessage.js（● + 正文 + 1 列光标位）
 *   CcMessageBar      tui/components/CcMessageBar.js:36（圆角边框 + paddingX）
 *   CcToastContainer  tui/components/CcToast.js:43（每 toast 恰 1 行）
 *   CcStatusLine      ink-components/CcStatusLine.js:68（分支逻辑 :102-168）
 *   CcPromptInput     ink-components/CcPromptInput.js:430-517（wrap/maxRows/光标）
 *   CcApp 主布局      ink-components/CcApp.js:560-645
 */

const path = require('path');
const { BRAND } = require('../utils/ccBrand');
const { STATUS_SEPARATOR, inputRenderRows, inputWindow } = require('../utils/ccLayout');
const { fitBorder, visWidth, wrapCell } = require('../wrapCell');
const { applyScroll } = require('../scrollActions');
const { normalizeSelection } = require('../selection');

// ── 折行：必须与 ink 用同一个算法 ──────────────────────────────────────────

/**
 * ink 折的是**词**（`wrapAnsi(text, width, {trim:false, hard:true})`，见
 * node_modules/ink/build/wrap-text.js），不是码点。两者的差别不是细节而是**语义**：
 * 一个超过行宽的长词（URL、base64、连续字符）在 wrapAnsi 下会被**整体挪到下一行**
 * （只有词本身超过整行宽时才硬切），而按码点折会把它就地切断。
 *
 * 投影若用按码点折（wrapCell，仓库其它地方的正确真源 —— 但那些地方不参与
 * 屏幕行↔文本映射），行内容就会与屏幕整体错开一行，用户拖选到的不是他看到的
 * 那段。所以这里**必须**用 wrap-ansi：它是 ink 自己的依赖，版本同源。
 *
 * 解析不到（依赖被裁掉）时退回 wrapCell 并降级：宁可折行位置略有偏差，
 * 也不能让本模块不可用。
 */
let _wrapAnsi;
function waFn() {
  if (_wrapAnsi === undefined) {
    try {
      const m = require(require.resolve('wrap-ansi', { paths: [path.join(__dirname, '..')] }));
      _wrapAnsi = typeof m === 'function' ? m : m.default;
      if (typeof _wrapAnsi !== 'function') {
        _wrapAnsi = false;
      }
    } catch {
      _wrapAnsi = false;
    }
  }
  return _wrapAnsi || null;
}

/** 按 ink 的规则折行；返回显示行数组。 */
function inkWrap(text, width) {
  const fn = waFn();
  if (fn) {
    try {
      return fn(String(text == null ? '' : text), Math.max(1, Math.floor(Number(width) || 1)), {
        trim: false,
        hard: true,
      }).split('\n');
    } catch {
      /* fall through */
    }
  }
  return wrapCell(text, width);
}

// ── 常量：与组件逐字对齐（改了组件就要改这里）──────────────────────────────

/** CcLogo：Box{ marginY:1 } → 上 1 空行 + 标题 + 副标题 + 下 1 空行。 */
const LOGO_MARGIN_ROWS = 1;

/** CcAssistantMessage：首行前缀「● 」，续行「  」（各 2 列，见 :35-38）。 */
const ASSIST_HEAD_PREFIX = '●';
const ASSIST_CONT_PREFIX = '  ';
const ASSIST_PREFIX_W = 2;

/** CcStreamingMessage：单行「● {text}│」，marginTop 1（:61-68）。 */
const STREAM_CURSOR = '│';

/** CcToast：`{icon} {message}`，容器无 marginY（CcToast.js:62-67）。 */
const TOAST_ICONS = Object.freeze({ success: '✓', error: '✗', warning: '⚠', info: 'ℹ' });

/** CcPromptInput：提示符 / 续行前缀 / 标记宽度（CcPromptInput.js:47-49）。 */
const PROMPT_PREFIX = '> ';
const PROMPT_CONT = '  ';
const PROMPT_MARKER_W = 2;

/** CcPromptInput 的占位符文案（:40-45）。 */
const PLACEHOLDERS = Object.freeze({
  default: 'Send a message...',
  shell: 'Run a command...',
  busy: 'AI is thinking...',
});

/** CcStreamingMessage 在 CcApp 里被写死的文案（CcApp.js:593）。 */
const STREAMING_TEXT = '思考中...';

/** 窗口化提示（CcApp.js:576-581）。 */
function windowHint(hidden) {
  return `⋯ 已收起上方 ${hidden} 条消息（Ctrl+O 查看完整转录）`;
}

/**
 * 模式映射与状态栏片段：直接取 ../utils/ccStatusBar（**零 ink 依赖**的纯模块，
 * 本叶子因此仍可在未 loadInk() 的纯 Node 环境下被 require）。
 *
 * 此前这里是 `CcStatusLine` 的**逐字副本**，注释说「副本的漂移风险由 oracle
 * 测试兜住」—— 事实证明兜不住：副本只抄了 icon/label，宽度决策那段则整个没抄，
 * 于是账本认为状态栏 1 行、画出来 2 行（BUG-82）。现在两边共用同一函数，
 * 漂移在结构上不可能发生。
 */
const {
  buildStatusSegments,
  PROFILE_TO_SIMPLE_MODE,
  SIMPLE_MODE_DISPLAY,
} = require('../utils/ccStatusBar');

// ── 内部工具 ────────────────────────────────────────────────────────────────

/** 安全取字符串（null/undefined → ''，绝不抛）。 */
function _s(v) {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** 有限正整数化；非法 → fallback。 */
function _pos(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 取行（越界 → ''）。 */
function _at(arr, i) {
  if (!Array.isArray(arr)) {
    return '';
  }
  const v = arr[i];
  return typeof v === 'string' ? v : '';
}

function _truncate(s, max) {
  const t = _s(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t;
}

/**
 * 复刻 ink 的行尾处理（node_modules/ink/build/output.js:174）：
 *   `styledCharsToString(line).trimEnd()` —— **每一行**都去尾部空白。
 *
 * 但有个反直觉的坑（实测，见 oracle 用例「空会话」）：`trimEnd` 作用在**带 ANSI
 * 的串**上，一旦尾部空格后面还跟着样式重置序列（`\x1b[39m`），它就**不是**尾部
 * 空白，`trimEnd` 什么也去不掉 —— 空格存活。所以：
 *
 *   行尾空格是**无样式**的 → 被吃掉（例：消息正文 `' ' + line` 是裸 Text）
 *   行尾空格是**有样式**的 → 存活（例：CcPromptInput 的 `> ` 前缀，color #A0A0A0）
 *
 * 因此本函数要一个「受样式保护的前缀长度」：只有前缀之后的裸尾巴才参与 trim。
 * 实测对照：`<Text>{'> '}</Text>` → `'>'`；CcPromptInput 的首行 → `'> '`。
 *
 * @param {string} text
 * @param {number} [styledLen] 行首受样式保护的字符数（这些字符的尾部空白不会被吃掉）。
 *   传 `ALL_STYLED`（负数）表示**整行都带样式**，一个字符都不 trim
 *   （例：CcLogo 的标题/副标题整条都是 `<Text color=…>`）。
 */
function trimLikeInk(text, styledLen) {
  const s = _s(text);
  const n = Number(styledLen);
  if (Number.isFinite(n) && n < 0) {
    return s;
  }
  const cut = Math.max(0, Math.floor(n || 0));
  if (cut === 0) {
    return s.replace(/\s+$/, '');
  }
  if (s.length <= cut) {
    return s;
  }
  return s.slice(0, cut) + s.slice(cut).replace(/\s+$/, '');
}

/** `trimLikeInk` 的哨兵：整行都带样式，不 trim。 */
const ALL_STYLED = -1;

/** 按**显示宽度**右填充到 `width` 列（CJK=2，与 visWidth 同一把尺子）。 */
function padEnd(s, width) {
  const t = _s(s);
  const gap = Math.max(0, Math.floor(Number(width) || 0) - visWidth(t));
  return gap > 0 ? t + ' '.repeat(gap) : t;
}

// ── 行累加器 ────────────────────────────────────────────────────────────────

/**
 * 行累加器：同时维护 `lines`（纯文本）与 `anchors`（软换行元数据）。
 * 两者长度恒等 —— 这是 `row === index` 的构造性保证（不是靠约定）。
 */
function createBuilder() {
  const lines = [];
  const anchors = [];
  /** msgId → 该消息的**原始文本**（复制取词的唯一真源，见 extractByAnchors）。 */
  const msgTexts = new Map();
  return {
    lines,
    anchors,
    msgTexts,
    /** 结构行（无消息归属）。`styledLen` 见 trimLikeInk。 */
    raw(text, styledLen) {
      lines.push(trimLikeInk(text, styledLen));
      anchors.push(null);
    },
    /** 空行。 */
    blank() {
      lines.push('');
      anchors.push(null);
    },
    /** 消息行：`seg` 已在消息逻辑行内定位到 UTF-16 区间。 */
    msg(text, msgId, start, end, soft, styledLen) {
      lines.push(trimLikeInk(text, styledLen));
      anchors.push({ msgId, start: start >>> 0, end: end >>> 0, soft: !!soft });
    },
  };
}

/**
 * 把一条消息折成显示行并写入 builder。
 *
 * **这是全模块最容易静默错位的地方**，规则由 oracle 实测钉死（不是推理）：
 *
 * assistant 首逻辑行 = `Box{width:1,flexShrink:0}(●)` + `Text(' ' + line)`
 * （CcAssistantMessage.js —— `●` 固定占 1 列，**不参与收缩**）。所以：
 *
 *   正文折行宽度恒为 `cols - 1`，`●` 永远在第 0 列可见；
 *   首行 = `●` + seg0，软续行 = ` ` + seg_i（对齐 ● 后一列）。
 *
 * 为什么必须固定 1 列：原先 `●` 与正文是**裸兄弟** Text，正文一长到接近
 * 终端宽度，yoga 就把 `●` 挤成 0 列 —— `●` 消失、且消息块凭空多出 1~2 个
 * **条数不可预测**的空行。那种布局下投影的行号必然与屏幕错位，拖选复制就
 * 会选到相邻行。故在组件侧把这个不确定性消掉（详见 CcAssistantMessage 文件头）。
 *
 * 非首逻辑行 / user 消息都是**单个** `<Text>`（无兄弟），无收缩可言：
 *   直接 `inkWrap(prefix + line, cols)`，续段从第 0 列开始。
 *
 * @param {object} b builder
 * @param {string} text 原文（可含 \n）
 * @param {{isUser?:boolean, width?:number, msgId?:*}} o
 */
function emitMessageRows(b, text, o) {
  const width = _pos(o.width, 80);
  const msgId = o.msgId;
  const isMsg = msgId !== undefined && msgId !== null;
  const isUser = !!o.isUser;
  const raw = _s(text);

  const logical = raw.split('\n');
  let offset = 0; // 在 raw 里的 UTF-16 起点（不含 '\n'）
  for (let li = 0; li < logical.length; li++) {
    const line = logical[li];
    let rows; // 该逻辑行的显示行（已含前缀）
    let rowHasDot = false;

    if (isUser) {
      rows = inkWrap(line, width);
    } else if (li === 0) {
      // ── 首逻辑行：`●` 固定 1 列，正文在它右边折行 ──
      const bodyRows = inkWrap(' ' + line, width - ASSIST_HEAD_PREFIX.length);
      rows = bodyRows.map((r, si) =>
        si === 0 ? ASSIST_HEAD_PREFIX + r : ' '.repeat(ASSIST_HEAD_PREFIX.length) + r
      );
      rowHasDot = true;
    } else {
      rows = inkWrap(ASSIST_CONT_PREFIX + line, width);
    }

    // 段 → 原文区间（wrapAnsi 的段是原串的连续切片，用「游标 + indexOf」定位，
    // 比纯累加稳：行尾空格、词间空格被重排时仍能命中）。
    let cursor = 0;
    for (let si = 0; si < rows.length; si++) {
      const row = rows[si];
      // 去掉前缀，取本行真正来自 `line` 的部分
      const bodyPart = si === 0 && rowHasDot ? row.slice(ASSIST_HEAD_PREFIX.length + 1) : si === 0 && !isUser && li > 0 ? row.slice(ASSIST_CONT_PREFIX.length) : row;
      const trimmed = bodyPart.replace(/^\s+/, '');
      const lead = bodyPart.length - trimmed.length;
      let at = line.indexOf(trimmed, cursor);
      if (at < 0) {
        at = cursor;
      }
      const start = offset + at;
      const end = start + trimmed.length;
      cursor = at + trimmed.length;
      const soft = si !== rows.length - 1;
      // `●` 带 color（CcAssistantMessage.js:35）→ 它自己那一列受样式保护，
      // 之后的裸正文尾部空白才被 ink 吃掉。没画 ● 时整行都是裸文本。
      const styledLen = rowHasDot ? ASSIST_HEAD_PREFIX.length : 0;
      if (isMsg) {
        b.msg(row, msgId, start, end, soft, styledLen);
      } else {
        b.raw(row, styledLen);
      }
    }
    offset += line.length + 1; // +1 = '\n'
  }
}

/** 兼容旧名（流式行等仍走同一条路径）。 */
function emitPrefixed(b, text, o) {
  return emitMessageRows(b, text, {
    width: o.width,
    msgId: o.msgId,
    isUser: o.prefixFor === userPrefix,
  });
}

/** user 消息的标记（CcApp.js:584-586：单个 `<Text>`，无前缀）。 */
function userPrefix() {
  return '';
}

// ── 各区块投影 ──────────────────────────────────────────────────────────────

/** 居中（CcLogo 的 `alignItems:'center'`），不缩进行。 */
function centerIn(text, width) {
  const w = visWidth(text);
  const pad = Math.max(0, Math.floor((Math.max(0, width) - w) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * 居中一段**可能折行**的文本（CcLogo 的 `alignItems:'center'`）。
 *
 * 关键是 yoga 的居中对的是**整个文本节点**，不是逐行：节点宽度取折行后的
 * **最宽行**（ink `measureTextNode` → `measureText(wrappedText)`），再按它算左边距，
 * 然后每一行都从同一个 x 起写。窄终端下（cols < 副标题长度）两者差别就是一整行，
 * 逐行居中会直接错位一条 —— oracle 在 cols=20 抓到过。
 */
function centerWrapped(b, text, width, styled) {
  const segs = inkWrap(text, width);
  let nodeW = 0;
  for (const seg of segs) {
    const w = visWidth(seg);
    if (w > nodeW) {
      nodeW = w;
    }
  }
  const pad = ' '.repeat(Math.max(0, Math.floor((Math.max(0, width) - nodeW) / 2)));
  for (const seg of segs) {
    // Logo 两行都是 `<Text color=…>`：整行带样式 ⇒ 折行留下的尾空格不会被吃掉。
    b.raw(pad + seg, styled ? ALL_STYLED : 0);
  }
}

/**
 * CcLogo（CcLogo.js:22）。
 * 外层 Box 是 `alignItems:'center'` ⇒ 标题/副标题**居中**，不是左对齐。
 */
function emitLogo(b, width, chrome) {
  // BUG-77b：极短终端上账本会让横幅降级（去 tagline / 整块去掉）或直接不画。
  // 投影必须跟着降级，否则拖选的行↔文本映射整体错位。缺省 = 完整横幅。
  if (chrome && chrome.banner === false) {
    return;
  }
  const subtitle = !chrome || chrome.subtitle !== false;
  for (let i = 0; i < LOGO_MARGIN_ROWS; i++) {
    b.blank();
  }
  centerWrapped(b, BRAND.logo + ' ' + BRAND.name, width, true);
  if (subtitle) {
    centerWrapped(b, BRAND.tagline, width, true);
  }
  for (let i = 0; i < LOGO_MARGIN_ROWS; i++) {
    b.blank();
  }
}

/**
 * AgentTree（AgentTree.js:42）。
 * 折叠（!live && !expanded）→ **只有一行 header**，绝不吐子行（:61/:65）。
 */
function emitAgentTree(b, agents, expanded, live) {
  const list = Array.isArray(agents) ? agents : [];
  if (list.length === 0) {
    return;
  }
  let view = null;
  try {
    view = require('../../agentTreeView');
  } catch {
    view = null;
  }
  if (!view || typeof view.buildAgentHeader !== 'function') {
    return; // 叶子不可用 → 不吐行（宁可少一行也不吐错一行）
  }
  let header = null;
  let rows = null;
  try {
    header = view.buildAgentHeader(list);
    if (live || expanded) {
      rows = view.buildAgentTreeRows(list);
    }
  } catch {
    return;
  }
  if (!header || typeof header !== 'object') {
    return;
  }
  const headIcon = header.allDone ? '✓' : header.dot;
  const hint = !live && !expanded ? '  (Ctrl+O 展开)' : '';
  b.raw(_s(headIcon) + ' ' + _s(header.label) + hint);
  if (!Array.isArray(rows)) {
    return;
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    // 每行都是 Box{ marginLeft: 2 } → 前置 2 空格。
    if (row.kind === 'agent') {
      const stats = Array.isArray(row.stats) && row.stats.length > 0 ? ` · ${row.stats.join(' · ')}` : '';
      b.raw('  ' + _s(row.branch) + ' ' + _s(row.name) + stats);
    } else if (row.kind === 'preview') {
      b.raw('  ' + _s(row.cont) + '   ' + _s(row.text));
    } else {
      b.raw('  ' + _s(row.cont) + ' └ ' + _s(row.text));
    }
  }
}

/** 已提交消息：user 单个 Text 直折，assistant 首逻辑行走 ● 挤压规则。 */
function emitMessages(b, messages, width, msgGap = true) {
  // 防御：非数组一律当空（绝不抛 —— 本模块是纯叶子，炸了会拖垮整帧渲染）。
  if (!Array.isArray(messages)) {
    return;
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    // marginTop: 1 —— 每条消息前的空行（CcApp.js:584 / CcAssistantMessage.js:30）。
    // 短终端上这一行由 chromeBudget.ccGapPlan 收回（BUG-91），投影必须跟着收，
    // 否则行号与画面差一行，拖选就会选错。
    if (msgGap) b.blank();
    const text = _s(msg.text);
    // CcApp.js:582-590 的三元只有两支 ⇒ **非 user 一律 assistant 形状**
    // （未知角色也走 CcAssistantMessage，这里必须复刻，否则行号错位）。
    const isUser = msg.role === 'user';
    // 登记原文：复制取词走锚点，而不是屏幕行切片（见 extractByAnchors）。
    if (msg.id !== undefined && msg.id !== null) {
      b.msgTexts.set(msg.id, text);
    }
    emitMessageRows(b, text, { width, msgId: msg.id, isUser });
  }
}

/**
 * CcMessageBar（CcMessageBar.js:36）：`borderStyle:'round'` + `paddingX:1`
 * ⇒ 上边框 1 行 + 内容 1 行 + 下边框 1 行 = **3 行**（单行消息）。
 * 内容行恰为 `width - 4` 列内容区（paddingX 1 + 左右边框各 1）。
 */
function emitMessageBar(b, messageBar, width) {
  if (!messageBar || !messageBar.message) {
    return;
  }
  const iconByType = { error: '✗', warning: '⚠', info: 'ℹ', success: '✓' };
  const body =
    _s(iconByType[messageBar.type] || iconByType.info) +
    ' ' +
    _s(messageBar.message) +
    (messageBar.suggestion ? ' — ' + _s(messageBar.suggestion) : '') +
    ' [×]'; // dismissible 默认 true（CcMessageBar.js:60）
  b.raw(fitBorder(width, { left: '╭', right: '╮' }));
  // 内容区 = width − 左右边框各 1 − paddingX 各 1；短内容右侧补空格到满宽。
  const inner = Math.max(1, width - 4);
  const segs = wrapCell(body, inner);
  for (const seg of segs) {
    b.raw('│ ' + padEnd(seg, inner) + ' │');
  }
  b.raw(fitBorder(width, { left: '╰', right: '╯' }));
}

/** CcToastContainer（CcToast.js:43）：每个 toast 恰 1 行。 */
function emitToasts(b, toasts) {
  const list = Array.isArray(toasts) ? toasts : [];
  for (const t of list) {
    if (!t || !t.message) {
      continue; // CcToast 在 !message 时 return null（:55）
    }
    b.raw(_s(TOAST_ICONS[t.type] || TOAST_ICONS.info) + ' ' + _s(t.message));
  }
}

/**
 * CcStatusLine（CcStatusLine.js:68）。分隔符是 `' ' + sep + ' '` 的形状：
 * Box 首个子节点是 `' '`（:192），之后每段之间插 STATUS_SEPARATOR（:181）。
 */
function emitStatusLine(b, o) {
  // 片段选择/丢段全部交给 ccStatusBar —— 与 <CcStatusLine> 同一个函数，
  // 所以「账本 1 行」与「画 1 行」不可能分叉。
  const segments = buildStatusSegments(o);
  b.raw(' ' + segments.map((s) => s.text).join(STATUS_SEPARATOR));
}

/**
 * CcPromptInput（CcPromptInput.js:430-517）：逐行折 + 光标 + 高度窗口化。
 *
 * 前缀是独立的 `<Text>` 兄弟节点，所以折行宽度是 `cols - 2 - 2`（:431）。
 * 光标插在该 segment 内的**真实列**（`caret.col - segStart`，与组件同裁），
 * 因此整行仍只比文本多占 1 列；溢出量与光标落点无关 —— 与 ink 的自动换行一致
 * （oracle 可见）。
 */
function emitPromptInput(b, o) {
  const cols = _pos(o.cols, 80);
  const value = _s(o.value);
  const avail = Math.max(1, cols - PROMPT_MARKER_W - 2);
  const busy = !!o.busy;
  const showPlaceholder = value.length === 0 && !busy;

  const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
  const caret = caretToWrapped(value, offset, cols, avail);

  /** 构建渲染行（纯文本 + 是否含光标）。与组件同构。 */
  const renderRows = [];
  const logical = value.split('\n');
  // 与 CcPromptInput 同步：空缓冲区不画内容行（否则会多出一行只有 '>' 前缀的空壳，
  // 与下面 placeholder/busy 行的 '>' 叠成两行）。账本必须与画面同裁，故此处一并跳过。
  for (let li = 0; value.length > 0 && li < logical.length; li++) {
    const segs = wrapLine(logical[li], avail);
    for (let si = 0; si < segs.length; si++) {
      const isFirst = li === 0 && si === 0;
      const hasCaret = li === caret.line && si === caret.seg && !showPlaceholder && !busy;
      const segText = segs[si].text;
      // BUG-99: place the caret at its true column WITHIN the segment, mirroring
      // CcPromptInput. Pinning it to the segment end desynced ledger vs paint: the
      // component drew the block at the edit point while the projection billed it
      // after the row's last char → selection row/col mismatch. Row width is
      // unchanged (before + '│' + after == segText + 1 col), so the documented
      // +1 wrap-boundary overflow is byte-identical; byte-identical outright when
      // the caret is already at the segment end (normal append typing).
      let body = segText;
      if (hasCaret) {
        const inSeg = Math.max(0, Math.min(caret.col - segs[si].start, segText.length));
        body = segText.slice(0, inSeg) + '│' + segText.slice(inSeg);
      }
      renderRows.push({ text: (isFirst ? PROMPT_PREFIX : PROMPT_CONT) + body, caret: hasCaret });
    }
  }
  if (showPlaceholder) {
    renderRows.push({ text: PROMPT_PREFIX + PLACEHOLDERS.default });
  }
  if (busy) {
    renderRows.push({ text: PROMPT_PREFIX + PLACEHOLDERS.busy });
  }

  // 高度窗口化：上限**就是**宿主传下来的 maxRows（= ccLayout.inputMaxHeight）。
  // 这里原本抄了组件的旧算式 `min(maxRows, floor(rows × 0.3))` —— 组件已按 BUG-81
  // 改成只信 maxRows，投影再留第二份公式就会在「账本给的行数 ≠ rows×0.3」时
  // 与画面对不上（拖选行号整体错位）。现在两边同调 ccLayout.inputRenderRows。
  // BUG-84 把整段窗口算式（含省略号占的那 1–2 行）收进 ccLayout.inputWindow：
  // 组件此前是「取满 maxRenderRows 再追加省略号」，投影抄的也是这个错姿势，
  // 于是账本 N 行 / 画面 N+2 行。两边现在共用同一个 start/end/above/below。
  const maxRenderRows = inputRenderRows(o.maxRows);

  let visible = renderRows;
  if (renderRows.length > maxRenderRows) {
    let caretRowIdx = renderRows.findIndex((r) => r.caret === true);
    if (caretRowIdx < 0) {
      caretRowIdx = renderRows.length - 1;
    }
    const win = inputWindow(renderRows.length, maxRenderRows, caretRowIdx);
    visible = [];
    if (win.above) {
      visible.push({ text: `⋯ (${win.start} lines above)` });
    }
    visible.push(...renderRows.slice(win.start, win.end));
    if (win.below) {
      visible.push({ text: `⋯ (${renderRows.length - win.end} lines below)` });
    }
  }
  for (const r of visible) {
    // 前缀 `> ` 是带 color 的独立 Text（CcPromptInput.js:192-194）→ 它尾部那个
    // 空格被 ANSI 重置序列挡住，`trimEnd` 吃不掉。故 styledLen = 2。
    const styledLen = r.text.startsWith(PROMPT_PREFIX) ? PROMPT_MARKER_W : 0;
    b.raw(r.text, styledLen);
  }
}

// ── 输入框的宽度算术（CcPromptInput.js:110-167 的逐字复刻）────────────────

/** 显示宽度：优先 wrapCell.visWidth（CJK=2），保证与消息区同一把尺子。 */
function _dw(s) {
  return visWidth(s);
}

/** 按显示宽度折行（CcPromptInput.wrapLine，:110）。 */
function wrapLine(line, avail) {
  const cap = Math.max(1, avail | 0);
  if (line === '') {
    return [{ text: '', start: 0, end: 0 }];
  }
  const segs = [];
  let segStart = 0;
  let segW = 0;
  let idx = 0;
  for (const ch of line) {
    const w = _dw(ch);
    if (segW + w > cap && idx > segStart) {
      segs.push({ text: line.slice(segStart, idx), start: segStart, end: idx });
      segStart = idx;
      segW = 0;
    }
    segW += w;
    idx += ch.length;
  }
  segs.push({ text: line.slice(segStart, idx), start: segStart, end: idx });
  return segs;
}

/** 光标在折行后的位置（CcPromptInput.caretToWrapped，:132）。 */
function caretToWrapped(value, offset, cols, avail) {
  const lines = value.split('\n');
  let lineStart = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineEnd = lineStart + line.length;
    const isLastLine = li === lines.length - 1;
    if (offset <= lineEnd || isLastLine) {
      const caretCol = Math.min(offset - lineStart, line.length);
      const segs = wrapLine(line, avail);
      let segIdx = segs.length - 1;
      for (let s = 0; s < segs.length; s++) {
        if (caretCol < segs[s].end || (caretCol === segs[s].end && s === segs.length - 1)) {
          segIdx = s;
          break;
        }
      }
      return { line: li, seg: segIdx, col: caretCol, segStart: (segs[segIdx] || {}).start || 0 };
    }
    lineStart = lineEnd + 1;
  }
  return { line: lines.length - 1, seg: 0, col: 0, segStart: 0 };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把 CC 模式 live 区投影为纯文本行数组 + 软换行锚点。
 *
 * @param {object} scene 见下方字段；任何字段缺失/非法都退化为「空/不吐行」，绝不抛。
 * @param {number} [scene.cols=80] 终端列数（必须等于**实际渲染列宽**）
 * @param {number} [scene.rows=24] 终端行数（仅输入框窗口化会用到 stdout.rows 口径）
 * @param {number} [scene.padToRows=0] >0 时在消息区尾部补空行到该行数（复刻
 *       消息区 `flexGrow:1` 吃掉的多余空间；不传 = 按自然高度，用于单测/oracle）
 * @param {Array}  [scene.messages] 已窗口化的消息（`{id, role, text}`）
 * @param {number} [scene.hiddenCount=0] 被窗口化掉的消息条数（>0 时吐提示行）
 * @param {{banner?:boolean, subtitle?:boolean, hint?:boolean}} [scene.chrome]
 *   BUG-77b：chromeBudget.ccChromePlan 在短终端上选中的那一档（横幅整块 /
 *   只去 tagline / 折叠提示行的有无）。缺省 = 全画，与旧行为逐字节一致。
 * @param {Array}  [scene.subAgents] 并行子 agent
 * @param {boolean}[scene.agentTreeExpanded]
 * @param {boolean}[scene.busy] 是否有流式回复
 * @param {object} [scene.messageBar]
 * @param {Array}  [scene.toasts]
 * @param {object} [scene.status] 状态栏已格式化好的片段
 * @param {object} [scene.prompt] 输入框状态 `{value, offset, busy, maxRows}`
 * @returns {{lines:string[], anchors:Array, truncated:boolean}}
 */
function projectCcScene(scene) {
  const s = scene && typeof scene === 'object' ? scene : {};
  const cols = _pos(s.cols, 80);
  const b = createBuilder();
  const hidden = Math.max(0, Math.floor(Number(s.hiddenCount) || 0));
  const chrome = s.chrome && typeof s.chrome === 'object' ? s.chrome : {};

  emitLogo(b, cols, chrome);
  emitAgentTree(b, s.subAgents, !!s.agentTreeExpanded, !!s.busy);
  if (hidden > 0 && chrome.hint !== false) {
    b.raw(windowHint(hidden));
  }
  // ── 视口区间：这一段交给 <Viewport lines=…> 渲染（[DESIGN-ARCH-124] 方案 A）──
  // 之上（Logo / AgentTree / 窗口化提示）与之下（流式行 / 状态栏 / 输入框）仍是组件，
  // 只有「已提交消息」这一段走投影 —— 视觉损失≈0（正文本来就是裸 `<Text>`）。
  const msgStart = b.lines.length;
  emitMessages(b, s.messages, cols, chrome.msgGap !== false);
  const msgEnd = b.lines.length;
  if (s.busy) {
    // CcStreamingMessage：marginTop 1 + 单行「● 思考中...│」。
    // 光标是可条件 null 的兄弟节点（:65-67），闪烁时这一行少一列 —— 投影恒按
    // 「有光标」记（复制取的是文本；少一列只会让拖选在行尾空一格，不影响行号）。
    if (chrome.busyGap !== false) b.blank();
    const sid = s.streamingId !== undefined ? s.streamingId : '__streaming__';
    b.msgTexts.set(sid, STREAMING_TEXT);
    emitMessageRows(b, STREAMING_TEXT + STREAM_CURSOR, {
      width: cols,
      msgId: sid,
      isUser: false,
    });
  }
  emitMessageBar(b, s.messageBar, cols);
  emitToasts(b, s.toasts);
  emitStatusLine(b, Object.assign({ cols: cols }, s.status));
  emitPromptInput(b, Object.assign({ cols: cols, rows: s.rows }, s.prompt));

  // ── padToRows：调用方**显式**要求补白时才补 ──────────────────────────────
  // ⚠ 上面那段「消息区 flexGrow:1 会自动补白」的旧注释是**错的，已被实测推翻**
  // （ink 6.8.0）：`render()` 的根容器没有显式 `height`（ink.js 里只有
  // isFullscreen 检测会读 stdout.rows，从不给 yoga 根设高），yoga 因此按**内容**
  // 定高 —— 没有剩余空间可分配，`flexGrow:1` **一行为零**。
  //   探针（3 节点列，中间 Box flexGrow:1）：无根 height → 3 行；根 height=10
  //   → 10 行且多出来的 6 行落在 flexGrow 那个 Box 里。
  // ⇒ CC 主布局的根 Box 没有 height，**帧高就是内容高**，`padToRows` 必须不传。
  //   传了 rows 会凭空多出十几行，拖到底部全选到空气。
  //
  // 参数保留是为了「根容器确实有显式 height」的布局（例如将来 CcApp 根 Box 固定
  // 成终端高度）。那种情况下补进去的行属于 Viewport ⇒ 计入 viewport 区间。
  // 故意**不**复用 `rows`：后者是输入框窗口化要的 `process.stdout.rows` 口径，
  // 语义不同；隐式拿它来补白会让「只想算自然高度」的调用方（oracle 对拍、单测）
  // 莫名其妙多出十几行。补白是渲染高度的显式诉求，就得显式传。
  const want = Math.max(0, Math.floor(Number(s.padToRows) || 0));
  const free = want > 0 ? Math.max(0, want - b.lines.length) : 0;
  if (free > 0) {
    for (let i = 0; i < free; i++) {
      b.lines.splice(msgEnd + i, 0, '');
      b.anchors.splice(msgEnd + i, 0, null);
    }
  }

  return {
    lines: b.lines,
    anchors: b.anchors,
    msgTexts: b.msgTexts,
    truncated: hidden > 0,
    /**
     * 交给 <Viewport> 渲染的那一段（半开区间）。外面 Rows 的 `row === index`
     * 不变式因此覆盖到全屏，而不只是消息区。
     */
    spans: {
      viewport: { start: msgStart, end: msgEnd + free },
      messages: { start: msgStart, end: msgEnd },
    },
  };
}

// ── 抽取（选区 → 原文）──────────────────────────────────────────────────────

/**
 * 屏幕列 → 文本内 UTF-16 偏移（按**显示宽度**换算，CJK 占 2 列）。
 *
 * 落点在一个宽字符的**中间**列（比如 CJK 的第 1 列）时返回该字符的**起点**
 * —— 拖过一半就算选中，与主流编辑器一致。越界 → 行尾。
 *
 * @param {string} text
 * @param {number} col 0-based 显示列
 * @returns {number} UTF-16 偏移
 */
function colToOffset(text, col) {
  const t = _s(text);
  const c = Number(col);
  if (!Number.isFinite(c) || c <= 0) {
    return 0;
  }
  let w = 0;
  let i = 0;
  for (const ch of t) {
    const cw = visWidth(ch);
    // 落点在这个字符**所占的列区间内** → 返回它的起点（拖过一半就算选中）。
    if (c < w + cw) {
      return i;
    }
    w += cw;
    i += ch.length;
  }
  return t.length;
}

/**
 * 按选区抽取**原文**（不是屏幕行切片）。
 *
 * 这是本模块存在的**主要理由**。为什么不用 `selection.extractText`：
 *   屏幕行里混着 `● ` / `  ` 前缀、软换行续段、居中填充、边框字符；ink 在窄屏下
 *   甚至会把 `●` 挤没、吐出空行（见 oracle 测试里的已知偏差记录）。直接切屏幕行
 *   会把前缀和硬 `\n` 一起复制出去 —— 正是 legacy 版「跨软换行多一个硬 \n」的病根。
 *
 * 走锚点则完全规避：
 *   - 内容取自 `msgTexts.get(msgId)` —— **原始消息文本**，一个前缀字符都不会带；
 *   - 行间连不连 `\n` 由 anchor 的 `start/end/soft` 决定，软换行处天然**不插** `\n`；
 *   - 结构行（Logo/Toast/状态栏…）无锚点，退化为按列切屏幕行（这是唯一会带装饰
 *     字符的路径，那些行本来也没有「原文」可言）。
 *
 * @param {{lines:string[], anchors:Array, msgTexts:Map}} projection
 * @param {object} sel `selection` 的选区对象
 * @returns {string} 绝不返回 null/undefined
 */
function extractByAnchors(projection, sel) {
  const p = projection && typeof projection === 'object' ? projection : {};
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const anchors = Array.isArray(p.anchors) ? p.anchors : [];
  const texts = p.msgTexts instanceof Map ? p.msgTexts : null;
  if (lines.length === 0) {
    return '';
  }
  const r = normalizeSelection(sel);
  if (!r) {
    return '';
  }
  const lastIdx = Math.min(r.endLine, lines.length - 1);
  const parts = [];
  const pushLine = (chunk, i) => {
    parts.push(chunk);
    if (i >= lastIdx) {
      return;
    }
    // 行间连不连 '\n' **只**由 soft 定：软换行的续段是同一逻辑行的延续，
    // 之间没有任何真实换行符。这是 legacy 版「跨软换行多一个硬 \n」的修法。
    const a = anchors[i];
    const next = anchors[i + 1];
    const sameMsg = a && next && a.msgId === next.msgId;
    if (sameMsg && a.soft) {
      return;
    }
    parts.push('\n');
  };
  for (let i = r.startLine; i <= lastIdx; i++) {
    const text = _at(lines, i);
    const a = anchors[i];
    const isStart = i === r.startLine;
    const isEnd = i === r.endLine;

    if (!a || !texts) {
      // ── 结构行 / 无锚点：按列切屏幕行（与 selection.extractText 同口径）──
      const from = isStart ? colToOffset(text, r.startCol) : 0;
      const to = isEnd ? colToOffset(text, r.endCol) : text.length;
      pushLine(to > from ? text.slice(from, to) : '', i);
      continue;
    }

    const src = texts.has(a.msgId) ? _s(texts.get(a.msgId)) : '';
    if (src === '') {
      // 原文已不可得（消息被窗口化掉）→ 退回屏幕行，宁可带前缀也不丢内容。
      const from = isStart ? colToOffset(text, r.startCol) : 0;
      const to = isEnd ? colToOffset(text, r.endCol) : text.length;
      pushLine(to > from ? text.slice(from, to) : '', i);
      continue;
    }

    // 屏幕列 → 本行显示片段内的偏移 → 原文内的绝对偏移。
    const pw = prefixWidthOf(text, a, src);
    const seg = src.slice(a.start, a.end);
    const from = isStart ? a.start + colToOffset(seg, r.startCol - pw) : a.start;
    const to = isEnd ? a.start + colToOffset(seg, r.endCol - pw) : a.end;
    pushLine(to > from ? src.slice(from, to) : '', i);
  }
  return parts.join('');
}

/**
 * 某消息行的前缀显示宽度。取「屏幕行与其原文片段的公共前缀之外」的部分：
 * 屏幕行 = prefix + seg，所以 prefix 宽度 = 屏宽 − seg 宽。
 */
function prefixWidthOf(lineText, anchor, src) {
  const seg = src.slice(anchor.start, anchor.end);
  const diff = visWidth(lineText) - visWidth(seg);
  return diff > 0 ? diff : 0;
}

/**
 * 视口切片：`lines` 中与屏幕 `[row, row+height)` 对应的那一段。
 *
 * 与 `Viewport` 的 lines 模式同语义（`slice(offset, offset+height)`）—— 投影
 * 已经是「从屏幕第 0 行开始」，两者的差别只是调用方是否把整块 live 区交给
 * 这个 Viewport。选择层不需要知道这件事。
 *
 * @param {{lines:string[], anchors:Array}} projection
 * @param {number} offset 首行索引（0-based）
 * @param {number} height 可见行数
 * @returns {{lines:string[], anchors:Array, start:number}}
 */
function sliceViewport(projection, offset, height) {
  const lines = projection && Array.isArray(projection.lines) ? projection.lines : [];
  const anchors = projection && Array.isArray(projection.anchors) ? projection.anchors : [];
  const off = Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, lines.length - 1)));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  return {
    lines: lines.slice(off, off + h),
    anchors: anchors.slice(off, off + h),
    start: off,
  };
}

/**
 * 屏幕行 → 投影下标。`offset` 为 null/负/非法时按「贴底」解释成
 * `max(0, total - height)`（与 [DESIGN-ARCH-119] 的既有语义一致）。
 *
 * ⚠ 本函数**不**做 legacy 那种 `row + offset` 反查 —— CC 的 live 区里有六处
 * 可变高兄弟节点，那种反查会随 AgentTree 展开 / toast 增减而静默错位。CC 侧
 * 一律走「整块 live 区给 Viewport」的不变式，坐标即下标。
 *
 * @param {number} row 0-based 屏幕行
 * @param {number} offset 当前视口首行索引（null/负数 → 贴底）
 * @param {number} total 投影总行数
 * @param {number} height 视口高度
 * @returns {number} 投影下标（已 clamp）
 */
function screenRowToIndex(row, offset, total, height) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  const off =
    offset === null || offset === undefined || !Number.isFinite(Number(offset)) || Number(offset) < 0
      ? Math.max(0, t - h)
      : Math.min(Math.floor(Number(offset)), Math.max(0, t - 1));
  const r = Math.max(0, Math.floor(Number(row) || 0));
  return Math.max(0, Math.min(off + r, Math.max(0, t - 1)));
}

/**
 * 投影的滚动（`Viewport` 的滚动算术全部收敛到 scrollActions）。此处只是把
 * `scrollActions.applyScroll` 的 viewport/total 口径定型，避免调用点各写一遍。
 *
 * @param {string} action scrollActions 的动作名
 * @param {number} offset 当前偏移
 * @param {number} total 投影总行数
 * @param {number} height 视口高度
 * @returns {number} 新偏移
 */
function applyScrollToProjection(action, offset, total, height) {
  return applyScroll(action, { offset: offset, viewport: height, total: total });
}

module.exports = {
  projectCcScene,
  sliceViewport,
  screenRowToIndex,
  applyScrollToProjection,
  // 抽取（复制的唯一真源）
  extractByAnchors,
  colToOffset,
  // 供测试与 oracle 对拍直接调用
  wrapLine,
  caretToWrapped,
  centerIn,
  padEnd,
  // 常量（测试断言文案用，避免测试里再抄一份）
  PROMPT_PREFIX,
  PROMPT_CONT,
  PROMPT_MARKER_W,
  ASSIST_HEAD_PREFIX,
  ASSIST_CONT_PREFIX,
  ASSIST_PREFIX_W,
  STREAM_CURSOR,
  STREAMING_TEXT,
  TOAST_ICONS,
  PLACEHOLDERS,
  PROFILE_TO_SIMPLE_MODE,
  SIMPLE_MODE_DISPLAY,
  LOGO_MARGIN_ROWS,
  windowHint,
};
