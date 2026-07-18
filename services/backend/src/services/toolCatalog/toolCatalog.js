'use strict';

/**
 * toolCatalog/toolCatalog.js — 「khy 拥有的所有工具」的分组目录（纯叶子）。
 *
 * goal「做一个工具列表当输入 /toollist 时可以看见 khy 拥有的所有工具」的单一真源:
 * 把工具注册表 SSOT(services/backend/src/tools 的 getAll/getByCategory)整形成
 * **按类分组、可浏览、可搜索**的工具目录,供 TUI/CLI `/toollist` 命令消费。
 *
 * 与 commandCatalog(命令索引)是姊妹关系:
 *   - commandCatalog → 斜杠命令(用户在 CLI/TUI 输入的 /xxx)
 *   - toolCatalog    → AI 工具(模型在推理中调用的 Read/Edit/Bash/… + MCP + 自定义)
 *
 * 契约(leaf-contract):零 IO(注入 registry)、确定性、绝不抛、门控
 * KHY_TOOL_CATALOG 默认开(关 → 空目录 {categories:[],total:0},消费方据此
 * 逐字节回退/隐藏入口)。本叶子只**读注册表并整形分组**,不发明工具,不执行工具。
 *
 * @module services/toolCatalog/toolCatalog
 */

/** 关闭词表(对齐仓库既有门控约定)。 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/**
 * 工具目录是否启用。默认开;仅当 KHY_TOOL_CATALOG 显式置关闭词才禁用。
 * @param {object} [env]
 * @returns {boolean}
 */
function toolCatalogEnabled(env = process.env) {
  try {
    const raw = String((env && env.KHY_TOOL_CATALOG) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 工具类别 → 中文标签 + 展示顺序。取值对齐 tools/_baseTool.js 的 CATEGORIES
 * (data/analysis/execution/filesystem/git/system/optimization/coordinator/
 * mcp/custom);未知类别兜底到「其他」。
 */
const CATEGORY_META = {
  filesystem:  { label: '文件读写', order: 1 },
  execution:   { label: '执行与 Shell', order: 2 },
  git:         { label: 'Git 版本控制', order: 3 },
  analysis:    { label: '分析与回测', order: 4 },
  data:        { label: '数据与行情', order: 5 },
  system:      { label: '系统与配置', order: 6 },
  optimization:{ label: '优化与提案', order: 7 },
  coordinator: { label: '多智能体编排', order: 8 },
  mcp:         { label: 'MCP 工具', order: 9 },
  custom:      { label: '自定义工具', order: 10 },
  other:       { label: '其他', order: 99 },
};

function _categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

/** 稳定字符串化(去两端空白;非字符串 → '')。 */
// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _s = require('../../utils/trimIfString');

/**
 * 从工具的 description(常是给模型的多行 prompt)派生一句简短摘要:取首个非空行,
 * 截断到 ~120 字。工具目录只需一眼可读的概述,不灌整段 prompt。
 * @param {string} desc
 * @returns {string}
 */
function _summarize(desc) {
  const s = _s(desc);
  if (!s) return '';
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  const clipped = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return clipped;
}

/**
 * 安全调用工具的 readOnly 判定(注册表工具把它挂成函数;缺失 → false)。
 * @param {object} tool
 * @returns {boolean}
 */
function _readOnly(tool) {
  try {
    return typeof tool.isReadOnly === 'function' ? !!tool.isReadOnly() : false;
  } catch { return false; }
}

/**
 * 把单个注册表工具规整为目录所需的最小、确定性字段。
 * @param {object} tool
 * @returns {{name,category,desc,readOnly,risk,aliases:string[]}|null}
 */
function _normalizeTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const name = _s(tool.name);
  if (!name) return null;
  const aliases = Array.isArray(tool.aliases)
    ? tool.aliases.map(_s).filter(Boolean)
    : [];
  return {
    name,
    category: _s(tool.category) || 'custom',
    desc: _summarize(tool.description),
    readOnly: _readOnly(tool),
    risk: _s(tool.risk) || 'medium',
    aliases,
  };
}

/**
 * 构建工具目录(纯函数,零 IO)。工具清单永远来自注册表 SSOT。
 *
 * @param {object} [deps] 依赖注入(测试用);缺省惰性 require tools 注册表。
 * @param {function} [deps.getAll] 返回 Map<name, toolDef>(注册表 getAll)
 * @param {object} [env]
 * @returns {{categories: Array<{key,label,order,tools:Array}>, total: number, generatedBy: string}}
 */
function buildToolCatalog(deps = {}, env = process.env) {
  const empty = { categories: [], total: 0, generatedBy: 'toolRegistry' };
  if (!toolCatalogEnabled(env)) return empty;

  let tools = [];
  try {
    const getAll = (deps && typeof deps.getAll === 'function')
      ? deps.getAll
      : require('../../tools').getAll;
    const map = getAll();
    // Map<name,tool> | Array | iterable → 值数组
    if (map && typeof map.values === 'function') tools = Array.from(map.values());
    else if (Array.isArray(map)) tools = map;
    else tools = [];
  } catch { return empty; }

  // 按 category 分组;按 name 去重(同名保留首个)。
  const buckets = new Map(); // catKey -> Map(name -> entry)
  for (const raw of tools) {
    const t = _normalizeTool(raw);
    if (!t) continue;
    const catKey = t.category || 'custom';
    if (!buckets.has(catKey)) buckets.set(catKey, new Map());
    const byName = buckets.get(catKey);
    if (byName.has(t.name)) continue; // 去重
    byName.set(t.name, t);
  }

  // 组装 categories:按 CATEGORY_META.order 排序,组内按 name 字母序;稳定确定性。
  const categories = [];
  for (const [key, byName] of buckets.entries()) {
    const meta = _categoryMeta(key);
    const list = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    categories.push({ key, label: meta.label, order: meta.order, tools: list });
  }
  categories.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));

  const total = categories.reduce((n, c) => n + c.tools.length, 0);
  return { categories, total, generatedBy: 'toolRegistry' };
}

module.exports = {
  toolCatalogEnabled,
  buildToolCatalog,
  CATEGORY_META,
  _summarize,
  _normalizeTool,
};
