'use strict';

/**
 * webToolsFormat.js — 纯叶子 (pure leaf)：把 khy 的「联网搜索后端 + 动态引擎配置」
 * 现状渲染成一段给用户看的中文块。对齐 Claude Code `/web-tools`（查看/配置 web
 * search 与 web fetch 后端）。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_WEB_TOOLS)。
 *   本叶子不连网/不读盘/不探测——后端可用性、动态引擎清单、配置文件路径全部由
 *   调用方 (handlers/webTools.js 经 services/webToolsService.js) 采集后作为参数
 *   传入，叶子只做确定性的分组、排序稳定（保持输入顺序）与文案组装。
 *
 * 为什么存在 (缺口)：Claude Code 有 `/web-tools` 展示并切换 web search / fetch 后端；
 *   khy 已有整套联网搜索基建——Kiro MCP 主后端 (webSearchService.isAvailable)、
 *   运行期动态引擎 (searchSourceDiscovery.loadDynamicEngines 读 KHY_SEARCH_EXTRA_ENGINES
 *   与数据家 search_engines.json)、HTML 抓取解析 (isHtmlParsingAvailable)——但**没有
 *   任何命令把这些配置浮现给用户**，用户只能手改 JSON / env。这是普查里「ABSENT +
 *   实质逻辑 + 诚实可移植（基建已在）」的槽位。
 *
 * 诚实边界：
 *   - **只读**：本命令只「查看」当前后端与引擎配置，并给出编辑指引（改 search_engines.json
 *     或 KHY_SEARCH_EXTRA_ENGINES）。CC 的写入式 TUI（把密钥/端点写进 settings.json）
 *     刻意不移植——那会持久化敏感配置且是更大的交互面，留作后续；本刀只忠实浮现现状。
 *   - 只负责**文案**；可用性探测 / 读盘 / loadDynamicEngines 全在 service。
 *   - 门控关 / 坏输入 → 返回 null → handler 不接管（字节回退：命令视作未知）。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 动态引擎来源 → 友好中文。未列出的原样显示。
const ORIGIN_LABELS = {
  env: '环境变量 KHY_SEARCH_EXTRA_ENGINES',
  config: '配置文件 search_engines.json',
};

/** 是否启用 `/web-tools`（门控 KHY_WEB_TOOLS 默认开）。 */
function webToolsEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_WEB_TOOLS) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 布尔 → 「可用 / 不可用」（带符号），供后端/解析状态行复用。 */
function _avail(ok) {
  return ok ? '✓ 可用' : '✗ 不可用';
}

/** 单条动态引擎渲染：名称 · 解析器 · 权重 · 来源。 */
function _engineLine(e) {
  if (!e || typeof e !== 'object') return '  · (无效引擎项)';
  const name = String(e.name || '(未命名)');
  const parser = String(e.parser || 'generic');
  const w = Number(e.weight);
  const weight = Number.isFinite(w) ? w.toFixed(2) : '0.50';
  const origin = ORIGIN_LABELS[e.origin] || (e.origin ? String(e.origin) : '未知来源');
  return `  · ${name}（解析器 ${parser}·权重 ${weight}·来自${origin}）`;
}

/**
 * 把采集到的联网搜索后端/引擎现状渲染成中文块。
 *
 * @param {Object} data
 * @param {{name:string, available:boolean}} [data.backend]  主搜索后端（Kiro MCP）
 * @param {{htmlParsing:boolean}} [data.fetch]               抓取解析（HTML/cheerio）
 * @param {{enabled:boolean, flag:string}} [data.discovery]  动态引擎发现闸
 * @param {Array<{name,parser,weight,origin}>} [data.engines] 已加载的动态引擎
 * @param {string[]} [data.knownParsers]                     可复用的解析器家族
 * @param {string} [data.configPath]                         search_engines.json 绝对路径
 * @param {boolean} [data.envEngineDeclared]                 KHY_SEARCH_EXTRA_ENGINES 是否已声明
 * @param {Object} [env]
 * @returns {string|null}  渲染文本，或 null（门控关 / 坏输入）
 */
function formatWebTools(data, env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    if (!webToolsEnabled(env)) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const backend = data.backend && typeof data.backend === 'object' ? data.backend : {};
    const fetch = data.fetch && typeof data.fetch === 'object' ? data.fetch : {};
    const discovery = data.discovery && typeof data.discovery === 'object' ? data.discovery : {};
    const engines = Array.isArray(data.engines) ? data.engines : [];
    const knownParsers = Array.isArray(data.knownParsers) ? data.knownParsers : [];

    const lines = [];
    lines.push('联网搜索后端与引擎配置（对齐 Claude Code /web-tools·只读查看）');
    lines.push('');

    // 1) 搜索后端
    lines.push(`搜索后端：${String(backend.name || 'Kiro MCP')} ${_avail(!!backend.available)}`);
    if (!backend.available) {
      lines.push('  提示：主搜索后端不可用时会降级到公开引擎兜底（若已配置动态引擎/解析器）。');
    }

    // 2) 抓取解析
    lines.push(`网页抓取解析：HTML 解析 ${_avail(!!fetch.htmlParsing)}`);
    if (!fetch.htmlParsing) {
      lines.push('  提示：缺 HTML 解析库时 WebFetch 退化为纯文本抓取。');
    }

    // 3) 动态引擎发现
    const discFlag = String(discovery.flag || 'KHY_SEARCH_SOURCE_DISCOVERY');
    lines.push('');
    lines.push(`动态引擎发现：${discovery.enabled ? '开' : '关'}（门控 ${discFlag}）`);
    if (engines.length === 0) {
      lines.push('  当前未加载任何动态引擎。');
    } else {
      lines.push(`  已加载 ${engines.length} 个动态引擎：`);
      for (const e of engines) lines.push(_engineLine(e));
    }

    // 4) 可用解析器家族
    if (knownParsers.length > 0) {
      lines.push('');
      lines.push(`可复用解析器：${knownParsers.join('、')}`);
    }

    // 5) 配置指引（只读命令 → 告诉用户去哪里改）
    lines.push('');
    lines.push('配置方式（本命令只读，编辑走以下两处任一）：');
    if (data.configPath) {
      lines.push(`  · 配置文件：${String(data.configPath)}`);
    }
    lines.push('  · 环境变量：KHY_SEARCH_EXTRA_ENGINES=（JSON 数组）'
      + `${data.envEngineDeclared ? ' [已声明]' : ''}`);
    lines.push('  · 引擎项格式：{ "name": "myengine", "url": "https://x/search?q={q}", "parser": "generic", "weight": 0.5 }');

    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  webToolsEnabled,
  formatWebTools,
  ORIGIN_LABELS,
};
