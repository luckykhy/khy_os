/**
 * Interactive command catalog (/menu) — inline categorized listing.
 *
 * Rule 4 compliance: this renderer emits plain inline output via console.log
 * only. It never uses ANSI scroll regions (\x1B[n;mr) nor switches to an
 * alternate screen buffer, so the REPL scrollback stays intact and users can
 * scroll up to review earlier output.
 *
 * All user-facing prose is in Chinese; identifiers and comments are English.
 *
 * Data source strategy (single source of truth):
 * - CATEGORY_MAP below is the ONLY place that decides which canonical commands
 *   appear under which top-level category, plus their Chinese one-line label.
 * - Per-command aliases are NOT duplicated here — they are derived at render
 *   time from aliases.js (getAliasesForCommand), so the alias table remains the
 *   single source for alias data and this catalog never drifts from it.
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;

const { getAliasesForCommand } = require('./aliases');
const { displayWidth, getTerminalColumns } = require('./formatters');

/**
 * Single source of truth for menu categorization.
 * Each entry: { name, icon, cmds: [[canonicalCommand, chineseLabel], ...] }.
 * The canonical command must match the `command` field used in aliases.js /
 * the router switch, so alias derivation and dispatch stay consistent.
 */
const CATEGORY_MAP = [
  {
    name: '量化交易',
    icon: '◐',
    color: chalk.red,
    cmds: [
      ['quote', '实时行情'],
      ['backtest', '策略回测'],
      ['data', '数据下载与列表'],
      ['strategy', '策略管理'],
      ['analyze', 'AI 行情分析'],
      ['search', '标的搜索'],
    ],
  },
  {
    name: 'AI 助手',
    icon: '◆',
    color: chalk.blue,
    cmds: [
      ['gateway', 'AI 网关状态与切换'],
      ['models', '本地模型管理'],
      ['ai', 'AI 配置与权限'],
      ['image2web', '截图还原网页'],
      ['arena', '模型竞技场对比'],
    ],
  },
  {
    name: '系统',
    icon: '▸',
    color: chalk.cyan,
    cmds: [
      ['doctor', '环境诊断'],
      ['server', '后端服务'],
      ['db', '数据库'],
      ['config', '配置管理'],
      ['monitor', '底座自检'],
      ['proxy', '代理与令牌'],
    ],
  },
  {
    name: '应用管理',
    icon: '+',
    color: chalk.green,
    cmds: [
      ['app', '应用安装与运行'],
      ['modules', '模块化打包'],
      ['skill', '技能管理'],
      ['learn', '学习课程'],
      ['workflow', '工作流录制与回放'],
    ],
  },
];

// Legacy Windows terminals lack the glyphs used above; fall back to ASCII icons
// (mirrors the detection printHelp already relies on).
const _ASCII_ICONS = { '◐': '#', '◆': '+', '▸': '*', '+': '+' };

/**
 * Pick a short, representative alias list for a canonical command.
 * Prefers Chinese aliases (most discoverable for local users), then fills with
 * pinyin/English, capped to keep each row compact. Pure function.
 * @param {string} command
 * @param {number} [limit=3]
 * @returns {string[]}
 */
function pickAliases(command, limit = 3) {
  let aliases = [];
  try {
    aliases = getAliasesForCommand(command) || [];
  } catch {
    aliases = [];
  }
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
  const chinese = aliases.filter(hasCjk);
  const others = aliases.filter((a) => !hasCjk(a));
  return [...chinese, ...others].slice(0, limit);
}

/**
 * Build the catalog data model (pure). Aliases are derived from aliases.js.
 * @returns {Array<{ name: string, icon: string, items: Array<{ command: string, label: string, aliases: string[] }> }>}
 */
function buildCommandCatalog() {
  return CATEGORY_MAP.map((group) => ({
    name: group.name,
    icon: group.icon,
    color: group.color,
    items: group.cmds.map(([command, label]) => ({
      command,
      label,
      aliases: pickAliases(command),
    })),
  }));
}

/**
 * Render the command catalog as an inline box, styled to match printHelp().
 * Emits plain console.log lines only (no scroll region, no alternate buffer).
 */
function renderCommandCatalog() {
  const catalog = buildCommandCatalog();

  let legacyWin = false;
  try {
    const { isLegacyWinTerminal } = require('../tools/platformUtils');
    legacyWin = isLegacyWinTerminal();
  } catch {
    /* assume modern terminal */
  }
  const iconOf = (icon) => (legacyWin ? _ASCII_ICONS[icon] || '*' : icon);

  const cols = getTerminalColumns();
  // Floor the box width so very narrow terminals (cols 1-3, e.g. test stubs)
  // cannot drive boxW/innerW negative and make '─'.repeat(...) throw RangeError.
  const boxW = Math.max(32, Math.min(cols - 4, 72));
  const innerW = Math.max(0, boxW - 4); // "│ " + content + " │"
  const dim = chalk.dim;
  const hr = '─'.repeat(Math.max(0, boxW - 2));

  // ANSI- and CJK-safe padding (double-width glyphs counted as 2 columns), so
  // right borders stay aligned for Chinese labels.
  const vis = (s) => displayWidth(s);
  const pad = (s, w) => {
    const g = Math.max(0, w - vis(s));
    return s + ' '.repeat(g);
  };
  const row = (s) => dim('  │ ') + pad(s, innerW) + dim(' │');
  const emptyRow = () => row('');

  console.log('');
  const titleText = ' khy OS — 命令菜单 ';
  const titleDashes = boxW - 2 - displayWidth(titleText);
  const tLeft = Math.floor(titleDashes / 2);
  const tRight = titleDashes - tLeft;
  console.log(
    dim(`  ╭${'─'.repeat(Math.max(1, tLeft))}`) +
      chalk.cyan.bold(titleText) +
      dim(`${'─'.repeat(Math.max(1, tRight))}╮`)
  );
  console.log(emptyRow());
  console.log(row(dim('输入命令或其别名即可执行，例如: khy hq 茅台 · /menu 重新打开本菜单')));
  console.log(emptyRow());

  // Two-column layout: left = command + aliases, right = Chinese label.
  const cmdColW = Math.min(Math.floor(innerW * 0.62), 44);

  catalog.forEach((group) => {
    const colorFn = group.color || chalk.cyan;
    console.log(row(`${colorFn(iconOf(group.icon))} ${colorFn.bold(group.name)}`));
    console.log(row(dim('─'.repeat(Math.max(0, innerW)))));
    group.items.forEach((item) => {
      const aliasText = item.aliases.length ? dim(` (${item.aliases.join(', ')})`) : '';
      const left = pad(chalk.white(item.command) + aliasText, cmdColW);
      console.log(row(`  ${left} ${dim(item.label)}`));
    });
    console.log(emptyRow());
  });

  console.log(
    row(dim('提示: khy help 查看命令速查 · khy help <gateway|quant|ops> 查看分主题帮助'))
  );
  console.log(dim(`  ╰${hr}╯`));
  console.log('');
}

module.exports = {
  CATEGORY_MAP,
  buildCommandCatalog,
  renderCommandCatalog,
};
