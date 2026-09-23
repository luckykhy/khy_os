'use strict';

/**
 * CcHelpMenu.js —— CC 风格帮助菜单覆盖层
 *
 * 设计：
 * - 标签页导航：Help / General / Commands / Custom commands
 * - 当前标签高亮（橙色下划线）
 * - 快捷键网格：2-3 列布局
 * - 底部状态栏：版本 + MCP 状态 + 操作提示
 * - Esc / q / ? 关闭
 *
 * 参考：[DESIGN-ARCH-081] Phase 5: 补全菜单与覆盖层
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { BRAND } = require('../utils/ccBrand');
// 行预算 + 终端尺寸：与另外三个 CC 浮层同一叶子（BUG-70/73/74）。
const ccLayout = require('./ccOverlayLayout');
// 显示宽度度量与截断：复用全渲染层 SSOT（同 HelpMenu.js BUG-11 那条线）。
// 本浮层是两列网格，一旦「固定键列 + 不限长描述列」的总宽顶破浮层内宽，
// yoga 会按 shrink 逐行收缩并把描述**无省略号**地裁掉（BUG-40 实测）。
const _measure = (s) => {
  try {
    const { getDisplayWidth } = require('../../displayWidthMemo');
    const { displayWidth } = require('../../formatters');
    return getDisplayWidth(String(s), displayWidth);
  } catch {
    return String(s).length; // fail-soft：退回字符数
  }
};
const _clip = (s, w) => {
  try {
    const { truncateToWidth } = require('../../formatters');
    return truncateToWidth(String(s), w);
  } catch {
    const str = String(s);
    return str.length > w ? `${str.slice(0, Math.max(0, w - 3))}...` : str;
  }
};
const _pad = (s, w) => {
  try {
    const { padToWidth } = require('../../formatters');
    return padToWidth(String(s), w);
  } catch {
    return String(s) + ' '.repeat(Math.max(0, w - _measure(s)));
  }
};

const TABS = ['Help', 'General', 'Commands', 'Custom commands'];

/** 浮层内宽：`width` 减掉 2 边框 + 2 paddingX（`CcApp.js:688` 传入的是 helpMenuWidth 外宽）。 */
function _inner(width) {
  return Math.max(8, (Number(width) || 80) - 4);
}

const TAB_SEP = 2;

/**
 * 标签栏：够宽则原样标签 + 间隙；不够宽则逐条等比**截断**（补 `...`）。
 * 折行比截断更糟——width=44 实测原状把标签劈成 `Hel p` / `Genera l` / `Command s`。
 */
function renderTabBar(width, activeTab) {
  const inner = _inner(width);
  const natural = TABS.map((t) => _measure(t));
  const total = natural.reduce((a, b) => a + b, 0) + TAB_SEP * (TABS.length - 1);
  const share = total <= inner
    ? null
    : Math.max(4, Math.floor((inner - TAB_SEP * (TABS.length - 1)) / TABS.length));

  return TABS.map((tab, i) => {
    const isActive = i === activeTab;
    const label = share === null ? tab : _pad(_clip(tab, share), share);
    // 末位不留间隙：留了就会让「预算 40 列 / 实占 42 列」，整栏折行把标签劈字。
    return React.createElement(Box, { key: i, marginRight: i === TABS.length - 1 ? 0 : TAB_SEP },
      React.createElement(Text, {
        color: isActive ? CC_COLORS.brand : CC_COLORS.dimColor,
        bold: isActive,
        underline: isActive,
      }, label)
    );
  });
}

const FOOTER_HINT = 'Esc close · ←/→ or Tab switch tab';
const FOOTER_HINT_SHORT = 'Esc close · ←/→ tabs';

/** 底部提示与版本号同栏：内宽容不下长句时退成短句，不让它折行把版本号顶歪。 */
function footerHint(width) {
  return _inner(width) >= _measure(FOOTER_HINT) + 12 ? FOOTER_HINT : FOOTER_HINT_SHORT;
}

