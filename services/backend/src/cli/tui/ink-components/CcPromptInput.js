'use strict';

/**
 * CcPromptInput.js — CC 模式输入框组件
 * 
 * 设计原则：
 * 1. 极简无边框（对齐 Claude Code）
 * 2. 光标样式随模式变化
 * 3. 多行输入支持（Shift+Enter）
 * 4. Shell 模式（! 前缀）
 * 5. Voice 模式（Win+H）
 * 6. Vim 模式兼容
 * 
 * 参考：[DESIGN-ARCH-082] CC 模式输入框与光标设计
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const imeCommitGuard = require('../imeCommitGuard');
const { _prevStep, _nextStep } = require('../utils/Cursor');
const { inputRenderRows, inputWindow, INPUT_MAX_ROWS_DEFAULT } = require('../utils/ccLayout');

// ── 常量 ────────────────────────────────────────────────────────────────────

const CURSOR_CHARS = Object.freeze({
  insert: '│',      // 竖线（INSERT 模式）
  normal: '█',      // 方块（Vim NORMAL）
  shell: '│',       // 竖线（Shell 模式）
  voice: '●',       // 圆点（录音中）
  replace: '_',     // 下划线（覆盖模式）
});

const CURSOR_COLORS = Object.freeze({
  insert: '#4ADE80',    // 绿色
  normal: '#4ADE80',    // 绿色
  shell: '#FBBF24',     // 黄色
  voice: '#F87171',     // 红色
  replace: '#4ADE80',   // 绿色
});

const PLACEHOLDERS = Object.freeze({
  default: 'Send a message...',
  shell: 'Run a command...',
  voice: 'Listening...',
  busy: 'AI is thinking...',
});

const PROMPT = '> ';  // 主提示符
const CONT = '  ';    // 续行前缀
// 宿主未声明全局键时的稳定空数组：本组件套着 React.memo，
// 给默认值 `[]` 会让每次渲染都换一个新引用、memo 直接失效。
const NO_GLOBAL_KEYS = Object.freeze([]);
const MARKER_W = 2;   // 提示符宽度

// Vim 剪贴板（简化：单寄存器）
let _vimYank = '';

/**
 * 移动到下一个词首（Vim w 命令）
 */
