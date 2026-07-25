'use strict';

/**
 * debugToolCall.js — 纯叶子:`/debug-tool-call` 的确定性核心。
 *
 * 契约:零 IO、零业务 require、确定性、fail-soft 绝不抛、env 门控默认开
 * (`KHY_DEBUG_TOOL_CALL`,仅 `0/false/off/no` 关闭即空回退)、单一真源。读 transcript /
 * 解析 sessionId 的副作用全留在薄壳 `handlers/debugToolCall.js`;本叶子只对**已读入**的
 * conversation chain(`sessionPersistence.buildConversationChain` 的返回)做纯数据变换:
 * 配对 tool_use↔tool_result、截断、渲染。
 *
 * 对齐 Claude Code `src/commands/debug-tool-call`:展示会话 transcript 里最近 N 个
 * tool_use 调用及其结果(按 id 配对、截 200 字)。**诚实差异**:khy transcript 持久化
 * assistant 消息里的 `tool_use` 块,但**不**持久化 `tool_result` 内容;无结果时如实标注
 * 「(result not stored in transcript)」,绝不编造结果。若 khy 未来开始持久化结果,本叶子
 * 自动按 `tool_use_id` 配对呈现,无需改动。
 */

const DEFAULT_LIMIT = 5;
const MAX_RESULT_CHARS = 200;

function isEnabled(env) {
  const raw = env && env.KHY_DEBUG_TOOL_CALL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 菜单 /debug 内联渲染门控(KHY_DEBUG_MENU_INLINE,默认开;仅 0/false/off/no 关)。
 * 关闭时菜单 /debug 逐字节回退旧的静态提示行,不做内联「最近工具调用」渲染。
 * 与 isEnabled(底层 debug-tool-call 特性开关)相互独立:菜单内联额外受此开关约束。
 */
function menuInlineEnabled(env) {
  const raw = env && env.KHY_DEBUG_MENU_INLINE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// 把 content(string | 块数组 | 对象)压平为纯文本。
function _flattenText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (typeof b.content === 'string') return b.content;
      if (Array.isArray(b.content)) return _flattenText(b.content);
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function _truncate(value, n) {
  const str = String(value == null ? '' : value);
  if (str.length <= n) return str;
  return str.slice(0, n) + '…';
}

function _stringifyInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input); } catch { return String(input); }
}

/**
 * 从 conversation chain 抽取 tool_use↔tool_result 配对(按出现先后)。
 * @param {Array} chain  buildConversationChain 返回的条目数组(每条 `{role, content}`)
 * @param {object} [opts] `{ limit }`
 * @returns {Array<{id,name,input,resultText,isError,hasResult}>}  时间正序的最近 limit 个
 */
function extractToolCalls(chain, opts = {}) {
  if (!Array.isArray(chain)) return [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const calls = [];            // 顺序收集 tool_use
  const results = new Map();   // tool_use_id -> { resultText, isError }
  for (const entry of chain) {
    if (!entry || typeof entry !== 'object') continue;
    const content = entry.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        calls.push({ id: b.id || '', name: b.name || '(unknown)', input: b.input });
      } else if (b.type === 'tool_result') {
        const id = b.tool_use_id || b.id || '';
        if (id) results.set(id, { resultText: _flattenText(b.content), isError: !!b.is_error });
      }
    }
  }
  const tail = calls.slice(-limit);
  return tail.map((c) => {
    const r = c.id && results.has(c.id) ? results.get(c.id) : null;
    return {
      id: c.id,
      name: c.name,
      input: c.input,
      resultText: r ? r.resultText : '',
      isError: r ? r.isError : false,
      hasResult: !!r,
    };
  });
}

/**
 * 渲染配对为可读多行文本。
 * @param {Array} pairs  extractToolCalls 的输出
 * @param {object} [opts] `{ maxResultChars }`
 * @returns {string}
 */
function formatToolCallDebug(pairs, opts = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return 'No tool calls found in the current session transcript.';
  }
  const maxChars = Number.isInteger(opts.maxResultChars) && opts.maxResultChars > 0
    ? opts.maxResultChars : MAX_RESULT_CHARS;
  const lines = [`Last ${pairs.length} tool call(s):`];
  pairs.forEach((p, i) => {
    const idShort = p.id ? String(p.id).slice(0, 12) : '—';
    lines.push(`${i + 1}. ${p.name}  [${idShort}]`);
    const inp = _truncate(_stringifyInput(p.input), maxChars);
    if (inp) lines.push(`   input: ${inp}`);
    if (p.hasResult) {
      lines.push(`   ⎿ ${p.isError ? 'error' : 'result'}: ${_truncate(p.resultText, maxChars)}`);
    } else {
      lines.push('   ⎿ (result not stored in transcript)');
    }
  });
  return lines.join('\n');
}

module.exports = { isEnabled, menuInlineEnabled, extractToolCalls, formatToolCallDebug };
