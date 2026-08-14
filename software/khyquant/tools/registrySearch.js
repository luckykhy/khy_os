const { defineTool } = require('./_baseTool');

/**
 * registrySearch — 让 AI agent 直接查 npm / PyPI 公共仓库的可调面。
 *
 * goal「khy 应能查看 pip/npm 仓库;用户问『仓库里有没有合适的开源包』时 khy 要知道」。
 * 之前 agent 只有 manageDeps(本地项目装/删)与 curated 依赖表(自愈),没有「按关键词/名字
 * 到 npm/PyPI 发现包」的面 → 用户问「有没有合适的开源库」时只能瞎猜或空搜。本工具补齐。
 *
 * 委托纯网络叶子 packageRegistryService(门控 KHY_PACKAGE_REGISTRY 默认开、只读、绝不抛)。
 */
module.exports = defineTool({
  name: 'registrySearch',
  description:
    'Search public package registries (npm and PyPI) for open-source packages. ' +
    'Use when the user asks whether a suitable open-source library/package exists, ' +
    'or wants a package\'s latest version / metadata. Actions: search (by keyword), info (exact name).',
  category: 'data',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  aliases: ['registry_search', 'npm_search', 'pypi_search', 'package_search', 'search_packages', 'find_package'],
  shouldDefer: true,
  searchHint:
    'search npm pypi package registry for open source library packages 查 npm pip 仓库有没有合适的开源库包 '
    + 'find package latest version metadata 是否存在某个包 pip install npm install candidate',

  prompt() {
    return `Search the public npm and PyPI package registries for open-source packages.

Use this whenever the user asks things like:
- "有没有合适的开源库/包来做 X?" / "Is there an open-source package for X?"
- "npm/pip 上有没有 X?" — check whether a package exists.
- "X 这个包最新版本是多少 / 是干嘛的?" — get a package's version and metadata.

Parameters:
  query    — REQUIRED. A keyword phrase (for action="search") or an exact package
             name (for action="info", e.g. "express", "requests", "@vue/cli").
  registry — "npm", "pypi", or "auto" (default). "auto" queries both.
  action   — "search" (default, keyword discovery) or "info" (exact-name metadata).
  limit    — max results for search (default 10, max 25).

Notes:
- npm search uses the official registry JSON API (reliable, ranked).
- PyPI has NO public keyword-search JSON API; its search page is now a JS challenge.
  For registry="pypi" + action="search" this tool honestly degrades to a
  web-search-over-pypi.org + PyPI-JSON-API enrichment (best-effort, marked
  method="web-search-fallback"). For a precise PyPI lookup, prefer action="info"
  with an exact package name — that hits the official JSON API directly.
- Results include name, version, description, homepage/repository, and links.
Report findings faithfully; do not invent packages that the registries did not return.`;
  },

  inputSchema: {
    query: {
      type: 'string',
      required: true,
      description: 'Keyword phrase (action="search") or exact package name (action="info").',
    },
    registry: {
      type: 'string',
      required: false,
      enum: ['npm', 'pypi', 'auto'],
      description: 'Target registry. Default "auto" (both).',
    },
    action: {
      type: 'string',
      required: false,
      enum: ['search', 'info'],
      description: '"search" = keyword discovery (default); "info" = exact-name metadata.',
    },
    limit: {
      type: 'number',
      required: false,
      description: 'Max search results (default 10, max 25).',
    },
  },

  async execute(params, context) {
    const toolErrorCodes = require('../services/toolErrorCodes');
    try {
      const svc = require('../services/packageRegistryService');
      const result = await svc.queryRegistry({
        query: params.query,
        registry: params.registry,
        action: params.action,
        limit: params.limit,
      });
      if (result && result.success === false) {
        // 如实传播失败(含 depId,供依赖自愈漏斗接管缺失的 web 搜索依赖)。
        return toolErrorCodes.enrich({ success: false, error: result.error || 'registry query failed', depId: result.depId, data: result });
      }
      return { success: true, data: result };
    } catch (err) {
      return toolErrorCodes.enrich({ success: false, error: err.message });
    }
  },
});
