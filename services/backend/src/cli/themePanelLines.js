'use strict';

/**
 * themePanelLines — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让显示背后的**后端逻辑**对齐。」
 * khy 早已有完整的主题系统:cli/themeRegistry.js 从 cli/themes/*.json 加载 8 套主题
 * (default/dracula/forest/mono/nord/ocean/solarized/sunset),listThemes() 返回
 * [{name,label,description,active}],setTheme(name) 可切换,并被 router(/theme→/skin
 * list)、aiRenderer、TUI ToolLines、diffViewer 等多路消费。但**菜单** /theme 孪生
 * (cli/repl.js selected.flag==='theme')却硬编码一行 "主题: dark(默认),可使用 /config
 * 设置自定义主题。" —— 完全无视这套 live 注册表(呈现侧未接的 half-wired 幽灵显示:
 * 用户 `/skin set dracula` 明明生效,菜单 /theme 却谎称只有 dark)。
 *
 * 本叶子只做纯决策/格式化:把 listThemes() 的结果排成中文主题面板行(当前主题 + 可用
 * 主题清单 + 切换用法)。读取注册表(IO)与渲染颜色留给壳(cli/repl.js)。
 *
 * 门控 KHY_THEME_PANEL 默认开;关 / 输入为空 → 返回 [] → 壳逐字节回退旧的单行 printInfo。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_THEME_PANEL 默认开;{0,false,off,no} 关。 */
function themePanelEnabled(env = process.env) {
  const raw = env && env.KHY_THEME_PANEL;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 主题面板明细行(不含标题;壳负责印 `主题` 粗体标题)。
 * @param {Array<{name:string,label?:string,description?:string,active?:boolean}>} themes
 *        通常来自 themeRegistry.listThemes()。
 * @param {object} [env]
 * @returns {string[]} 缩进好的中文行;门控关 / themes 非法或为空 → [](壳回退旧单行)。
 */
function buildThemePanelLines(themes, env = process.env) {
  try {
    if (!themePanelEnabled(env)) return [];
    if (!Array.isArray(themes) || themes.length === 0) return [];

    const active = themes.find((t) => t && t.active) || null;
    const lines = [];

    const activeName = active && active.name ? String(active.name) : '';
    const activeLabel = active && active.label ? String(active.label) : (activeName || '未知');
    lines.push(activeName
      ? `    当前: ${activeLabel}（${activeName}）`
      : '    当前: 未知');

    lines.push('    可用主题:');
    for (const t of themes) {
      if (!t || !t.name) continue;
      const name = String(t.name);
      const label = t.label ? String(t.label) : name;
      const marker = t.active ? '  [当前]' : '';
      lines.push(`      ${name} · ${label}${marker}`);
    }

    lines.push('    切换: /theme <名称>');
    return lines;
  } catch {
    return [];
  }
}

module.exports = {
  themePanelEnabled,
  buildThemePanelLines,
};
