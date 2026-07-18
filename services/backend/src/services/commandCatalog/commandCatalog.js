'use strict';

/**
 * commandCatalog/commandCatalog.js — 「khy 功能索引」的分组目录（纯叶子）。
 *
 * goal「khyos 应把设计的功能在 TUI 与前端网页 UI 中充分暴露，不要有了功能用户却
 * 不知去哪用」的单一真源：把命令注册表 SSOT(constants/commandSchema 的
 * getBuiltinSlashCommands)整形成**按类分组、可浏览、可搜索**的功能目录，供三处
 * 消费同一份数据：
 *   - TUI/CLI  `/features` 命令(router case)—— 主交互面一张总索引
 *   - HTTP     `GET /api/commands` —— 前端网页 UI 消费的桥
 *   - 前端     FeatureCatalog 视图 —— 网页导航里的「功能索引」入口
 *
 * 契约(leaf-contract)：零 IO、确定性、绝不抛、门控 KHY_COMMAND_CATALOG 默认开
 * (关 → 空目录 {categories:[],total:0}，各消费方据此逐字节回退/隐藏入口)。
 * 本叶子只**整形与分组**,不发明功能;命令清单永远来自 commandSchema SSOT。
 */

/** 关闭词表(对齐仓库既有门控约定)。 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/**
 * 功能目录是否启用。默认开;仅当 KHY_COMMAND_CATALOG 显式置关闭词才禁用。
 * @param {object} [env]
 * @returns {boolean}
 */
function commandCatalogEnabled(env = process.env) {
  try {
    const raw = String((env && env.KHY_COMMAND_CATALOG) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 类别 → 中文标签 + 展示顺序(与 commandSchema 使用的 category 取值对齐:
 * system / dev / workflow / analysis / security;未知类别兜底到「其他」)。
 */
const CATEGORY_META = {
  system:   { label: '系统与平台', order: 1 },
  dev:      { label: '开发与工程', order: 2 },
  workflow: { label: '工作流与编排', order: 3 },
  analysis: { label: '分析与洞察', order: 4 },
  security: { label: '安全与权限', order: 5 },
  data:     { label: '数据与存储', order: 6 },
  model:    { label: '模型与推理', order: 7 },
  other:    { label: '其他', order: 99 },
};

function _categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

/** 稳定字符串化(去两端空白;非字符串 → '')。 */
// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _s = require('../../utils/trimIfString');

/**
 * 构建功能目录(纯函数,零 IO)。
 *
 * @param {object} [deps] 依赖注入(测试用);缺省惰性 require commandSchema。
 * @param {function} [deps.getBuiltinSlashCommands] 返回 [{cmd,label,desc,route,category,...}]
 * @param {object} [env]
 * @returns {{categories: Array<{key,label,order,commands:Array<{cmd,name,label,desc,route}>}>, total: number, generatedBy: string}}
 */
function buildCommandCatalog(deps = {}, env = process.env) {
  const empty = { categories: [], total: 0, generatedBy: 'commandSchema' };
  if (!commandCatalogEnabled(env)) return empty;

  let list = [];
  try {
    const getList = (deps && typeof deps.getBuiltinSlashCommands === 'function')
      ? deps.getBuiltinSlashCommands
      : require('../../constants/commandSchema').getBuiltinSlashCommands;
    const raw = getList();
    list = Array.isArray(raw) ? raw : [];
  } catch { return empty; }

  // 别名折叠(收敛自审 #7「命令过载」的可发现性面):把声明式别名(COMMAND_ALIASES)从各自
  // 占位折叠到其 canonical 命令之下(canonical 挂 aliases[])。门控 KHY_COMMAND_PRIMARY_PANEL
  // 经 commandOverlapAudit.isPanelEnabled 集中判定,关 → foldAliases 为空 → 目录逐字节回退今日
  // 全量列举。别名 SSOT/门控不可用时 fail-soft 回退不折叠。
  let aliasByCmd = {};      // 别名 /cmd → canonical route(用于从列举中剔除别名条目)
  let aliasByRoute = new Map(); // canonical route → 折叠到其下的别名 /cmd[]
  let foldAliases = false;
  try {
    const { isPanelEnabled } = require('../commandOverlapAudit');
    const { getCommandAliases } = require('../../constants/commandSchema');
    if (isPanelEnabled(env)) {
      aliasByCmd = getCommandAliases() || {};
      for (const [aliasCmd, route] of Object.entries(aliasByCmd)) {
        const r = _s(route);
        if (!r) continue;
        if (!aliasByRoute.has(r)) aliasByRoute.set(r, []);
        aliasByRoute.get(r).push(aliasCmd);
      }
      foldAliases = Object.keys(aliasByCmd).length > 0;
    }
  } catch { foldAliases = false; aliasByCmd = {}; aliasByRoute = new Map(); }

  // 按 category 分组;每条命令规整为发现所需的最小字段。去重按 cmd。
  const buckets = new Map(); // catKey -> Map(cmd -> entry)
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const cmd = _s(item.cmd);
    if (!cmd) continue;
    if (foldAliases && Object.prototype.hasOwnProperty.call(aliasByCmd, cmd)) continue; // 别名折叠:不单独占位
    const name = cmd.replace(/^\/+/, '');
    if (!name) continue;
    const catKey = _s(item.category) || 'other';
    if (!buckets.has(catKey)) buckets.set(catKey, new Map());
    const byCmd = buckets.get(catKey);
    if (byCmd.has(cmd)) continue; // 去重
    const route = _s(item.route);
    const folded = (foldAliases && route && aliasByRoute.has(route))
      ? aliasByRoute.get(route).slice().sort() : [];
    byCmd.set(cmd, {
      cmd,
      name,
      label: _s(item.label) || name,
      desc: _s(item.desc) || _s(item.description) || '',
      route,
      ...(folded.length ? { aliases: folded } : {}),
    });
  }

  // 组装 categories:按 CATEGORY_META.order 排序,组内按 cmd 字母序;稳定确定性。
  const categories = [];
  for (const [key, byCmd] of buckets.entries()) {
    const meta = _categoryMeta(key);
    const commands = Array.from(byCmd.values()).sort((a, b) => a.cmd.localeCompare(b.cmd));
    categories.push({ key, label: meta.label, order: meta.order, commands });
  }
  categories.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));

  const total = categories.reduce((n, c) => n + c.commands.length, 0);
  return { categories, total, generatedBy: 'commandSchema' };
}

module.exports = {
  commandCatalogEnabled,
  buildCommandCatalog,
  CATEGORY_META,
};
