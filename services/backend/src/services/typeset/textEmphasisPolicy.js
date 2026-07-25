'use strict';

/**
 * textEmphasisPolicy — 输出排版强调层(单一真源)。
 *
 * Goal:「khyos 的输出文字,该加粗的加粗、该调大字体的调大,方便阅读」。
 *
 * 诚实的终端能力边界:
 *  - **加粗**:终端原生支持(ANSI SGR 1)。Markdown 的 `**粗体**` 与各级标题都应可靠加粗。
 *  - **「调大字体」**:终端是定宽字符网格,ink 的 <Text> 没有「字号」概念——无法像 GUI 那样
 *    按字符放大像素。两条真实途径:
 *      ① 稳健通用(默认开):用**字重 + 高对比 + 清晰层级 + 留白**让该突出的更突出、读起来更大更清楚。
 *      ② 字面 2× 放大(默认关·实验性):DEC 双宽行控制序列(ESC#6),让标题字形真的变两倍宽
 *         (支持 CJK)。仅对支持该序列的终端有效(xterm/iTerm2/kitty/wezterm/Windows Terminal 等多数
 *         支持),且在 ink 托管的 TUI 里是 best-effort(ink 不识别该非 SGR 序列,布局宽度可能略有偏差)。
 *         因此默认关,显式开启才生效。
 *
 * 本叶子是「什么该加粗 / 标题层级如何 / 是否字面放大」的唯一判定真源,绝不散写进 markdownRenderer。
 * 纯叶子契约:零 IO、确定性、绝不抛、fail-soft;两道门控关闭时调用方逐字节回退到旧行为。
 */

const ENV_EMPHASIS = 'KHY_TYPESET_EMPHASIS';      // 强调层(加粗 + 层级),默认开
const ENV_BIG_HEADINGS = 'KHY_TYPESET_BIG_HEADINGS'; // 字面双宽放大标题,默认关(实验性)

// DEC 双宽单高行(VT100 DECDWL):置于物理行**最前**时,整行字形渲染为两倍宽、同高。
// 行尾换行自动复位,无需结束序列。CJK 同样放大。
const DEC_DOUBLE_WIDTH = '\x1b#6';

function _truthyDefaultOn(raw) {
  // 默认开:仅显式 falsy 才关。
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function _truthyDefaultOff(raw) {
  // 默认关:仅显式 truthy 才开。
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
}

function isEmphasisEnabled(env = process.env) {
  try {
    return _truthyDefaultOn(env ? env[ENV_EMPHASIS] : undefined);
  } catch {
    return true;
  }
}

function isBigHeadingsEnabled(env = process.env) {
  try {
    return _truthyDefaultOff(env ? env[ENV_BIG_HEADINGS] : undefined);
  } catch {
    return false;
  }
}

/**
 * 标题视觉层级的单一真源。强调层开启时,**所有**级别都加粗,并按级别给出色调与醒目度,
 * 形成清晰的「大→小」层级(H1 最醒目,H6 最弱),便于扫读。
 * @param {number} level 1..6
 * @returns {{level:number, bold:boolean, tone:string, prominent:boolean}}
 */
function headingDescriptor(level) {
  let lvl = Number.isFinite(level) ? Math.trunc(level) : 1;
  if (lvl < 1) lvl = 1;
  if (lvl > 6) lvl = 6;
  if (lvl === 1) return { level: 1, bold: true, tone: 'h1', prominent: true };
  if (lvl === 2) return { level: 2, bold: true, tone: 'h2', prominent: true };
  if (lvl === 3) return { level: 3, bold: true, tone: 'h3', prominent: false };
  return { level: lvl, bold: true, tone: 'muted', prominent: false };
}

/**
 * 强调层开启时,该级别标题是否应加粗。H1/H2 在旧行为里本就加粗;本判据让 H3..H6 也加粗
 * (旧行为 H3+ 不加粗 = 真缺口)。门控关 → false → 调用方逐字节回退到旧的非加粗渲染。
 */
function shouldBoldHeading(level, env = process.env) {
  try {
    if (!isEmphasisEnabled(env)) return false;
    return true; // 强调层开:所有标题级别加粗
  } catch {
    return false;
  }
}

/**
 * 字面放大标题的行首前缀。默认关 → 恒返回 ''(无任何字节变化)。
 * 开启且级别值得放大(H1/H2)时返回 DEC 双宽序列,调用方必须把它放在该标题**物理行最前**。
 * @returns {string} DEC_DOUBLE_WIDTH 或 ''
 */
function bigHeadingPrefix(level, env = process.env) {
  try {
    if (!isBigHeadingsEnabled(env)) return '';
    const lvl = Number.isFinite(level) ? Math.trunc(level) : 1;
    return lvl <= 2 ? DEC_DOUBLE_WIDTH : '';
  } catch {
    return '';
  }
}

module.exports = {
  ENV_EMPHASIS,
  ENV_BIG_HEADINGS,
  DEC_DOUBLE_WIDTH,
  isEmphasisEnabled,
  isBigHeadingsEnabled,
  headingDescriptor,
  shouldBoldHeading,
  bigHeadingPrefix,
};
