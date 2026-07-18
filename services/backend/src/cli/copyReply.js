'use strict';

/**
 * copyReply.js — 纯叶子:`/copy` 的确定性核心。
 *
 * 契约:零 IO、零业务 require、确定性、fail-soft 绝不抛、env 门控默认开
 * (`KHY_COPY`,仅 `0/false/off/no` 关闭)、单一真源。读 transcript、压平 content
 * (`contentBlockUtils.contentToText`)、写剪贴板的副作用全留在薄壳 `handlers/copy.js`;
 * 本叶子只对**已压平的助手回复文本数组**做纯数据变换:解析参数、选第 N 条、抽代码块、
 * 拼最终待复制载荷。
 *
 * 对齐 Claude Code `/copy`:复制最近(或第 N 条)助手回复;`code` 子参 → 只复制其中的
 * 代码块(``` 围栏)。**诚实差异**:khy 无 OSC52,薄壳走 imageService.writeClipboardText
 * (pbcopy/xclip/wl-copy/Set-Clipboard)真实系统剪贴板;无可复制内容时如实告知,绝不假装成功。
 */

function isEnabled(env) {
  const raw = env && env.KHY_COPY;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 解析 `/copy` 参数 token 流。
 *   - `code` / `--code` / `-c` → codeOnly:true(只抽代码块)
 *   - 第一个正整数 N → nth:N(从最近往回数,1=最近)
 * @returns {{ nth: number, codeOnly: boolean }}  nth 缺省 1
 */
function parseCopyArgs(tokens) {
  let nth = 1;
  let codeOnly = false;
  const list = Array.isArray(tokens) ? tokens : [];
  for (const raw of list) {
    if (raw == null) continue;
    const t = String(raw).trim().toLowerCase();
    if (t === '') continue;
    if (t === 'code' || t === '--code' || t === '-c') { codeOnly = true; continue; }
    const n = parseInt(t, 10);
    if (Number.isInteger(n) && n > 0) { nth = n; }
  }
  return { nth, codeOnly };
}

/**
 * 从助手回复文本数组(时间正序)选「从最近往回数第 nth」条。
 * @param {string[]} texts  已压平的助手回复(空串已剔除由薄壳保证,这里再做防呆)
 * @param {number} nth  1=最近
 * @returns {{ text: string, ordinal: number, total: number } | null}
 */
function selectReply(texts, nth) {
  if (!Array.isArray(texts)) return null;
  const cleaned = texts.filter((t) => typeof t === 'string' && t.trim() !== '');
  if (cleaned.length === 0) return null;
  const n = Number.isInteger(nth) && nth > 0 ? nth : 1;
  if (n > cleaned.length) return null;
  const idx = cleaned.length - n; // 最近 = 末尾
  return { text: cleaned[idx], ordinal: n, total: cleaned.length };
}

/**
 * 抽取 markdown 围栏代码块(``` 或 ~~~)的内容(不含围栏与语言标注)。
 * 多块以单个空行分隔拼接。无块 → []。
 * @returns {string[]}
 */
function extractCodeBlocks(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  const blocks = [];
  let inBlock = false;
  let fence = '';
  let buf = [];
  for (const line of lines) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (!inBlock && m) {
      inBlock = true; fence = m[1][0]; buf = []; continue;
    }
    if (inBlock) {
      const close = new RegExp('^\\s*' + (fence === '`' ? '```+' : '~~~+') + '\\s*$');
      if (close.test(line)) { blocks.push(buf.join('\n')); inBlock = false; buf = []; continue; }
      buf.push(line);
    }
  }
  // 未闭合围栏:容错收尾,把已积累内容也算一块(绝不丢用户内容)
  if (inBlock && buf.length > 0) blocks.push(buf.join('\n'));
  return blocks.filter((b) => b !== '');
}

/**
 * 综合:从文本数组解析出最终待复制载荷与一句人读描述。
 * @param {string[]} texts
 * @param {{ nth?: number, codeOnly?: boolean }} opts
 * @returns {{ ok: true, payload: string, description: string } | { ok: false, reason: string }}
 */
function buildCopyPayload(texts, opts = {}) {
  const nth = Number.isInteger(opts.nth) && opts.nth > 0 ? opts.nth : 1;
  const codeOnly = !!opts.codeOnly;
  const picked = selectReply(texts, nth);
  if (!picked) {
    return { ok: false, reason: 'no_reply' };
  }
  const ord = picked.ordinal === 1 ? '最近一条助手回复' : `从最近往回数第 ${picked.ordinal} 条助手回复`;
  if (codeOnly) {
    const blocks = extractCodeBlocks(picked.text);
    if (blocks.length === 0) {
      return { ok: false, reason: 'no_code' };
    }
    const payload = blocks.join('\n\n');
    const desc = `${ord}中的 ${blocks.length} 个代码块(${payload.length} 字)`;
    return { ok: true, payload, description: desc };
  }
  return { ok: true, payload: picked.text, description: `${ord}(${picked.text.length} 字)` };
}

module.exports = { isEnabled, parseCopyArgs, selectReply, extractCodeBlocks, buildCopyPayload };
