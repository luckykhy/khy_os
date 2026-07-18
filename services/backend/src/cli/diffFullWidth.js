'use strict';

/**
 * diffFullWidth — 对齐 CC「后端逻辑也对齐」:diff 的 add/remove 行背景色条
 * **填充到终端整宽**的纯算术 + 门控(单一真源)。
 *
 * 背景(CC 逻辑):`src/components/StructuredDiff/Fallback.tsx` 的 `formatDiff`
 * 对每一行算 `padding = Math.max(0, width - contentWidth)` 再在 `backgroundColor`
 * 的 `<Text>` 里追加 `{' '.repeat(padding)}`——于是红/绿背景条一路铺到终端右缘,
 * 形成 CC 标志性的「实心整行色条」。khy 历史所有 diff 路径只把背景铺到文本末尾,
 * 右侧参差不齐。
 *
 * 本叶子只负责**该补多少空格**的确定性算术与门控;终端宽度读取、显示宽度测量
 * (CJK 感知)、chalk/Ink 着色一律留 call-site(叶子零 IO、零业务 require)。
 *
 * 诚实边界(为何不接 Ink TUI 路径):khy 的 TUI 用 vanilla `ink@6.8.0`,其
 * `build/output.js` 渲染每行时无条件 `styledCharsToString(...).trimEnd()`——会把
 * 带背景色的**尾随空格直接裁掉**,故在 TUI 里追加尾随空格是「静默无效」(色条仍
 * 参差)。CC 用的是 `@anthropic/ink` 分叉(不做此 trim)才能整宽。因此本能力**只**
 * 接经典 REPL 的 ANSI 路径(`diffRenderer.js` 经 `console.log` 直出、无 ink trim,
 * 尾随背景空格能存活);TUI 整宽色条记为 honest-NA(改 ink 属架构变更,不在一刀内)。
 */

// 门控梯:默认开,仅 0/false/off/no 关 → 字节回退(call-site 不追加任何空格)。
function diffFullWidthEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_FULL_WIDTH) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 给定已用显示宽度 usedWidth 与目标整宽 totalWidth,返回末尾应补的空格数。
 * 镜像 CC `Math.max(0, width - contentWidth)`。
 * 防呆:任一非有限数 → 0;floor 容忍小数;used >= total → 0(绝不返回负数)。
 */
function diffRowPadCount(usedWidth, totalWidth) {
  const u = Number(usedWidth);
  const t = Number(totalWidth);
  if (!Number.isFinite(u) || !Number.isFinite(t)) return 0;
  const pad = Math.floor(t) - Math.floor(u);
  return pad > 0 ? pad : 0;
}

/**
 * 便捷封装:门控关 → 空串(call-site 追加空串 = 字节回退);门控开 → 补白空格串。
 * chalk 背景由 call-site 再套(本叶子绝不引入 chalk)。
 */
function diffRowPadSpaces(usedWidth, totalWidth, env = process.env) {
  if (!diffFullWidthEnabled(env)) return '';
  return ' '.repeat(diffRowPadCount(usedWidth, totalWidth));
}

module.exports = { diffFullWidthEnabled, diffRowPadCount, diffRowPadSpaces };