// 本表逐条对齐 **CC 表面**（CcApp.js / CcPromptInput.js）的 useInput 真能力。
// 曾经的三条谎报（Tab Complete / Shift+Tab Cycle mode / ↑↓ History nav）在 CC 表面
// 无人处理，见 .khy/feedback/tui-ux-audit-20260919/AC/differential.md C4。
// ⚠ 本表是手抄的，未走 keybindings 单一真源 —— 是否并轨属产品取舍，登记为 BUG-40b 待裁决。
const GENERAL_SHORTCUTS = [
  { keys: 'Ctrl+C / D', desc: 'Exit (press twice)' },      // CcApp.js:531 双击退出
  { keys: 'Ctrl+O', desc: 'Transcript view' },             // CcApp.js:568
  { keys: 'Ctrl+L', desc: 'Clear chat' },                  // CcApp.js:562
  { keys: 'Ctrl+R', desc: 'History search' },              // CcApp.js:556
  { keys: 'Ctrl+T', desc: 'Toggle agent tree' },           // CcApp.js:574
  { keys: 'Ctrl+P', desc: 'Command palette' },             // CcApp.js:550
  { keys: 'Ctrl+E', desc: 'External editor' },             // CcApp.js:580
  { keys: 'Ctrl+V', desc: 'Toggle Vim mode' },             // CcApp.js:586
  { keys: 'Ctrl+Y', desc: 'Copy last reply' },             // CcApp.js:592
  { keys: '↑/↓', desc: 'Move caret' },                     // CcPromptInput.js:412 逐字符移光标
  { keys: '?', desc: 'Toggle this menu' },                 // CcApp.js:544
  { keys: 'Esc', desc: 'Close' },                          // 本组件 useInput
];

const COMMANDS_LIST = [
  { cmd: '/clear', desc: '清除对话历史' },
  { cmd: '/compact', desc: '压缩对话历史' },
  { cmd: '/cost', desc: '查看 token 用量' },
  { cmd: '/status', desc: '查看会话状态' },
  { cmd: '/init', desc: '初始化 CLAUDE.md' },
  { cmd: '/memory', desc: '管理记忆文件' },
  { cmd: '/model', desc: '切换 AI 模型' },
  { cmd: '/permissions', desc: '权限设置' },
  { cmd: '/vim', desc: '切换 Vim 模式' },
  { cmd: '/mcp', desc: 'MCP 服务器管理' },
  { cmd: '/agents', desc: 'Agent 管理' },
  { cmd: '/hooks', desc: 'Hooks 管理' },
];

/**
 * CC 风格帮助菜单覆盖层
 *
 * 高度预算(BUG-74)：浮层是 early-return 的整棵树，chrome 恒 9 行
 * (上下边框 2 + 标签栏 2 + 两条分割线 2 + 内容区上边距 1 + 底栏 2)，
 * 四个页签里最长的 12 行 → 一帧 21 行。旧的「一条 = 一行」假设在窄终端上
 * 也不成立（描述折行 ⇒ 实际行数 > 条数），所以每个页签都渲染成
 * **恰好一行的行数组**，再交给 ./ccOverlayLayout.listRows 决定画几行；
 * 放不下时补一行「… 另有 N 条」——与主表面 ./HelpMenu.js(BUG-58) 同一套判据。
 *
 * @param {number} [p.initialTab] 起始页签下标（仅供挂载/探针注入特定页签，不新增任何按键）
 */
function CcHelpMenu({ version = '1.0.0', mcpStatus, onClose, width = 80, rows, initialTab = 0 }) {
  const [activeTab, setActiveTab] = React.useState(() => {
    const n = Number(initialTab);
    return Number.isInteger(n) && n >= 0 && n < TABS.length ? n : 0;
  });

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '?') {
      onClose?.();
    }
    if (key.leftArrow) {
      setActiveTab(i => (i > 0 ? i - 1 : TABS.length - 1));
    }
    if (key.rightArrow) {
      setActiveTab(i => (i < TABS.length - 1 ? i + 1 : 0));
    }
    if (key.tab) {
      setActiveTab(i => (i + 1) % TABS.length);
    }
  });

  const inner = _inner(width);
  const tabRows = TAB_RENDERERS[activeTab](width);

  // 高度预算（BUG-74 → BUG-88）：见 `helpChromePlan` 的注释。
  const plan = helpChromePlan(ccLayout.termSize('rows', rows), tabRows.length);
  const keep = (name) => !plan.shed.includes(name);
  const { shown, hint: hintOn } = ccLayout.listWithHint(plan.budget, tabRows.length);
  const hint = hintOn ? moreHint(tabRows.length - shown, inner) : '';

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: CC_COLORS.border,
      paddingX: 1,
      width,
    },
      // 标签页导航
      // margin 挂在 Box 上而不是 Text 上：ink 的 Text 是行内节点，不吃 marginRight，
      // 原写法实测把四条标签黏成 `HelpGeneralCommandsCustom commands`（BUG-40 D1）。
      // 宽度不够时**截标签**而不是让它折行：实测 width=44 会折成
      // `Hel p / Genera l / Command s / Custom commands`（词被劈成两行，比省略号更难读）。
      React.createElement(Box, { marginBottom: keep('tabGap') ? 1 : 0 }, renderTabBar(width, activeTab)),

      // 分割线
      keep('topRule')
        ? React.createElement(Text, { color: CC_COLORS.secondary }, '─'.repeat(Math.max(0, width - 4)))
        : null,

      // 内容区
      React.createElement(Box, { flexDirection: 'column', marginTop: keep('contentGap') ? 1 : 0 },
        ...tabRows.slice(0, shown),
        hint
          ? React.createElement(Text, { key: 'more', color: CC_COLORS.dimColor }, hint)
          : null,
      ),

      keep('bottomRule')
        ? React.createElement(Text, { color: CC_COLORS.secondary }, '─'.repeat(Math.max(0, width - 4)))
        : null,
      keep('footer')
        ? React.createElement(Box, { marginTop: keep('footerGap') ? 1 : 0, justifyContent: 'space-between' },
          React.createElement(Text, { color: CC_COLORS.dimColor }, BRAND.versionTemplate(version)),
          React.createElement(Text, { color: CC_COLORS.dimColor }, footerHint(width)),
        )
        : null,
    )
  );
}

