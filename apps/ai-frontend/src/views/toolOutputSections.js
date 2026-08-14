/**
 * toolOutputSections.js — 纯函数:把 `=== label ===` 分节表头的命令输出解析成带标题的分节块。
 *
 * 背景:后端(shellTransparency)教模型用 `echo "=== label ==="` 表头分隔一条命令里的多个
 * 步骤,CLI 侧本就逐行展示;但前端(AIChat.vue)把工具结果压成**单行省略**,结构被抹平,
 * 用户看不到 CC 那样的分节展示。本工具把带表头的输出切成 [{title, body}] 供前端渲染。
 *
 * 契约:零依赖、确定性、绝不抛。**无表头 → 返回 null**(调用方据此逐字节回退到今日的单行渲染)。
 * 表头形态与后端教的规范一致:`===` 空格 label 空格 `===`,单独成行(允许两侧空白、
 * `=` 数量 ≥3、以对齐用户可能多敲的 `====`)。表头之前的内容归入一个无标题前置块(title=null)。
 */

// 单独成行的分节表头:^ 空白* ={3,} 空白+ <label> 空白+ ={3,} 空白* $。label 非空、不含 `=` 边界歧义。
const HEADER_RE = /^[ \t]*={3,}[ \t]+(.+?)[ \t]+={3,}[ \t]*$/;

/**
 * 解析命令输出为分节块。
 * @param {string} text 原始命令输出(工具结果 text)。
 * @returns {Array<{title: string|null, body: string}>|null}
 *   有 `=== label ===` 表头 → 分节数组(前置无标题内容 title=null);无表头或空输入 → null。
 */
export function parseToolOutputSections(text) {
  if (typeof text !== 'string' || text === '') return null;
  const lines = text.split('\n');
  const sections = [];
  let cur = null; // { title, bodyLines[] }

  const flush = () => {
    if (!cur) return;
    // body 去掉首尾空行,保留内部结构;空 body 也保留(表头本身即信息)。
    const body = cur.bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    sections.push({ title: cur.title, body });
  };

  let sawHeader = false;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      sawHeader = true;
      flush();
      cur = { title: m[1].trim(), bodyLines: [] };
    } else {
      if (!cur) cur = { title: null, bodyLines: [] };
      cur.bodyLines.push(line);
    }
  }
  flush();

  if (!sawHeader) return null; // 无表头 → 交回调用方按原样(单行)渲染
  // 丢弃「无标题且 body 为空」的前置块(表头前无内容时不产生空白块)。
  const cleaned = sections.filter((s) => s.title !== null || s.body !== '');
  return cleaned.length ? cleaned : null;
}

export default { parseToolOutputSections };
