'use strict';

/**
 * CcFuzzyPicker.js —— CC 风格模糊搜索选择器
 *
 * 设计：
 * - 顶部搜索输入框
 * - 模糊匹配排序
 * - 选中项高亮（▸ + 反显）
 * - 键盘导航（↑/↓/Enter/Esc）
 * - 实时过滤
 *
 * 参考：[DESIGN-ARCH-081] Phase 5: 补全菜单与覆盖层
 */

const React = require('react');
// inkRuntime 是 ESM 桥接：顶层 .get() 会在 loadInk() 之前 require 本模块时抛错，
// 与同目录 CcViewStack / CcToast 一样改为渲染期惰性取。
const inkRuntime = require('../inkRuntime');
const { CC_COLORS } = require('../theme/ccTheme');
const ccLayout = require('./ccOverlayLayout');

/**
 * 终端尺寸真源在 ./ccOverlayLayout.termSize（宿主 props 优先，其次 ../effectiveDims）。
 * 本地只留一个别名，避免三个浮层各抄一份 NaN 兜底（BUG-73）。
 */
const _dim = ccLayout.termSize;

/**
 * 简单模糊匹配评分
 */
function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // 完全匹配
  if (t === q) return 100;
  // 前缀匹配
  if (t.startsWith(q)) return 80;
  // 包含匹配
  if (t.includes(q)) return 60;

  // 字符顺序匹配
  let qi = 0;
  let ti = 0;
  let matches = 0;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      matches++;
      qi++;
    }
    ti++;
  }
  if (matches === q.length) return 40;

  return 0; // 不匹配
}

/**
 * 装饰账本（BUG-89b，件名与本浮层实际渲染的东西一一对应）：
 * 上下边框 2 + 搜索行 1 + 上分隔线 1 + 下分隔线 1 + 提示行 1 = 6。
 * 让位顺序「最没用在前」：两条纯装饰的分隔线先走，提示行最后走
 * （它写着 `Esc cancel`，是唯一告诉用户怎么退出这一层的东西）。
 * 砍无可砍时 chrome = 3（边框 2 + 搜索行 1），再矮就交给 `LIST_FLOOR` —— 与
 * `CcHelpMenu`（BUG-88）、`CcCommandPalette`（BUG-88b）同一档边界。
 */
const FUZZY_CHROME = {
  full: 6,
  shed: [
    { name: 'topRule', rows: 1 },
    { name: 'bottomRule', rows: 1 },
    { name: 'hint', rows: 1 },
  ],
};

/** 导出给守卫与探针：账本与 paint 必须同源，探针另抄一份算式测到的绿是假的。 */
function fuzzyChromePlan(rows, total) {
  return ccLayout.chromeLadder({ ...FUZZY_CHROME, rows, total });
}

/**
 * CC 风格模糊搜索选择器
 */
