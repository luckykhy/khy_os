'use strict';

/**
 * historyReverseSearch.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 对齐 Claude Code 的 Ctrl+R 反向增量历史搜索的**决策核心**。khy 的命令历史两处数据源
 * 都已存在(session 内存 `history.current` + 持久化 `~/.khyquant_history`,见 cli/repl/history.js),
 * 此前唯缺「按 query 从最新往回增量匹配」这条搜索逻辑与其交互。本叶子只做纯搜索计算,
 * 绝不触文件、绝不渲染 —— IO 与 Ink 浮层留给薄壳(App.js / HistorySearchOverlay.js)。
 *
 * 语义(对齐 CC / bash reverse-i-search):
 *   - 输入 history 是**旧→新**数组(与 loadHistory 返回序一致,末尾最新);
 *   - 空 query → 无匹配(current='',index=-1),等待用户键入;
 *   - 有 query → 大小写不敏感子串匹配,结果按**新→旧**排序(最新命中先选中);
 *   - Ctrl+R 再按 → nextMatch 前进到更旧的一条(index+1),到末尾停住(不回绕,与 bash 一致)。
 *
 * 门控:KHY_HISTORY_REVERSE_SEARCH(default-on;0/false/off/no 关闭 → isEnabled false,
 * 薄壳据此完全不激活该浮层,逐字节回退「Ctrl+R 落到 textInput 无操作」现状)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 反向历史搜索是否启用。默认开;仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_HISTORY_REVERSE_SEARCH;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return true;
  }
}

/**
 * 在历史里做一次反向子串搜索,返回可直接驱动浮层的状态对象。
 *
 * @param {string[]} history 命令历史(旧→新)
 * @param {string} query 搜索词
 * @param {object} [opts]
 *   @param {number} [opts.from=0] 选中第几条匹配(0=最新命中);越界则 clamp。
 * @returns {{ query:string, matches:number[], index:number, current:string }}
 *   matches: 命中项在原 history 里的下标,按新→旧序;
 *   index:   当前选中的 matches 下标(无匹配 → -1);
 *   current: 当前选中的历史文本(无匹配 → '')。
 */
function search(history, query, opts = {}) {
  try {
    const list = Array.isArray(history) ? history : [];
    const q = String(query == null ? '' : query).toLowerCase();
    if (q === '') return { query: String(query == null ? '' : query), matches: [], index: -1, current: '' };

    // 从最新(末尾)往回扫,累积命中下标 → 天然是新→旧序。
    const matches = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (typeof item === 'string' && item.toLowerCase().includes(q)) matches.push(i);
    }
    if (matches.length === 0) return { query: String(query), matches: [], index: -1, current: '' };

    const rawFrom = typeof opts.from === 'number' ? opts.from : 0;
    const index = Math.max(0, Math.min(rawFrom, matches.length - 1));
    return { query: String(query), matches, index, current: list[matches[index]] };
  } catch {
    return { query: '', matches: [], index: -1, current: '' };
  }
}

/**
 * 前进到更旧的一条匹配(Ctrl+R 再按)。到最旧一条则停住(不回绕)。
 *
 * @param {string[]} history 与 search 同一份历史(用于取 current 文本)
 * @param {{ query:string, matches:number[], index:number }} state search 的返回
 * @returns {{ query:string, matches:number[], index:number, current:string }}
 */
function nextMatch(history, state = {}) {
  try {
    const list = Array.isArray(history) ? history : [];
    const matches = Array.isArray(state.matches) ? state.matches : [];
    const query = String(state.query == null ? '' : state.query);
    if (matches.length === 0) return { query, matches: [], index: -1, current: '' };
    const cur = typeof state.index === 'number' ? state.index : 0;
    const index = Math.min(cur + 1, matches.length - 1);
    const at = matches[index];
    const current = typeof list[at] === 'string' ? list[at] : '';
    return { query, matches, index, current };
  } catch {
    return { query: '', matches: [], index: -1, current: '' };
  }
}

module.exports = {
  isEnabled,
  search,
  nextMatch,
  OFF_VALUES,
};
