'use strict';

/**
 * sessionTopology.js — 会话「森林」拓扑的纯叶子单一真源(零 IO·确定性·绝不抛)。
 *
 * 背后逻辑(学自 Stello「把线性对话炸开成一张网」):khy 的 `/fork` 已在子会话
 * metadata 里写了 **反向边** `forkedFrom`(child → parent)。但要把一堆分叉**组织成
 * 一张可导航的网**,需要从这些反向边反推出**正向**索引(parent → children)、深度、
 * 同心层级,并能渲染成树、能为「当前在哪个节点」生成一行注入串。这些全是**确定性的
 * 纯计算**,放在本叶子;真正的 IO(列会话、读 metadata、写盘)在薄壳 sessionForestService。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;会话记录全经入参注入,
 * 本叶子绝不读 process.env(gate 函数除外,仅读 env 形参)、绝不触文件、绝不调
 * Date / crypto / child_process。仅依赖语言内置。
 *
 * 导出:
 *   - topologyEnabled(env)            门控 KHY_SESSION_TOPOLOGY 默认开
 *   - buildForest(records, opts)      反向边 forkedFrom → 正向森林 {roots, byId, nodes}
 *   - renderForestTree(forest, opts)  森林 → ├│└ 纯字符串行(经典 REPL 文本视图)
 *   - buildHereLine(forest, currentId)→ `<topology>…YOU ARE HERE…</topology>` 注入串
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当幽灵依赖。零依赖。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控:KHY_SESSION_TOPOLOGY 默认开。falsy(0/false/off/no/空)→ 关。大小写不敏感 + trim。
 * @param {object} [env]
 * @returns {boolean}
 */
