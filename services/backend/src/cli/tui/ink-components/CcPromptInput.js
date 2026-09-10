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
const { Text, Box, useInput, useApp } = require('../inkRuntime').get();

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
  return String(s == null ? '' : s).length;
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
  maxRows = 10,
  vimEnabled = false,
  onShellCommand,
  onVoiceStart,
  onVimModeChange, // Vim 模式变化回调（用于状态栏显示）
}) {
  const { exit } = useApp();
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
    if (busy) return;

    // 退出
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }

    // Vim 模式切换（Claude Code 对齐：NORMAL/INSERT/VISUAL + text objects）
    if (vimEnabled && !isShellMode && !isVoiceMode) {
      // ── 通用：Esc 返回 NORMAL ──
      if (key.escape) { setVimMode('normal'); setVisualStart(null); return; }

      if (vimMode === 'normal') {
        // 模式切换
        if (input === 'i') { setVimMode('insert'); return; }
        if (input === 'a') { setVimMode('insert'); setOffset(o => Math.min(o + 1, value.length)); return; }
        if (input === 'v') { setVimMode('visual'); setVisualStart(offset); return; }
        if (input === 'V') { setVimMode('visual'); setVisualStart(0); setOffset(value.length); return; }

        // 光标移动
        if (input === 'h') { setOffset(o => Math.max(0, o - 1)); return; }
        if (input === 'l') { setOffset(o => Math.min(value.length, o + 1)); return; }
        if (input === '0') { setOffset(0); return; }
        if (input === '$') { setOffset(value.length); return; }
        if (input === 'w') { setOffset(o => nextWord(value, o)); return; }
        if (input === 'b') { setOffset(o => prevWord(value, o)); return; }

        // 删除
        if (input === 'x') {
          if (offset < value.length) {
            onChange(value.slice(0, offset) + value.slice(offset + 1));
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
        // VISUAL 模式下移动光标扩展选区
        if (input === 'h') { setOffset(o => Math.max(0, o - 1)); return; }
        if (input === 'l') { setOffset(o => Math.min(value.length, o + 1)); return; }
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

    // 发送
    if (key.return) {
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

    // 多行输入（Shift+Enter）
    if (key.shift && key.return) {
      const before = value.slice(0, offset);
      const after = value.slice(offset);
      onChange(before + '\n' + after);
      setOffset(offset + 1);
      return;
    }

    // 退格
    if (key.backspace || key.delete) {
      if (offset > 0) {
        onChange(value.slice(0, offset - 1) + value.slice(offset));
        setOffset(offset - 1);
      }
      return;
    }

    // 光标移动
    if (key.leftArrow) { setOffset(o => Math.max(0, o - 1)); return; }
    if (key.rightArrow) { setOffset(o => Math.min(value.length, o + 1)); return; }
    if (key.upArrow) { setOffset(o => Math.max(0, o - 1)); return; } // 简化：实际应按行计算
    if (key.downArrow) { setOffset(o => Math.min(value.length, o + 1)); return; }
    if (key.ctrl && input === 'a') { setOffset(0); return; }
    if (key.ctrl && input === 'e') { setOffset(value.length); return; }

    // 普通字符输入
    if (input && !key.ctrl && !key.meta) {
      const before = value.slice(0, offset);
      const after = value.slice(offset);
      onChange(before + input + after);
      setOffset(offset + input.length);
    }
  });

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const lines = value.split('\n');
  const avail = Math.max(1, cols - MARKER_W - 2);
  const caret = caretToWrapped(value, offset, cols);

  // 构建渲染行
  const renderLines = [];
  for (let li = 0; li < lines.length; li++) {
    const segs = wrapLine(lines[li], avail);
    for (let si = 0; si < segs.length; si++) {
      const isFirstLine = li === 0 && si === 0;
      const hasCaret = li === caret.line && si === caret.seg && !showPlaceholder && !busy;
      const segText = segs[si].text;

      renderLines.push(
        React.createElement(Box, { key: `${li}-${si}` },
          React.createElement(LinePrefix, { isFirst: isFirstLine }),
          React.createElement(Text, null, segText),
          hasCaret ? React.createElement(Cursor, { mode: effectiveMode, visible: true }) : null,
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
  const maxRenderRows = Math.max(1, Math.min(maxRows, Math.floor(process.stdout.rows * 0.3)));
  let visibleLines = renderLines;
  let truncatedAbove = false;
  let truncatedBelow = false;

  if (renderLines.length > maxRenderRows) {
    // 找到光标所在行
    let caretRowIdx = renderLines.findIndex(line => {
      // 检查该行是否包含光标
      return line.props.children && Array.isArray(line.props.children) &&
        line.props.children.some(child => child && child.type === Cursor);
    });
    if (caretRowIdx < 0) caretRowIdx = renderLines.length - 1;

    // 计算窗口
    const half = Math.floor(maxRenderRows / 2);
    let start = Math.max(0, caretRowIdx - half);
    let end = Math.min(renderLines.length, start + maxRenderRows);
    start = Math.max(0, end - maxRenderRows);

    truncatedAbove = start > 0;
    truncatedBelow = end < renderLines.length;

    visibleLines = [];
    if (truncatedAbove) {
      visibleLines.push(
        React.createElement(Box, { key: 'ellipsis-above' },
          React.createElement(Text, { color: '#6B7280', dimColor: true },
            `⋯ (${start} lines above)`),
        )
      );
    }
    visibleLines.push(...renderLines.slice(start, end));
    if (truncatedBelow) {
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
