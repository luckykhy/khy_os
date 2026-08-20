'use strict';

/**
 * transcriptLines — 把 messages 投影成「纯文本行数组」的单一真源(纯叶子:零 IO、
 * 确定性、绝不抛)。TranscriptView 按行切片做 bounded viewport 滚动。
 *
 * 为什么按行而不按消息:CC Transcript context 的 `scroll:lineUp` /
 * `scroll:halfPageUp`(ctrl+u)在「一条消息 = 一格」的粒度下没有意义 —— 半页翻的是
 * 「视口行数的一半」,所以投影必须落到行粒度才对得上 CC 的 less 惯例。
 *
 * showAll 对齐 CC 的 `transcript:toggleShowAll`(ctrl+e):
 *   false → 思考压成一行摘要、工具压成一行状态
 *   true  → 思考展开全文、工具展开结果输出
 *
 * 渲染器一律**注入**而非 require,这样叶子无依赖、可单测,同时调用方能传入与
 * committed 区完全相同的渲染器保证排版一致:
 *   renderMarkdown(text, cols) → 已按 cols 排好版的字符串(缺省恒等)
 *   summarizeTool(tool)        → 工具参数摘要字符串(缺省内置保守实现)
 *
 * 上限是硬的(TOTAL_LINE_CAP / TOOL_BODY_LINE_CAP):长会话不能让视图把整段历史
 * 铺进内存再切片。超限时保留尾部并在首行注明丢了多少,绝不静默丢内容。
 */

// 总行数上限:超过后从**尾部**保留(用户要看的永远是最近的对话),头部截断并注明。
const TOTAL_LINE_CAP = 20000;
// showAll 时单个工具结果最多展开的行数。
const TOOL_BODY_LINE_CAP = 200;
// 单行硬截断宽度兜底(cols 非法时用)。
const DEFAULT_COLS = 80;

function _cols(cols) {
  const n = Number(cols);
  return Number.isFinite(n) && n >= 20 ? Math.floor(n) : DEFAULT_COLS;
}

function _str(v) {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// 把一段可能含换行的文本切成行;每行按 width 硬折(不做断词,终端等宽字体下够用)。
function _wrap(text, width) {
  const out = [];
  const w = width > 0 ? width : DEFAULT_COLS;
  for (const raw of _str(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.length <= w) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += w) {
      out.push(line.slice(i, i + w));
    }
  }
  return out;
}

function _truncate(s, max) {
  const t = _str(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t;
}

// 内置保守摘要:优先常见描述性键,否则整体截断。调用方可用 summarizeTool 覆盖
// (TranscriptView 传 ToolLines.summarizeArgs,与 committed 区文案一致)。
const _ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'name', 'prompt'];

function defaultSummarizeTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  const raw = tool.input ?? tool.args ?? tool.parameters;
  if (raw === null || raw === undefined) {
    return '';
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return _truncate(raw, 60);
    }
  }
  if (!obj || typeof obj !== 'object') {
    return _truncate(obj, 60);
  }
  for (const k of _ARG_KEYS) {
    if (obj[k]) {
      return _truncate(obj[k], 60);
    }
  }
  return _truncate(_str(obj), 60);
}

function _toolStatus(tool) {
  const r = tool && tool.result;
  if (!r) {
    return { icon: '◆', label: '' };
  }
  if (r.isError || r.is_error || r.error || r.success === false) {
    return { icon: '✗', label: _truncate(r.error || r.message || '失败', 60) };
  }
  return { icon: '✓', label: '' };
}

// showAll 时工具结果的正文:从常见字段里取第一个非空的文本载荷。
const _BODY_KEYS = ['output', 'stdout', 'content', 'text', 'result', 'data'];

function _toolBody(result) {
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result !== 'object') {
    return _str(result);
  }
  for (const k of _BODY_KEYS) {
    const v = result[k];
    if (typeof v === 'string' && v.trim()) {
      return v;
    }
  }
  const err = result.error || result.message;
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return '';
}

function _toolLines(tools, ctx) {
  const out = [];
  const list = Array.isArray(tools) ? tools : [];
  for (const tool of list) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const name = _str(tool.name || tool.toolName || tool.tool || 'tool');
    const args = _truncate(ctx.summarizeTool(tool), 60);
    const st = _toolStatus(tool);
    let head = '  ' + st.icon + ' ' + name;
    if (args) {
      head += '(' + args + ')';
    }
    if (st.label) {
      head += ' — ' + st.label;
    }
    out.push(..._wrap(head, ctx.cols));
    if (!ctx.showAll) {
      continue;
    }
    const body = _toolBody(tool.result);
    if (!body) {
      continue;
    }
    const bodyLines = _wrap(body, Math.max(20, ctx.cols - 4));
    const shown = bodyLines.slice(0, TOOL_BODY_LINE_CAP);
    for (const ln of shown) {
      out.push('    ' + ln);
    }
    const hidden = bodyLines.length - shown.length;
    if (hidden > 0) {
      out.push('    … 该工具输出还有 ' + hidden + ' 行未展开(单工具上限 ' + TOOL_BODY_LINE_CAP + ' 行)');
    }
  }
  return out;
}