function nextWord(text, pos) {
  if (pos >= text.length) return pos;
  let i = pos;
  // 跳过当前词
  while (i < text.length && /\S/.test(text[i])) i++;
  // 跳过空白
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * 移动到上一个词首（Vim b 命令）
 */
function prevWord(text, pos) {
  if (pos <= 0) return 0;
  let i = pos - 1;
  // 跳过空白
  while (i > 0 && /\s/.test(text[i])) i--;
  // 跳过当前词
  while (i > 0 && /\S/.test(text[i - 1])) i--;
  return i;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 获取显示宽度（CJK 兼容）
 */
let _dwidth = null;
function dwidth(s) {
  if (_dwidth === null) {
    try {
      _dwidth = require('../../formatters').displayWidth || false;
    } catch {
      _dwidth = false;
    }
  }
  if (_dwidth) {
    try { return _dwidth(s); } catch { /* fall through */ }
  }
  // CJK-aware fallback: formatters.js is the canonical displayWidth; when it
  // is unavailable, textMeasure.visWidth keeps CJK=2 alignment instead of
  // falling back to UTF-16 length (which mis-measures every CJK prompt).
  try {
    return require('../runtime/textMeasure').visWidth(String(s == null ? '' : s));
  } catch {
    return String(s == null ? '' : s).length;
  }
}

/**
 * 按宽度换行（CJK 兼容）
 */
function wrapLine(line, avail) {
  const cap = Math.max(1, avail | 0);
  if (line === '') return [{ text: '', start: 0, end: 0 }];
  const segs = [];
  let segStart = 0, segW = 0, idx = 0;
  for (const ch of line) {
    const w = dwidth(ch);
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

/**
 * 计算光标在 wrapping 后的位置
 */
function caretToWrapped(value, offset, cols) {
  const lines = value.split('\n');
  const avail = Math.max(1, cols - MARKER_W - 2);
  let lineStart = 0; // UTF-16 offset where current logical line starts

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineEnd = lineStart + line.length;
    const isLastLine = li === lines.length - 1;

    if (offset <= lineEnd || isLastLine) {
      const caretCol = Math.min(offset - lineStart, line.length);
      const segs = wrapLine(line, avail);

      // 找到光标所在的 wrapped segment
      let segIdx = segs.length - 1;
      for (let s = 0; s < segs.length; s++) {
        if (caretCol < segs[s].end || (caretCol === segs[s].end && s === segs.length - 1)) {
          segIdx = s;
          break;
        }
      }

      return {
        line: li,
        seg: segIdx,
        col: caretCol,
        segStart: segs[segIdx]?.start || 0,
      };
    }
    lineStart = lineEnd + 1; // +1 for '\n'
  }

  // Fallback: 最后一行末尾
  return { line: lines.length - 1, seg: 0, col: 0, segStart: 0 };
}

// ── 光标组件 ────────────────────────────────────────────────────────────────

const Cursor = React.memo(function Cursor({ mode = 'insert', visible = true }) {
  const char = CURSOR_CHARS[mode] || CURSOR_CHARS.insert;
  const color = CURSOR_COLORS[mode] || CURSOR_COLORS.insert;

  if (!visible) return null;

  return React.createElement(Text, { color, bold: true }, char);
});

// ── 占位符组件 ──────────────────────────────────────────────────────────────

const Placeholder = React.memo(function Placeholder({ mode = 'default', busy = false }) {
  if (busy) {
    return React.createElement(Text, { color: '#6B7280' }, PLACEHOLDERS.busy);
  }
  const text = PLACEHOLDERS[mode] || PLACEHOLDERS.default;
  return React.createElement(Text, { color: '#6B7280' }, text);
});

// ── 行前缀组件 ──────────────────────────────────────────────────────────────

const LinePrefix = React.memo(function LinePrefix({ isFirst }) {
  return React.createElement(Text, { color: '#A0A0A0' }, isFirst ? PROMPT : CONT);
});

// ── 主组件 ──────────────────────────────────────────────────────────────────

function CcPromptInput({
  value = '',
  onChange,
  onSubmit,
  mode = 'default',
  busy = false,
  cols = 80,
  maxRows = INPUT_MAX_ROWS_DEFAULT,
  vimEnabled = false,
  onShellCommand,
  onVoiceStart,
  onVimModeChange, // Vim 模式变化回调（用于状态栏显示）
  onToast, // 复制反馈 toast（CC 模式 P1-1 剪贴板统一出口）
  globalKeys = NO_GLOBAL_KEYS, // 宿主已消费的可打印键（BUG-90，见下方插入分支）
}) {
  const [offset, setOffset] = React.useState(0);  // UTF-16 偏移
  const [vimMode, setVimMode] = React.useState('insert'); // Vim 子模式
  const [visualStart, setVisualStart] = React.useState(null); // VISUAL 选区起点

  // 同步 Vim 模式到父组件（用于状态栏显示）
  React.useEffect(() => {
    onVimModeChange?.(vimEnabled ? vimMode : null);
  }, [vimMode, vimEnabled, onVimModeChange]);

  // 派生状态
  const isShellMode = mode === 'shell' || (value.startsWith('!') && mode === 'default');
  const isVoiceMode = mode === 'voice';
  const effectiveMode = isShellMode ? 'shell' : isVoiceMode ? 'voice' : vimEnabled ? vimMode : 'insert';
  const showPlaceholder = value.length === 0 && !busy;

  // ── 输入处理 ──────────────────────────────────────────────────────────────

  useInput((input, key) => {
    // BUG-86：这里原有两条 `key.ctrl && (c|d) → exit()`。ink 的 useInput 监听器
    // **不互斥** —— CcApp 的全局处理器（CcApp.js:601，[DESIGN-ARCH-087] 双击退出：
    // 首次只 addToast 提示、3s 内二次才退）与本组件的处理器同一帧都会收到同一个键，
    // 于是首次 Ctrl+C 就把整个会话退掉，「再按一次」提示永远来不及画。
    // 双击退出属于全局快捷键，真源在 CcApp（与 Legacy App.js 同法）→ 组件侧只删不加。
    //
    // BUG-85：这里原本还有一条 `if (busy) return;` 挡在整段处理器最前面 —— 回合
    // 进行中按下的**每一个键**都被静默丢弃：模型思考十几秒，用户这期间敲的一句话、
    // 粘贴的 30 行日志全部消失（探针 AU/probe-ccapp-paste.cjs AT_BUSY=1：忙时粘贴
    // 5s 后帧内既无输入框内容、也无队列行、也没提交成消息）。现在编辑照常放行，
    // 只有「提交」在 busy 时被**可见地**拒绝（见下方 key.return 分支）。
    // Vim 模式切换（Ctrl+V 由 CcApp 全局处理；这里是 ESC/i/a/v 等组件内键位）
    if (vimEnabled && !isShellMode && !isVoiceMode) {
      // ── 通用：Esc 返回 NORMAL ──
      if (key.escape) { setVimMode('normal'); setVisualStart(null); return; }

      if (vimMode === 'normal') {
        // 模式切换
        if (input === 'i') { setVimMode('insert'); return; }
        if (input === 'a') { setVimMode('insert'); setOffset(o => Math.min(o + 1, value.length)); return; }
        if (input === 'v') { setVimMode('visual'); setVisualStart(offset); return; }
        if (input === 'V') { setVimMode('visual'); setVisualStart(0); setOffset(value.length); return; }

        // 光标移动（astral-safe：代理对按一个码点步进）
        if (input === 'h') { setOffset(o => Math.max(0, o - (_prevStep(value, o) || 1))); return; }
        if (input === 'l') { setOffset(o => Math.min(value.length, o + (_nextStep(value, o) || 1))); return; }
        if (input === '0') { setOffset(0); return; }
        if (input === '$') { setOffset(value.length); return; }
        if (input === 'w') { setOffset(o => nextWord(value, o)); return; }
        if (input === 'b') { setOffset(o => prevWord(value, o)); return; }

        // 删除（astral-safe：x 删一个完整码点，不撕裂代理对）
        if (input === 'x') {
          if (offset < value.length) {
            const step = _nextStep(value, offset) || 1;
            onChange(value.slice(0, offset) + value.slice(offset + step));
          }
          return;
        }
        if (input === 'd') {
          // dd — 删除整行
          if (key.ctrl) {
            onChange('');
            setOffset(0);
            return;
          }
          // dw — 删除到下一个词首
          const next = nextWord(value, offset);
          if (next > offset) {
            onChange(value.slice(0, offset) + value.slice(next));
          }
          return;
        }

        // 粘贴
        if (input === 'p') {
          if (_vimYank) {
            const before = value.slice(0, offset);
            const after = value.slice(offset);
            onChange(before + _vimYank + after);
            setOffset(offset + _vimYank.length);
          }
          return;
        }

        // 撤销（简化：清空）
        if (input === 'u') {
          onChange('');
          setOffset(0);
          return;
        }

        return; // NORMAL 模式下忽略其他输入
      }

      if (vimMode === 'visual') {
        // VISUAL 模式下移动光标扩展选区（astral-safe 步进）
        if (input === 'h') { setOffset(o => Math.max(0, o - (_prevStep(value, o) || 1))); return; }
        if (input === 'l') { setOffset(o => Math.min(value.length, o + (_nextStep(value, o) || 1))); return; }
        if (input === 'w') { setOffset(o => nextWord(value, o)); return; }
        if (input === 'b') { setOffset(o => prevWord(value, o)); return; }
        if (input === '0') { setOffset(0); return; }
        if (input === '$') { setOffset(value.length); return; }

        // 选区操作
        if (input === 'd' || input === 'x') {
          const start = visualStart != null ? Math.min(visualStart, offset) : offset;
          const end = visualStart != null ? Math.max(visualStart, offset) : offset;
          onChange(value.slice(0, start) + value.slice(end));
          setOffset(start);
          setVisualStart(null);
          setVimMode('normal');
          return;
        }
        if (input === 'y') {
          const start = visualStart != null ? Math.min(visualStart, offset) : offset;
          const end = visualStart != null ? Math.max(visualStart, offset) : offset;
          _vimYank = value.slice(start, end);
          // P1-1: y 同步写系统剪贴板(vim 语义「复制寄存器 + 剪贴板双写」),
          // 统一出口走 ccClipboard.writeClipboard(fail-soft,绝不抛)。
          if (_vimYank) {
            try {
              const cc = require('../utils/ccClipboard');
              const r = cc.writeClipboard(_vimYank);
              if (r.ok) {
                onToast?.(`已复制 ${r.bytes} 字节到剪贴板(${r.channels.join('+')})`, 'success');
              } else {
                onToast?.(`复制失败:${r.reasons.native || r.reasons.osc52 || '未知原因'}`, 'error');
              }
            } catch {
              /* fail-soft:剪贴板不可用不阻断 vim 操作 */
            }
          }
          setVisualStart(null);
          setVimMode('normal');
          return;
        }
        return;
      }

      // INSERT 模式下：Ctrl+W 删除前一个词
      if (key.ctrl && input === 'w') {
        const prev = prevWord(value, offset);
        if (prev < offset) {
          onChange(value.slice(0, prev) + value.slice(offset));
          setOffset(prev);
        }
        return;
      }
    }

    // 多行输入（Shift+Enter）—— must sit ABOVE the key.return block: the
    // return check below swallows every Enter first, so a later shift&&return
    // test is dead code (Shift+Enter could never insert a newline).
    if (key.shift && key.return) {
      const before = value.slice(0, offset);
      const after = value.slice(offset);
      onChange(before + '\n' + after);
      setOffset(offset + 1);
      return;
    }

    // 发送
    if (key.return) {
      // BUG-85：回合进行中按回车**不发**（CC 表面尚未接网关，见 BUG-80 登记的
      // handleSubmit 桩），但也绝不静默吞键——原行为是整段键事件被
      // `if (busy) return` 丢掉，缓冲一起没了。现在保留缓冲、给出可见回执。
      if (busy) {
        if (value.trim() && typeof onToast === 'function') {
          onToast(`回合进行中：输入已保留 ${value.length} 字未发送，本轮结束后再按回车发出`, 'warning');
        }
        return;
      }
      // IME composition confirm: a bare Enter right after a fullwidth-only
      // insert is the IME's own confirm key — swallow it (the composed text
      // is already in the buffer); the user's next Enter is the real submit.
      if (!key.shift && !key.ctrl && !key.meta && imeCommitGuard.shouldSwallowBareEnter()) {
        return;
      }
      // Shell 模式：执行命令
      if (isShellMode && onShellCommand) {
        const cmd = value.startsWith('!') ? value.slice(1).trim() : value.trim();
        onShellCommand(cmd);
        onChange('');
        setOffset(0);
        return;
      }
      // 默认模式：发送消息
      if (value.trim()) {
        onSubmit(value);
        onChange('');
        setOffset(0);
      }
      return;
    }

    // 退格（astral-safe: step back over a surrogate pair as one unit）
    if (key.backspace || key.delete) {
      if (offset > 0) {
        const step = _prevStep(value, offset) || 1;
        onChange(value.slice(0, offset - step) + value.slice(offset));
        setOffset(offset - step);
      }
      return;
    }

    // 光标移动（astral-safe stepping over surrogate pairs）
    if (key.leftArrow) { setOffset(o => Math.max(0, o - (_prevStep(value, o) || 1))); return; }
    if (key.rightArrow) { setOffset(o => Math.min(value.length, o + (_nextStep(value, o) || 1))); return; }
    if (key.upArrow) { setOffset(o => Math.max(0, o - (_prevStep(value, o) || 1))); return; } // 简化：实际应按行计算
    if (key.downArrow) { setOffset(o => Math.min(value.length, o + (_nextStep(value, o) || 1))); return; }
    if (key.ctrl && input === 'a') { setOffset(0); return; }
    if (key.ctrl && input === 'e') { setOffset(value.length); return; }

    // 普通字符输入（IME commit tracking + paste-marker stripping）
    if (input && !key.ctrl && !key.meta) {
      // BUG-90：宿主声明为「全局热键」的可打印键**不入输入框**。ink 的 useInput
      // 不互斥（见上方 BUG-86 那段），宿主 CcApp 的 `?` 分支 `return` 只退出它自己
      // 的处理器，这一支照样会把问号写进 value；而帮助菜单是提前 return 换掉整个
      // 主表面的，于是 Esc 关掉菜单后输入框重新挂载、value 里已经躺着一个 `?`。
      // 弃权依据必须是**宿主声明的契约**而不是订阅顺序（React 里子组件 effect 先跑，
      // 顺序技巧不可靠）：globalKeys 与 CcApp 的 `?` 分支读同一份 inputValue，
      // 两边不可能分叉。
      if (globalKeys.includes(input)) return;
      const clean = input.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      imeCommitGuard.noteImeCommit(clean);
      const before = value.slice(0, offset);
      const after = value.slice(offset);
      onChange(before + clean + after);
      setOffset(offset + clean.length);
    }
  });

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const lines = value.split('\n');
  const avail = Math.max(1, cols - MARKER_W - 2);
  const caret = caretToWrapped(value, offset, cols);

  // 构建渲染行
  const renderLines = [];
  // 空缓冲区时跳过内容行：value='' 会让 lines=[''] 画出一行只有前缀 '>' 的空内容，
  // 而下面 showPlaceholder（空且非忙）/ busy 分支又各画一行带同一 '>' 前缀的占位/忙碌行
  // → 空态输入框出现两行 '>'（一行孤立空壳 + 一行 '> Send a message…'）。该行从不承载
  // 光标（hasCaret 需 !showPlaceholder && !busy），故空态下整段内容循环直接跳过。
  for (let li = 0; value.length > 0 && li < lines.length; li++) {
    const segs = wrapLine(lines[li], avail);
    for (let si = 0; si < segs.length; si++) {
      const isFirstLine = li === 0 && si === 0;
      const hasCaret = li === caret.line && si === caret.seg && !showPlaceholder && !busy;
      const segText = segs[si].text;
      // BUG-99: draw the caret at its true column WITHIN the segment. It used to
      // be pinned to the segment end (`Text(segText)` then `Cursor`), so a mid-line
      // caret — and any restored draft, whose internal offset starts at 0 — rendered
      // the block after the row's LAST char instead of at the edit point (blind
      // editing). `caretToWrapped` already reports `caret.col` (line-relative code
      // unit) and `segs[si].start`; slice there. Byte-identical when the caret is
      // already at the segment end (the normal append-typing case → after === '').
      let before = segText;
      let after = '';
      if (hasCaret) {
        const inSeg = Math.max(0, Math.min(caret.col - segs[si].start, segText.length));
        before = segText.slice(0, inSeg);
        after = segText.slice(inSeg);
      }

      renderLines.push(
        React.createElement(Box, { key: `${li}-${si}` },
          React.createElement(LinePrefix, { isFirst: isFirstLine }),
          React.createElement(Text, null, before),
          hasCaret ? React.createElement(Cursor, { mode: effectiveMode, visible: true }) : null,
          after ? React.createElement(Text, null, after) : null,
        )
      );
    }
  }

  // 空输入时显示占位符
  if (showPlaceholder) {
    renderLines.push(
      React.createElement(Box, { key: 'placeholder' },
        React.createElement(LinePrefix, { isFirst: true }),
        React.createElement(Placeholder, { mode: isShellMode ? 'shell' : 'default' }),
      )
    );
  }

  // Busy 状态
  if (busy) {
    renderLines.push(
      React.createElement(Box, { key: 'busy' },
        React.createElement(LinePrefix, { isFirst: true }),
        React.createElement(Placeholder, { busy: true }),
      )
    );
  }

  // 高度窗口化
  // BUG-81：这里原本写 `Math.min(maxRows, Math.floor(process.stdout.rows * 0.3))` ——
  // 两处病灶：① 组件裸读 `process.stdout`（DESIGN-ARCH-102 P4/H8 明令禁止，全仓只有
  // ../effectiveDims 允许；宿主传进来的 cols/rows 才是覆盖层该用的那把尺子）；
  // ② 把 `ccLayout.inputMaxHeight` 的公式（min(10, rows×0.3）**又抄了一遍**，于是
  // 「账本按 A 收费、画按 B 出活」：CcApp 用 inputMaxHeight 给消息区扣预算，
  // 输入框却按第二份公式裁高度，两者一旦改动就分叉。
  // 非 TTY（conpty/管道下 rows 是 undefined）更要命：`undefined × 0.3 = NaN` →
  // `Math.min(maxRows, NaN) = NaN` → `renderLines.length > NaN` 恒 false →
  // 高度窗口整个失效，多行输入不限高往下画 → 帧高越过终端 → ink 全屏擦除残影。
  // 现在只信宿主传下的 maxRows（它**就是** inputMaxHeight：CcApp.js:944），
  // 且这个换算由 ccLayout.inputRenderRows 独家定义 —— 投影（拖选记账）调的是
  // 同一个函数，两边不可能再分叉。
  const maxRenderRows = inputRenderRows(maxRows);
  let visibleLines = renderLines;

  if (renderLines.length > maxRenderRows) {
    // 找到光标所在行
    let caretRowIdx = renderLines.findIndex(line => {
      // 检查该行是否包含光标
      return line.props.children && Array.isArray(line.props.children) &&
        line.props.children.some(child => child && child.type === Cursor);
    });
    if (caretRowIdx < 0) caretRowIdx = renderLines.length - 1;

    // BUG-84：窗口算式收敛到 ccLayout.inputWindow —— 省略号是输入框画出来的行，
    // 就得从输入框的预算里出。原来这里取满 maxRenderRows **之后**再追加 1–2 行
    // 省略号，而宿主（CcApp.js:967 maxRows = layout.inputMaxHeight）只按 maxRows
    // 扣账，于是「账本 N 行 / 实画 N+2 行」（实测每个高度都恰好差 2 行，见
    // AU/repro-before-bug84.txt B 段）。
    const win = inputWindow(renderLines.length, maxRenderRows, caretRowIdx);
    const start = win.start;
    const end = win.end;

    visibleLines = [];
    if (win.above) {
      visibleLines.push(
        React.createElement(Box, { key: 'ellipsis-above' },
          React.createElement(Text, { color: '#6B7280', dimColor: true },
            `⋯ (${start} lines above)`),
        )
      );
    }
    visibleLines.push(...renderLines.slice(start, end));
    if (win.below) {
      visibleLines.push(
        React.createElement(Box, { key: 'ellipsis-below' },
          React.createElement(Text, { color: '#6B7280', dimColor: true },
            `⋯ (${renderLines.length - end} lines below)`),
        )
      );
    }
  }

  return React.createElement(Box, { flexDirection: 'column' }, ...visibleLines);
}

module.exports = { CcPromptInput: React.memo(CcPromptInput) };