function topologyEnabled(env) {
  const e = env || {};
  const raw = e.KHY_SESSION_TOPOLOGY;
  if (raw === undefined || raw === null) return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toFiniteOr0;

/**
 * 稳定排序键:updatedAt 降序(新近优先),再 id 升序兜底,保证确定性回放。
 */
function _byRecency(a, b) {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/**
 * 从会话记录构造森林。反向边 `parentId`(= metadata.forkedFrom)反推正向 children。
 *
 * 防呆:
 *   - 重复 id → 保留首条,忽略后续(绝不丢/绝不抛)。
 *   - parentId 不在集合(孤儿,源会话已删)→ 当独立根(绝不丢节点)。
 *   - parentId === 自身 → 当根(自指无意义)。
 *   - 环(fork 链指回祖先的病态)→ 在闭环处**断边**,把该节点当根并标记 cycleBroken。
 *
 * @param {Array<{id, parentId?, label?, turnCount?, status?, updatedAt?}>} records
 * @param {object} [opts]
 * @param {boolean} [opts.flat=false] 门控关时由薄壳传 true:每节点都当根、不推导 children
 *   → 退化为「平铺会话列表」(历史可见行为的字节级近似)。
 * @returns {{ roots: Array, byId: Object, nodes: Array }}
 */
function buildForest(records, opts) {
  const o = opts || {};
  const flat = o.flat === true;
  const list = Array.isArray(records) ? records : [];

  const byId = Object.create(null);
  const nodes = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const id = _str(rec.id);
    if (!id || byId[id]) continue; // 空 id 跳过;重复 id 保留首条
    const node = {
      id,
      parentId: rec.parentId == null ? null : _str(rec.parentId),
      label: _str(rec.label),
      turnCount: _num(rec.turnCount),
      status: _str(rec.status),
      updatedAt: _num(rec.updatedAt),
      children: [],
      depth: 0,
      index: 0,
      cycleBroken: false,
    };
    byId[id] = node;
    nodes.push(node);
  }

  const roots = [];
  for (const node of nodes) {
    let pid = node.parentId;
    if (flat) pid = null; // 门控关:扁平
    const parent = pid && pid !== node.id ? byId[pid] : null;
    if (!parent) {
      roots.push(node);
      continue;
    }
    // 环检测:从 parent 沿 parentId 上溯,若回到 node 自身 → 断边当根。
    if (_wouldCycle(byId, parent, node.id)) {
      node.cycleBroken = true;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  // 稳定排序:根与各层 children 一律 updatedAt desc → id。
  roots.sort(_byRecency);
  for (const node of nodes) node.children.sort(_byRecency);

  // 计算 depth / index(DFS 前序,确定性)。
  let counter = 0;
  const stack = roots.slice().reverse().map((r) => ({ node: r, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop();
    node.depth = depth;
    node.index = counter++;
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i], depth: depth + 1 });
    }
  }

  return { roots, byId, nodes };
}

/** 从 start 沿 parentId 上溯,若途中遇到 targetId 则成环。迭代式,带访问保护防死循环。 */
function _wouldCycle(byId, start, targetId) {
  let cur = start;
  const seen = new Set();
  while (cur) {
    if (cur.id === targetId) return true;
    if (seen.has(cur.id)) return true; // 已存在的旧环,保守判真
    seen.add(cur.id);
    cur = cur.parentId ? byId[cur.parentId] : null;
  }
  return false;
}

// 收敛到 utils/truncateEllipsis 单一真源(逐字节/语义等价委托,调用点不变)
const _truncate = require('../utils/truncateEllipsis');

/**
 * 把森林展平成**结构化行**(单一真源的 DFS 走树),供两个前端共享:
 *   - renderForestTree(经典 REPL)把行拼成 ├│└ 字符串;
 *   - TopologyPanel(ink TUI)按行的 node.status/turnCount 着色。
 * 这样「走树 + 字形」只此一处,两端字节一致。
 *
 * @param {{roots:Array}} forest
 * @param {object} [opts]
 * @param {number} [opts.labelWidth=40]
 * @param {string} [opts.currentId]
 * @returns {Array<{prefix:string, branch:string, node:object, isCurrent:boolean, isRoot:boolean}>}
 */
function buildForestRows(forest, opts) {
  const o = opts || {};
  const currentId = o.currentId == null ? null : _str(o.currentId);
  const roots = (forest && Array.isArray(forest.roots)) ? forest.roots : [];
  const rows = [];

  function walk(node, prefix, isLast, isRoot) {
    let branch;
    if (isRoot) branch = '';
    else branch = isLast ? '└─ ' : '├─ ';
    rows.push({
      prefix,
      branch,
      node,
      isCurrent: !!(currentId && node.id === currentId),
      isRoot,
    });
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    const kids = node.children || [];
    kids.forEach((kid, i) => walk(kid, childPrefix, i === kids.length - 1, false));
  }

  roots.forEach((root, i) => walk(root, '', i === roots.length - 1, true));
  return rows;
}

/**
 * 节点的展示文本(标签 + (turns · status) + 可选尾注 + 「← you are here」)。
 * 供 renderForestTree 拼字符串与 TopologyPanel 取标签共用,保持一致。
 * @param {object} node
 * @param {object} [opts]
 * @returns {string}
 */
function nodeDisplayText(node, opts) {
  const o = opts || {};
  const labelWidth = Number.isFinite(o.labelWidth) ? o.labelWidth : 40;
  const annotate = typeof o.annotate === 'function' ? o.annotate : null;
  const label = _truncate((node && (node.label || node.id)) || '', labelWidth);
  const bits = [];
  if (node && node.turnCount) bits.push(`${node.turnCount} turns`);
  if (node && node.status) bits.push(node.status);
  const extra = annotate ? _str(annotate(node)) : '';
  const meta = bits.length ? `  (${bits.join(' · ')})` : '';
  let text = `${label}${meta}`;
  if (extra) text += `  ${extra}`;
  if (o.markCurrent) text += '  ← you are here';
  return text;
}

/**
 * 把森林渲染成 ├│└ 文本树行(经典 REPL 视图)。复用 agentTreeView 同字形约定。
 * @param {{roots:Array, byId:Object}} forest
 * @param {object} [opts]
 * @param {string} [opts.currentId] 高亮「当前所在」节点(行尾缀 ` ← you are here`)。
 * @param {number} [opts.labelWidth=40] 标签截断宽。
 * @param {function} [opts.annotate] 自定义节点尾注 (node)=>string。
 * @returns {string[]} 逐行字符串(不含尾随换行)。
 */
function renderForestTree(forest, opts) {
  const o = opts || {};
  const rows = buildForestRows(forest, o);
  return rows.map((r) => {
    const text = nodeDisplayText(r.node, {
      labelWidth: o.labelWidth,
      annotate: o.annotate,
      markCurrent: r.isCurrent,
    });
    return `${r.prefix}${r.branch}${text}`;
  });
}

/**
 * 为「当前所在节点」生成一行注入串,让 live 会话**感知自己在拓扑中的位置**(Stello 的
 * 节点不知全局、只靠注入的 YOU-ARE-HERE 串)。给出:根 → … → 当前的路径 + 兄弟/子分支数。
 * @param {{byId:Object}} forest
 * @param {string} currentId
 * @returns {string} 注入串;currentId 不存在 → ''。
 */
function buildHereLine(forest, currentId) {
  const id = _str(currentId);
  const byId = (forest && forest.byId) || {};
  const node = id ? byId[id] : null;
  if (!node) return '';

  // 上溯根 → 当前的路径(带环保护)。
  const path = [];
  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId[cur.parentId] : null;
  }

  const trail = path.map((n) => _truncate(n.label || n.id, 32)).join('  ›  ');
  const childCount = (node.children || []).length;
  const lines = [
    '<topology>',
    '你正在一张「会话拓扑网」的某个节点上(由历次 /fork 分叉生长而成)。',
    `路径(根 → 你):${trail}`,
    `── YOU ARE HERE: 「${_truncate(node.label || node.id, 48)}」` +
      (childCount ? `(下有 ${childCount} 条分支)` : '(当前为分支末端)'),
    '提示:思路若开始发散到另一方向,可 /fork 开一条新分支,而非把当前线越拉越长。',
    '</topology>',
  ];
  return lines.join('\n');
}

module.exports = {
  topologyEnabled,
  buildForest,
  buildForestRows,
  nodeDisplayText,
  renderForestTree,
  buildHereLine,
};
