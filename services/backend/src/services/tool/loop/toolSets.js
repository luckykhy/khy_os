'use strict';

/**
 * loop/toolSets.js — 只读成员集合（纯叶子 · T-021 棘轮 · 零 require · 零 IO）
 *
 * 从 toolUseLoopCore.js 顶部「Constants」区逐字节抽出的 7 个字面量成员 Set。它们过去
 * 在 runToolUseLoop 的每调用 / 每迭代 / 每结果热路径里以 `new Set([...literals])` 重建
 * （Ch2「不要每轮重建可复用结构」），现统一在模块加载时构建一次。全部仅字面量、只读经
 * `.has`、从不 mutate、从不逃逸 → 安全共享，且三族刻意分立（成员按用途不同，勿合并）：
 *   - DEDUP_READ_ONLY_TOOLS: 同调用去重豁免（读后即读合法）
 *   - IDLE_READ_ONLY_TOOLS:  空闲轮次追踪（AI 只读不动作）
 *   - READ_ONLY_SHELL_CMDS:  计入只读活动的 shell 二进制
 * 本叶子零 back-edge（不 require 核心任何绑定）→ 不引入 managed↔managed 环（M6）。
 * 核心经 `const { … } = require('./loop/toolSets')` 再绑定，所有体内消费点、尾部
 * `_*` 别名导出、以及 steering/toolUseLoopHelpers 的 DI 注入均解析到同一 Set 引用。
 */

const DEDUP_READ_ONLY_TOOLS = new Set([
  'read_file',
  'readfile',
  'readFile',
  'read',
  'grep',
  'rg',
  'search',
  'glob',
  'find',
  'ls',
  'LS',
  'quote',
  'data_fetch',
  'web_search',
  'webSearch',
  'websearch',
  'git_status',
  'git_diff',
  'git_log',
  'GetLocation',
  'getLocation',
]);

const IDLE_READ_ONLY_TOOLS = new Set([
  'read_file',
  'readFile',
  'search',
  'toolSearch',
  'git_status',
  'gitStatus',
  'git_diff',
  'gitDiff',
  'git_log',
  'strategy_list',
  'strategyList',
  'quote',
  'grep',
  'glob',
  'ls',
  'webSearch',
  'web_search',
  'webFetch',
  'notebookRead',
]);

const READ_ONLY_SHELL_CMDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'file',
  'stat',
  'pwd',
  'which',
  'echo',
  'tree',
  'du',
  'df',
]);

// Further literal-only membership sets hoisted out of per-call function bodies
// (Ch2「不要每轮重建可复用结构」). Each was formerly a `new Set([...literals])`
// rebuilt on every call; all are consumed read-only via `.has`, never mutated,
// never escape — safe to build once at module load.
const _AUTO_WEB_SEARCH_MODES = new Set(['auto', 'news', 'docs', 'academic', 'general']);

const _DELIVERY_NUDGE_STOPWORDS = new Set([
  'please',
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'then',
  'also',
  'just',
  'make',
  'want',
  'need',
  'would',
  'should',
  'could',
  'can',
  'will',
  'into',
  '让',
  '把',
  '给',
  '用',
  '到',
  '了',
  '在',
  '是',
  '的',
  '被',
  '请',
  '要',
  '会',
  '就',
  '能',
]);

const _APP_TARGET_PROBE_BINS = new Set([
  'which',
  'whereis',
  'command',
  'type',
  'ps',
  'pgrep',
  'pidof',
  'grep',
  'bash',
  'sh',
  'zsh',
  'env',
  'nohup',
]);

const _SEARCH_TERM_STOPWORDS = new Set([
  '帮我',
  '请',
  '麻烦',
  '一下',
  '搜索',
  '搜一下',
  '查一下',
  '查查',
  '查找',
  '查询',
  '今天',
  '今日',
  '最新',
  '新闻',
  '热点',
  '热搜',
  '资料',
  '信息',
  '网页',
  '联网',
  '内网',
  'search',
  'find',
  'lookup',
  'look',
  'up',
  'latest',
  'today',
  'news',
  'trending',
  'please',
  'help',
  'me',
]);

module.exports = {
  DEDUP_READ_ONLY_TOOLS,
  IDLE_READ_ONLY_TOOLS,
  READ_ONLY_SHELL_CMDS,
  _AUTO_WEB_SEARCH_MODES,
  _DELIVERY_NUDGE_STOPWORDS,
  _APP_TARGET_PROBE_BINS,
  _SEARCH_TERM_STOPWORDS,
};