/** 一行文本 = 一个单行 Box。span 已在预算内裁好，故不会折行。 */
function _row(key, spans) {
  return React.createElement(Box, { key },
    ...spans.map((s, i) => React.createElement(Text, {
      key: i, color: s.color, bold: s.bold,
    }, s.text)));
}

function _textRow(key, text, width, opts = {}) {
  return _row(key, [{ text: _clip(text, width), color: opts.color, bold: opts.bold }]);
}

/**
 * 「还有 N 条」逐级换短：长句在 40 列(内宽 36)下会折成 2 行，
 * 那 1 行预算就白让了 —— 与 HelpMenu.js 的 hintOf 同一处理。
 */
function moreHint(n, inner) {
  const cands = [
    `… 另有 ${n} 条，←/→ 切换页签看全量`,
    `… 另有 ${n} 条 · ←/→`,
    `… 另有 ${n} 条`,
  ];
  for (const t of cands) if (_measure(t) <= inner) return t;
  return _clip(cands[cands.length - 1], inner);
}

function helpTabRows(width) {
  const inner = _inner(width);
  const lines = [
    ['Welcome to Khy', { bold: true }],
    ['AI-powered coding assistant', { color: CC_COLORS.dimColor }],
    [' ', {}],
    ['Type a message to get started.', {}],
    ['Type / to see available commands.', {}],
    ['Type ? to open this help menu.', {}],
  ];
  return lines.map(([t, o], i) => _textRow(`h${i}`, t, inner, o));
}


/**
 * General 页：两列快捷键网格（每格 = 一行）。
 *
 * 宽度预算按浮层**内宽**算（`width` 减掉 2 边框 + 2 paddingX），键列取本表实际
 * 最大显示宽度，描述列吃满剩下的半宽并按显示宽度截断（溢出补 `...`）。
 * 预算按内宽算：每栏 = 键列(本表实际最大显示宽) + 2 + 描述列，两栏之间留 2 列间隙。
 * 描述列不足 MIN_DESC 时**退成单列**——width=60 实测两栏会各自被裁到 15 列且**互相贴死**
 * （`Exit (press ...Ctrl+O`），比 12 行单列更不可读。
 * 无论几列，最终 descW 都必须满足「键列 + 描述列 ≤ 栏宽」：MIN_DESC 只是**下限愿望**，
 * 拿它当硬地板会让整格顶破内宽 → 折行 → 帧高失控(BUG-74)。
 *
 * @param {number} width 浮层外宽（与 CcApp 传入的 layout.helpMenuWidth 同源）
 * @returns {Array} 每元素恰好一行的行数组
 */
const KEY_GAP = 2;
const COL_GAP = 2;
const MIN_DESC = 10;

function generalTabRows(width) {
  const inner = _inner(width);
  const keyW = Math.max(...GENERAL_SHORTCUTS.map((s) => _measure(s.keys)));
  const keyCol = keyW + KEY_GAP;
  const twoCol = inner >= 2 * (keyCol + MIN_DESC) + COL_GAP;
  const colW = twoCol ? Math.floor((inner - COL_GAP) / 2) : inner;
  const descW = Math.max(1, colW - keyCol);

  const cell = (s, tag) => [
    React.createElement(Text, {
      key: `k${tag}`, color: CC_COLORS.brand,
    }, _pad(s.keys, keyW) + ' '.repeat(KEY_GAP)),
    React.createElement(Text, {
      key: `d${tag}`, color: CC_COLORS.textSecondary,
    }, _pad(_clip(s.desc, descW), descW)),
  ];

  const rows = [];
  if (!twoCol) {
    for (let i = 0; i < GENERAL_SHORTCUTS.length; i += 1) {
      rows.push(React.createElement(Box, { key: `g${i}` }, ...cell(GENERAL_SHORTCUTS[i], 'S')));
    }
  } else {
    for (let i = 0; i < GENERAL_SHORTCUTS.length; i += 2) {
      const right = GENERAL_SHORTCUTS[i + 1];
      rows.push(React.createElement(Box, { key: `g${i}` },
        ...cell(GENERAL_SHORTCUTS[i], 'L'),
        ...(right
          ? [
            React.createElement(Text, { key: 'g', color: CC_COLORS.dimColor }, ' '.repeat(COL_GAP)),
            ...cell(right, 'R'),
          ]
          : [])
      ));
    }
  }

  return rows;
}

