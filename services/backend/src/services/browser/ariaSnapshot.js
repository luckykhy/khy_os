'use strict';

/**
 * ariaSnapshot.js — 纯叶子 (pure leaf)：把 Playwright 的「agent-first」浏览范式
 * （可访问性树快照 + 稳定 ref 句柄 + locator-first 选择 + 自动等待可操作性）里的
 * **确定性判断**收成单一真源。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、单一真源、无副作用、env 门控默认开
 *   (KHY_BROWSER_ARIA)。本模块只做**确定性的文本序列化与判定**（纯字符串 / 数值运算，
 *   绝不碰 fs / 子进程 / 网络 / Playwright）；真正的 page.evaluate（在页内遍历 DOM 算
 *   role/name、给元素打 data-khy-ref）与 page.getByRole / waitForSelector 等 IO 由
 *   browser/session.js 的 snapshotForAI / actByRef / locate 执行。
 *
 * 设计意图（为什么把判断收进纯叶子）：
 *   Playwright 让 agent **不靠截图、不靠脆弱的 CSS/XPath**，而是把页面读成一棵
 *   `- textbox "搜索" [ref=e5]` 这样的可读树，再用 getByRole/getByText 这类语义化、
 *   抗变化的 locator 行动，并在行动前自动等待元素「可操作」。这些「树怎么排版」「locator
 *   怎么映射到原生方法」「什么算可操作」「ref 怎样安全地转成选择器」的规则，固化成可单测的
 *   确定性纯函数，让 IO 层只负责执行，且杜绝把 agent 传入的 ref 直接拼进选择器（注入红线）。
 *
 * 门控：KHY_BROWSER_ARIA 默认开，置 {0,false,off,no} 关闭后 snapshotForAI 降级为
 *   纯 innerText 文本转储（session.js 负责降级；本叶子只提供 isEnabled 判定）。
 */

const OFF_VALUES = Object.freeze(['0', 'false', 'off', 'no']);

/** 是否启用 aria 快照（门控关 → snapshotForAI 降级为纯文本转储）。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_BROWSER_ARIA) != null ? env.KHY_BROWSER_ARIA : '')
    .trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 快照节点数硬上界：默认 2000，夹到 [1, 5000]，防超大页爆快照。 */
function clampMax(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  return Math.min(Math.round(n), 5000);
}

/** 归一可访问名：折叠空白、转义内嵌引号、截断到 120 字（确定性，绝不抛）。 */
function escapeName(name) {
  const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  return s.slice(0, 120).replace(/"/g, '\\"');
}

/**
 * 把单个 aria 节点排成 Playwright 风格的一行：
 *   `  - role "name" [level=2] [checked] [ref=e5]`
 * 缩进 = 2 空格 × depth；ref 永远放最后（镜像 Playwright MCP 把 ref 追加在 aria 行尾）。
 */
function formatNode(node) {
  if (!node || typeof node !== 'object') return '';
  const depth = Number.isFinite(node.depth) && node.depth > 0 ? Math.floor(node.depth) : 0;
  const role = String(node.role || 'generic').trim() || 'generic';
  let line = `${'  '.repeat(depth)}- ${role}`;

  const name = escapeName(node.name);
  if (name) line += ` "${name}"`;

  const props = [];
  if (Number.isFinite(node.level) && node.level > 0) props.push(`level=${Math.floor(node.level)}`);
  if (node.checked === true) props.push('checked');
  else if (node.checked === 'mixed') props.push('checked=mixed');
  if (node.selected === true) props.push('selected');
  if (node.expanded === true) props.push('expanded');
  if (node.disabled === true) props.push('disabled');
  for (const p of props) line += ` [${p}]`;

  if (node.ref) line += ` [ref=${String(node.ref)}]`;
  return line;
}

/**
 * 把一组（已在页内算好 depth/role/name/ref 的）节点序列化成可读的可访问性树文本。
 * 输入非数组 / 空 → 空串。绝不抛。
 */
function serializeAriaTree(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return '';
  const out = [];
  for (const n of nodes) {
    if (n && typeof n === 'object') {
      const line = formatNode(n);
      if (line) out.push(line);
    }
  }
  return out.join('\n');
}

// ── ref → 选择器（注入红线）────────────────────────────────────────────────
// ref 只可能是快照里自家发的 `e<数字>`。绝不把任意字符串拼进属性选择器，
// 否则 agent 传入的 ref 可越权选中/注入属性匹配语法。
const REF_RE = /^e\d+$/;

/** 把 ref（形如 e5）转成 `[data-khy-ref="e5"]` 选择器;非法 ref → null（绝不拼接）。 */
function refSelector(ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (!REF_RE.test(r)) return null;
  return `[data-khy-ref="${r}"]`;
}

// ── 自动等待：什么算「可操作」─────────────────────────────────────────────
/**
 * 据元素状态判定是否可操作（Playwright auto-wait 的可单测真源）。
 * @param {{attached?:boolean, visible?:boolean, enabled?:boolean}} state
 * @returns {{actionable:boolean, reason:string}}
 */
function decideActionable(state = {}) {
  const s = state || {};
  if (s.attached === false) return { actionable: false, reason: 'not-attached' };
  if (s.visible === false) return { actionable: false, reason: 'not-visible' };
  if (s.enabled === false) return { actionable: false, reason: 'disabled' };
  return { actionable: true, reason: 'ok' };
}

// ── locator-first：by → 原生 getBy* 方法（单一真源）──────────────────────
const LOCATOR_METHODS = Object.freeze({
  role: 'getByRole',
  text: 'getByText',
  label: 'getByLabel',
  testid: 'getByTestId',
  placeholder: 'getByPlaceholder',
  alttext: 'getByAltText',
  title: 'getByTitle',
});

/**
 * 把 agent 给的语义化选择意图归一成「调哪个原生 getBy* + 传什么参」的描述。
 * session.js 据此执行 `page[method](primary, options)`；这里不碰 Playwright，只产描述。
 *
 * @param {{by?:string, role?:string, name?:string, value?:string, exact?:boolean}} opts
 * @returns {{method:string, primary:string, options?:object}|null}  非法 → null（绝不抛）
 */
function buildLocatorSpec(opts = {}) {
  const o = opts || {};
  const by = String(o.by || '').trim().toLowerCase();
  const method = LOCATOR_METHODS[by];
  if (!method) return null;
  const exact = o.exact === true;

  if (by === 'role') {
    const role = String(o.role || '').trim().toLowerCase();
    if (!role) return null;
    const options = {};
    const name = o.name != null ? String(o.name) : '';
    if (name) options.name = name;
    if (exact) options.exact = true;
    return { method, primary: role, options: Object.keys(options).length ? options : undefined };
  }

  const value = o.name != null ? String(o.name) : (o.value != null ? String(o.value) : '');
  if (!value) return null;
  if (by === 'testid') return { method, primary: value, options: undefined };
  return { method, primary: value, options: exact ? { exact: true } : undefined };
}

/** locate 支持的动作集合（单一真源,供 IO 层与 schema 对齐）。 */
const LOCATOR_ACTIONS = Object.freeze(['text', 'count', 'click', 'fill', 'check']);
/** actByRef 支持的动作集合。 */
const REF_ACTIONS = Object.freeze(['click', 'fill', 'type', 'check', 'text']);

module.exports = {
  isEnabled,
  clampMax,
  escapeName,
  formatNode,
  serializeAriaTree,
  refSelector,
  decideActionable,
  buildLocatorSpec,
  LOCATOR_METHODS,
  LOCATOR_ACTIONS,
  REF_ACTIONS,
};
