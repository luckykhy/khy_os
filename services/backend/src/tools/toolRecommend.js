/**
 * toolRecommend —— 纯叶子:工具推荐打分核心(零 IO / 确定性 / fail-soft / 单一真源)。
 *
 * 把「按关键词给工具打分」这套确定性逻辑从 toolSearch.js 抽出来,作为唯一真源,
 * 既被 model-facing 的 `toolSearch` 工具复用(行为逐字节不变),又对外暴露可编程调用的
 * `recommendTools(query, tools)`——给定任务描述,返回最匹配的前 N 个工具(P1.3 推荐引擎)。
 *
 * 纯叶子契约:不读文件 / 不起进程 / 不碰 registry;工具清单由调用方传入(数组或 Map)。
 * 门控 `KHY_TOOL_RECOMMEND` 默认开,仅 0/false/off/no 关 → `recommendTools` 返回 [](字节回退);
 * `parseToolName` / `scoreTool` 是 toolSearch 依赖的无条件纯函数,不随门控变化。
 */
'use strict';

const DISABLED = new Set(['0', 'false', 'off', 'no']);

/** @returns {boolean} 门控:默认开,仅 0/false/off/no 关。 */
function _enabled() {
  const v = process.env.KHY_TOOL_RECOMMEND;
  return v == null || !DISABLED.has(String(v).trim().toLowerCase());
}

/**
 * 把工具名拆成可搜索的词块。兼容 camelCase / snake_case / mcp__server__tool。
 * @param {string} name
 * @returns {{ parts: string[], full: string }}
 */
function parseToolName(name) {
  if (!name) return { parts: [], full: '' };

  // MCP tools: mcp__server__tool → [server, tool]
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase();
    const parts = withoutPrefix.split('__').flatMap((p) => p.split('_'));
    return { parts, full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' ') };
  }

  // CamelCase → parts: readFile → [read, file]
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return { parts, full: parts.join(' ') };
}

/**
 * 给定查询词,给单个工具打分(分越高越匹配)。权重与历史 toolSearch 完全一致。
 * @param {object} tool
 * @param {string[]} queryTerms - 已小写化的查询 token
 * @returns {number}
 */
function scoreTool(tool, queryTerms) {
  if (!tool || !Array.isArray(queryTerms)) return 0;
  let score = 0;

  const { parts: nameParts, full: nameFull } = parseToolName(tool.name);
  const desc = (tool.description || '').toLowerCase();
  const hint = (tool.searchHint || '').toLowerCase();
  const aliases = (tool.aliases || []).map((a) => String(a).toLowerCase());
  const nameLower = (tool.name || '').toLowerCase();

  for (const term of queryTerms) {
    if (nameLower === term) { score += 10; continue; }       // 精确名
    if (aliases.includes(term)) { score += 8; continue; }    // 别名
    if (nameParts.includes(term)) { score += 5; continue; }  // 名字词块
    if (nameFull.includes(term)) { score += 3; continue; }   // 名字子串
    if (hint.includes(term)) { score += 4; continue; }       // searchHint
    if (desc.includes(term)) { score += 2; continue; }       // 描述
  }

  return score;
}

/**
 * 推荐引擎:给定自然语言任务描述,从候选工具里挑出最匹配的前 N 个(P1.3)。
 * 纯函数——候选工具由调用方传入(数组 / Map / iterable of [name, tool]),不碰 registry。
 *
 * @param {string} query - 用户任务描述
 * @param {Array<object>|Map<string,object>|Iterable} tools - 候选工具
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - 返回数量上界(P1.3 要求 3-5 个)
 * @param {string[]} [opts.exclude] - 排除的工具名(如 'toolSearch' 自身)
 * @returns {Array<{ name, score, category, description }>} 按分降序;门控关 / 入参非法 → []
 */
function recommendTools(query, tools, opts = {}) {
  if (!_enabled()) return [];
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || !tools) return [];

  const queryTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return [];

  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const exclude = new Set(Array.isArray(opts.exclude) ? opts.exclude : []);

  // 归一化候选为 tool 对象列表(吃 Map / 数组 / [name,tool] iterable)。
  const list = [];
  const push = (t) => { if (t && typeof t === 'object' && t.name) list.push(t); };
  if (tools instanceof Map) {
    for (const [, t] of tools) push(t);
  } else if (Array.isArray(tools)) {
    for (const t of tools) push(t);
  } else if (typeof tools[Symbol.iterator] === 'function') {
    for (const entry of tools) push(Array.isArray(entry) ? entry[1] : entry);
  }

  const scored = [];
  for (const tool of list) {
    if (exclude.has(tool.name)) continue;
    const score = scoreTool(tool, queryTerms);
    if (score > 0) scored.push({ tool, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ tool, score }) => ({
    name: tool.name,
    score,
    category: tool.category || 'custom',
    description: tool.description || '',
  }));
}

module.exports = { parseToolName, scoreTool, recommendTools, _enabled };