/** 命令列宽：固定 18 会顶破窄内宽，故最多占内宽的一半（另留描述列）。 */
function commandsTabRows(width) {
  const inner = _inner(width);
  const cmdW = Math.max(6, Math.min(18, Math.floor(inner / 2)));
  const descW = Math.max(1, inner - cmdW);
  return COMMANDS_LIST.map((c, i) => React.createElement(Box, { key: `c${i}` },
    React.createElement(Text, { color: CC_COLORS.brand }, _pad(_clip(c.cmd, cmdW), cmdW)),
    React.createElement(Text, { color: CC_COLORS.textSecondary }, _clip(c.desc, descW)),
  ));
}

function customTabRows(width) {
  const inner = _inner(width);
  const lines = [
    'No custom commands configured.',
    'Create .khy/commands/ to add your own.',
  ];
  return lines.map((t, i) => _textRow(`x${i}`, t, inner, { color: CC_COLORS.dimColor }));
}

/** 上下边框 2 + 标签栏(行+margin) 2 + 分割线 2 + 内容区 marginTop 1 + 底栏(margin+行) 2。 */
const CHROME_ROWS = 9;

/**
 * 装饰让位梯（BUG-88）：**最没用在前**，逐件砍到 `rows - 1 - chrome >= 1`。
 * 不可砍的三行是上/下边框与标签栏本身（那是「这是个浮层、能左右切页」的结构）。
 * 顺序理由：空白 margin 不携带信息 → 分割线是纯装饰 → 底栏（版本 + 「Esc close」）
 * 最后砍，因为它是唯一告诉用户怎么关掉这层的东西。
 */
const CHROME_SHED = [
  { name: 'tabGap', rows: 1 },
  { name: 'contentGap', rows: 1 },
  { name: 'footerGap', rows: 1 },
  { name: 'topRule', rows: 1 },
  { name: 'bottomRule', rows: 1 },
  { name: 'footer', rows: 1 },
];

const TAB_RENDERERS = [helpTabRows, generalTabRows, commandsTabRows, customTabRows];

/**
 * 本浮层的行预算（BUG-74 → BUG-88）。
 *
 * chrome 全量 9 行，但 9 行装饰本身就能把矮终端付光 —— 旧的
 * `listRows()` 在 `rows - reserve - 9 <= 0` 时靠 `LIST_FLOOR` 硬撑 1 行，
 * 于是「账本 10 行 / 屏幕 10 行」正好撞进 ink 的 `>=` 全屏分支；旧代码**还在
 * 预算之外追加了一行提示**（实画 = 账本 + 1，BUG-84 的账本/paint 分叉换表面重演）。
 * 现在两件事都交给叶子：装饰按 `CHROME_SHED` 逐件让位，「另有 N 条」这一行
 * 从预算里出（`listWithHint`）。
 * 首选档 `minList` 2 = 1 行内容 + 1 行提示：宁可少一条分割线，不要静默截断。
 * 装饰砍光仍付不起时（实测 60×5）退到 1 行内容、不给提示 —— 整屏擦除的代价是
 * 「每按一次键往回滚缓冲塞一份整屏副本 + 框的顶边被推下屏幕」（BUG-70/71），
 * 比「少了另有 N 条」更重。
 *
 * 导出给探针：账本与 paint 必须同源，探针另抄一份算式测到的绿是假的。
 *
 * @param {number} rows 终端行数
 * @param {number} total 当前页签的行数
 * @returns {{chrome:number,budget:number,shed:string[],fits:boolean}}
 */
function helpChromePlan(rows, total) {
  const n = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : 0;
  const args = { rows, full: CHROME_ROWS, shed: CHROME_SHED };
  const preferred = ccLayout.chromePlan({ ...args, minList: n > 1 ? 2 : 1 });
  return preferred.fits ? preferred : ccLayout.chromePlan({ ...args, minList: 1 });
}


module.exports = {
  CcHelpMenu: React.memo(CcHelpMenu),
  // 行预算账本的三份输入（chrome 全量、让位梯、逐页签的行数组构造器）。
  // 与 CHROME_ROWS 同理导出：任何一份被探针抄成字面量，测到的「同源」都是假的。
  ccHelpTabRows: TAB_RENDERERS,
  helpChromePlan,
};