// 助手消息的 timeline 条目(text / thinking / tools)。这里逐条投影,连续 tools
// 条目自然相邻,视觉上仍读作一个过程组。
function _timelineLines(timeline, ctx) {
  const out = [];
  for (const e of timeline) {
    if (!e || typeof e !== 'object') {
      continue;
    }
    if (e.type === 'text') {
      if (!e.text) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
      }
      out.push(..._wrap(ctx.renderMarkdown(_str(e.text), ctx.cols), ctx.cols));
    } else if (e.type === 'thinking') {
      if (!e.text) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
      }
      if (ctx.showAll) {
        out.push('💭 思考');
        out.push(..._wrap(_str(e.text).trim(), ctx.cols));
      } else {
        const chars = _str(e.text).replace(/\s+/g, '').length;
        out.push('💭 思考 · ' + chars + ' 字');
      }
    } else if (e.type === 'tools') {
      const lines = _toolLines(e.tools, ctx);
      if (lines.length === 0) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
      }
      out.push(...lines);
    }
  }
  return out;
}

function _messageLines(msg, ctx) {
  if (!msg || typeof msg !== 'object') {
    return [];
  }
  const cols = ctx.cols;
  switch (msg.role) {
    case 'user': {
      const lines = _wrap(_str(msg.content), Math.max(20, cols - 2)).map(
        (ln, i) => (i === 0 ? '❯ ' : '  ') + ln
      );
      if (Number(msg.imageCount) > 0) {
        lines.push('  📎×' + Number(msg.imageCount));
      }
      return lines;
    }
    case 'assistant': {
      const timeline =
        Array.isArray(msg.timeline) && msg.timeline.length > 0 ? msg.timeline : null;
      if (timeline) {
        const lines = _timelineLines(timeline, ctx);
        // Non-streaming adapter fallback:timeline 只带工具时,可见答复在 content 里。
        const hasText = timeline.some((e) => e && e.type === 'text' && e.text);
        if (!hasText && msg.content) {
          return [..._wrap(ctx.renderMarkdown(_str(msg.content), cols), cols), ...lines];
        }
        return lines;
      }
      const lines = [];
      if (msg.content) {
        lines.push(..._wrap(ctx.renderMarkdown(_str(msg.content), cols), cols));
      }
      if (Array.isArray(msg.tools) && msg.tools.length > 0) {
        lines.push(..._toolLines(msg.tools, ctx));
      }
      return lines;
    }
    case 'error':
      return _wrap('✗ 错误：' + _str(msg.content), cols);
    case 'bash-command':
      return _wrap('! ' + _str(msg.content), cols);
    case 'bash-output': {
      const text = _str(msg.content).replace(/\n+$/, '');
      if (!text) {
        return ['（无输出）'];
      }
      return _wrap(text, Math.max(20, cols - 2)).map((ln, i) => (i === 0 ? '⎿ ' : '  ') + ln);
    }
    case 'notice': {
      const c = msg.content;
      if (c && typeof c === 'object' && c.gateway === true) {
        const detail = _str(c.detail).split('\n');
        const summary = typeof c.content === 'string' ? c.content : detail[0] || '';
        if (!ctx.showAll || detail.length <= 1) {
          const extra = detail.length > 1 ? '  (+' + (detail.length - 1) + ' 行)' : '';
          return _wrap('· ' + summary + extra, cols);
        }
        const out = _wrap('· ' + summary, cols);
        for (const ln of detail.slice(1)) {
          out.push(..._wrap('  ' + ln, cols));
        }
        return out;
      }
      return _wrap('· ' + _str(c), cols);
    }
    case 'turn-stats':
      return msg.content ? _wrap(_str(msg.content), cols) : [];
    default: {
      // 未知/展示型角色(decision / expansion / qa / 未来新增)统一走保守文本投影,
      // 拿不到文本就整条跳过 —— 前向兼容 fail-soft,绝不因新角色抛错。
      const c = msg.content;
      const text = _str(c && typeof c === 'object' ? c.text || c.content : c);
      return text ? _wrap(text, cols) : [];
    }
  }
}

/**
 * messages → 文本行数组。空/非法输入 → []。绝不抛。
 *
 * @param {Array} messages 会话消息(useQueryBridge 的 messages)
 * @param {{cols?:number, showAll?:boolean, renderMarkdown?:Function, summarizeTool?:Function}} opts
 * @returns {string[]}
 */
function buildTranscriptLines(messages, opts) {
  try {
    const list = Array.isArray(messages) ? messages : [];
    const o = opts && typeof opts === 'object' ? opts : {};
    const ctx = {
      cols: _cols(o.cols),
      showAll: !!o.showAll,
      renderMarkdown: typeof o.renderMarkdown === 'function' ? o.renderMarkdown : (t) => _str(t),
      summarizeTool:
        typeof o.summarizeTool === 'function' ? o.summarizeTool : defaultSummarizeTool,
    };
    const out = [];
    for (const msg of list) {
      let lines;
      try {
        lines = _messageLines(msg, ctx);
      } catch {
        lines = []; // 单条消息投影失败不拖垮整个视图
      }
      if (!lines || lines.length === 0) {
        continue;
      }
      if (out.length > 0) {
        out.push(''); // 消息之间恰一空行(对齐 committed 区的 marginTop:1)
      }
      out.push(...lines);
    }
    if (out.length > TOTAL_LINE_CAP) {
      const dropped = out.length - TOTAL_LINE_CAP;
      return [
        '… 更早的 ' + dropped + ' 行未载入(已达 ' + TOTAL_LINE_CAP + ' 行视图上限)',
        ...out.slice(dropped),
      ];
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  buildTranscriptLines,
  defaultSummarizeTool,
  TOTAL_LINE_CAP,
  TOOL_BODY_LINE_CAP,
};