function CcFuzzyPicker({
  items = [],           // [{ label, value, description }]
  placeholder = 'Search...',
  onSelect,
  onClose,
  maxHeight = 15,
  maxWidth = 80,
  cols = null,
  rows = null,
}) {
  const { Text, Box, useInput } = inkRuntime.get();
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  // 过滤 + 排序
  const filtered = React.useMemo(() => {
    if (!query) return items;
    return items
      .map(item => ({
        ...item,
        _score: fuzzyScore(query, item.label + ' ' + (item.description || '')),
      }))
      .filter(item => item._score > 0)
      .sort((a, b) => b._score - a._score);
  }, [query, items]);

  // 确保选中索引有效
  const safeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => (i > 0 ? i - 1 : filtered.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(i => (i < filtered.length - 1 ? i + 1 : 0));
    }
    if (key.return) {
      const item = filtered[safeIndex];
      if (item) onSelect?.(item);
    }
    if (key.escape) {
      onClose?.();
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
    }
    if (input && !key.ctrl && !key.meta && !key.return) {
      setQuery(q => q + input);
    }
  });

  // 可见区域计算：行预算由终端剩余行数给（旧写法只认 maxHeight=15，
  // 在 12~16 行的终端里整框溢出 → ink 每帧 clearTerminal，回滚缓冲堆残影），
  // 且窗口起点由选中下标派生（旧写法钉死 slice(0, maxHeight)，选中项跑出窗口即隐身）。
  const termRows = _dim('rows', rows);
  // BUG-89b：chrome 从前写死 6、没有让位梯 → 帧高恒 7 行，rows ≤ 7 时正好撞进
  // ink 的全屏分支（条件是 `>=`）。装饰按 FUZZY_CHROME.shed 逐件让位，
  // 与 CcHelpMenu（BUG-88）/ CcCommandPalette（BUG-88b）同一台机器。
  const plan = fuzzyChromePlan(termRows, filtered.length);
  const keep = (name) => !plan.shed.includes(name);
  const visible = Math.min(
    maxHeight,
    ccLayout.listRows({
      rows: termRows,
      chrome: plan.chrome,
      total: filtered.length,
      legacyCap: maxHeight,
    })
  );
  const start = ccLayout.pageStart(safeIndex, visible, filtered.length);
  const visibleItems = filtered.slice(start, start + visible);
  const hint = ccLayout.moreHint(safeIndex, visible, filtered.length);

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: CC_COLORS.border,
      paddingX: 1,
      // 框宽也封顶：maxWidth 是「想要的宽度」，终端列数才是「画得下的宽度」。
      width: Math.min(maxWidth, _dim('cols', cols)),
    },
      // 搜索输入
      React.createElement(Box, null,
        React.createElement(Text, { color: CC_COLORS.brand }, '> '),
        React.createElement(Text, null, query || placeholder),
        React.createElement(Text, { color: CC_COLORS.dimColor, bold: true }, '│'),
      ),

      // 分隔线：宽度也受终端约束，否则 maxWidth=80 在 60 列终端里折成两行 → +1 帧高
      keep('topRule')
        ? React.createElement(Text, { color: CC_COLORS.border, wrap: 'truncate' },
          '─'.repeat(Math.max(4, Math.min(maxWidth - 4, _dim('cols', cols) - 2))))
        : null,

      // 列表
      React.createElement(Box, { flexDirection: 'column' },
        visibleItems.length === 0
          // 空态**只有一行**：`total = 0` 时行预算兜到地板 1 行，而 `Box { paddingY: 1 }`
          // 上下各垫 1 行 = 3 行 → 「账本 7 / 实画 9」，在 8~9 行终端上顶破屏幕（BUG-89）。
          ? React.createElement(Text, {
              color: CC_COLORS.dimColor,
              wrap: 'truncate',
            }, ccLayout.clipLine('  No matches', Math.max(12, maxWidth - 6)))
          : visibleItems.map((item, i) => {
              const isSelected = start + i === safeIndex;
              // 条目裁成一行：一条折两行就等于把「条数上限」悄悄变成「行预算 ×2」。
              const innerW = Math.max(12, maxWidth - 6);
              const clipped = ccLayout.clipLine(String(item.label == null ? '' : item.label), innerW);
              const clippedDesc = item.description
                ? ccLayout.clipLine(String(item.description), Math.max(8, Math.floor(innerW / 2)))
                : '';
              return (
                React.createElement(Box, { key: i, marginY: 0 },
                  React.createElement(Text, {
                    color: isSelected ? CC_COLORS.brand : CC_COLORS.textSecondary,
                    dimColor: !isSelected,
                  }, isSelected ? '▸ ' : '  '),
                  React.createElement(Text, {
                    color: isSelected ? undefined : CC_COLORS.textSecondary,
                    bold: isSelected,
                    wrap: 'truncate',
                  }, clipped),
                  clippedDesc
                    ? React.createElement(Text, { color: CC_COLORS.dimColor, wrap: 'truncate' },
                        '  ' + clippedDesc)
                    : null,
                )
              );
            })
      ),

      // 底部提示
      keep('bottomRule')
        ? React.createElement(Text, { color: CC_COLORS.border, wrap: 'truncate' },
          '─'.repeat(Math.max(4, Math.min(maxWidth - 4, _dim('cols', cols) - 2))))
        : null,
      keep('hint')
        ? React.createElement(Text, { color: CC_COLORS.dimColor, wrap: 'truncate' },
          ccLayout.clipLine(hint
            ? `  ${safeIndex + 1}/${filtered.length}  ${hint}  ↑↓ navigate · Enter select · Esc cancel`
            : '  ↑↓ navigate · Enter select · Esc cancel', Math.max(8, maxWidth - 4)))
        : null,
    )
  );
}

module.exports = {
  CcFuzzyPicker: React.memo(CcFuzzyPicker),
  fuzzyScore,
  // 装饰账本（件名 + 让位梯 + 计划函数）导出给守卫与探针，理由见 FUZZY_CHROME。
  fuzzyChromePlan,
  FUZZY_CHROME,
};
