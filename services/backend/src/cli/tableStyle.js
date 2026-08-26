'use strict';

/**
 * tableStyle.js — 结果表格的边框风格决策（纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 背景（goal 2026-08-25「从各个角度美化 khyos 的 tui，不要在结果中使用大量线条」）：
 * printTable 有 110 处调用点，每一处都通过 cli-table3 画出满格框
 * （╭┬╮ / │ / ├┼┤ / ╰┴╯）。一屏里连着出两三张表，眼睛先看到的是网格，
 * 不是数据 —— 用户说的「显示很乱」就是这个。
 *
 * 收敛到的样式在本仓已有先例，不是新发明：formatters.printKeybindingsTip()
 * 一直是「标题 + 一条细线 + 缩进对齐行」，零竖线。本模块把那个节奏变成
 * printTable 的默认，靠列间空白而不是竖线分栏。
 *
 * 为什么单独开一个叶子而不是就地改 printTable：
 *   1. 「画不画框」是一次**观感取舍**，得留一个开关给不认同的人和自动化，
 *      而开关一旦散在 110 个调用点里就没法维护；
 *   2. cli-table3 的 chars 表是 15 个键的字面量，塞进 formatters 只会让那个
 *      已经 1300 行的文件更难读；
 *   3. 纯函数便于单测钉住「无框模式下不吐任何框线字符」。
 *
 * 门控 KHY_TABLE_BORDERS（默认 'minimal'）：
 *   minimal | 0 | off | false | no  → 无框，列间空白分栏（默认，本次改的样子）
 *   full | 1 | on | true           → 逐字节回到 cli-table3 的满格框（旧样子）
 * 无法识别的值一律回落 minimal —— 观感开关判错不该让表格渲染失败。
 *
 * @module cli/tableStyle
 */

// cli-table3 的 chars 表：全部置空 = 不画任何边框。'middle' 是**列间**分隔符，
// 置空会让相邻两列贴死，所以留一个空格，再靠 padding-right 撑开列距。
const BORDERLESS_CHARS = Object.freeze({
  top: '',
  'top-mid': '',
  'top-left': '',
  'top-right': '',
  bottom: '',
  'bottom-mid': '',
  'bottom-left': '',
  'bottom-right': '',
  left: '',
  'left-mid': '',
  mid: '',
  'mid-mid': '',
  right: '',
  'right-mid': '',
  middle: ' ',
});

const FULL_WORDS = ['full', '1', 'on', 'true', 'yes'];

/**
 * 解析边框风格。未设置 / 空 / 无法识别 → 'minimal'。
 * @param {object} [env]
 * @returns {'minimal'|'full'}
 */
function resolveBorderStyle(env) {
  try {
    const raw = env && env.KHY_TABLE_BORDERS;
    if (raw === undefined || raw === null) {
      return 'minimal';
    }
    const v = String(raw).trim().toLowerCase();
    if (!v) {
      return 'minimal';
    }
    return FULL_WORDS.includes(v) ? 'full' : 'minimal';
  } catch {
    return 'minimal';
  }
}

/**
 * 是否走无框渲染。
 * @param {object} [env]
 * @returns {boolean}
 */
function isBorderless(env) {
  return resolveBorderStyle(env) === 'minimal';
}

/**
 * 返回传给 cli-table3 的 chars 表；'full' 时返回 null 表示「用库的默认框」。
 * 返回的是冻结常量的浅拷贝 —— cli-table3 会写它自己的实例状态，不该拿到共享引用。
 * @param {object} [env]
 * @returns {object|null}
 */
function tableChars(env) {
  return isBorderless(env) ? { ...BORDERLESS_CHARS } : null;
}

/**
 * 列内边距。无框模式靠右侧留白分栏，所以 right 要比有框模式宽。
 * @param {object} [env]
 * @returns {{ paddingLeft: number, paddingRight: number }}
 */
function tablePadding(env) {
  return isBorderless(env)
    ? { paddingLeft: 0, paddingRight: 2 }
    : { paddingLeft: 1, paddingRight: 1 };
}

module.exports = {
  BORDERLESS_CHARS,
  resolveBorderStyle,
  isBorderless,
  tableChars,
  tablePadding,
};
