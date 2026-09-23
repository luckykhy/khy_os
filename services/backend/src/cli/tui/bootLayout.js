'use strict';

/**
 * bootLayout — 启动屏帧高的**单一账本**（H1 阶梯）。纯叶子：零 IO、确定性、绝不抛、不读 env。
 *
 * 为什么需要它（[DESIGN-ARCH-134] §3.5）：
 * 启动屏是没有主 UI chrome 的整屏帧 —— 帧高就是它自己的高度。加上品牌块（四叶草 9 行）
 * 之后必须按终端行数分档，否则短终端会撞 H1：ink 在 `outputHeight >= stdout.rows` 时进
 * fullscreen 分支，下一帧走 `clearTerminal + fullStaticOutput + output`
 * （`node_modules/ink/build/ink.js:320` 判定 / `:322-327` 执行）⇒ spinner 每 80ms 一帧 =
 * 整屏清屏重印。
 *
 * 形状照抄既有 canonical：`cli/tui/chromeBudget.js` 的 `ccChromePlan(rows, shares)`（:203-245）
 * —— 同样是「按 rows 给品牌行预算、账本与渲染同源」。H1 的 `−1` 复用它的 `CC_TRAILER_ROWS`，
 * **不在这里重写 `rows - 1` 字面量** —— 那正是历史上三方各写各的（chromeBudget 修复前的病根）。
 *
 * 回滚语义（不新增 env 的理由见 §3.7）：`rows` 非法/缺失时落 **I 档**（仅字标，帧高 15）。
 * 现状 BootScreen 的帧高是 17（`paddingY 2 + art 5 + 空 1 + 分隔 1 + 空 1 + 六拍 6 + 尾空 1`），
 * 15 ≤ 17 ⇒ **即使调用方没传 `rows`，本次改动也永不比现状更差**。
 * （不选 J 档做缺省，是因为 I 档同样满足「不比现状差」，却保留了品牌识别。）
 *
 * 纪律（与 `cli/startupBeats.js` / `cli/tui/logoArt.js` 同）：零 IO、确定性、绝不抛、
 * 不读 env、不改入参、返回新对象。
 */

// H1 的 `−1` 纪律来自 chromeBudget（trailer 行），不是这里的字面量。
const { CC_TRAILER_ROWS } = require('./chromeBudget');

/**
 * 与品牌块无关的固定行数：
 *   paddingY 2 + 空行 1 + 进度行 3（ProgressBar 自带 marginY 1×2）+ 六拍 6 + 尾空行 1 = 13
 */
const FIXED_ROWS = 13;

/** 阻断 / 降级汇总行（`! N 项降级…`）最多占 1 行；预算恒按 1 行预留（保守侧）。 */
const TAIL_ROWS = 1;

/** 六拍行数 —— S1 规定恒定 6，不随推进变化。 */
const BEAT_ROWS = 6;

/** 进度行占的行数（ProgressBar 的 marginY 1×2 + 内容 1 行）。 */
const PROGRESS_ROWS = 3;

/** 低于此列数不做水平居中：内容块约 34 列，更窄的终端会把居中块挤成折行错位。 */
const MIN_CENTER_COLS = 40;

/** 品牌块的五档，降级顺序 F → G → H → I → J（先丢 tagline，再丢整个图形）。 */
const RUNGS = Object.freeze([
  { id: 'F', clover: true, wordmark: true, tagline: true },
  { id: 'G', clover: true, wordmark: true, tagline: false },
  { id: 'H', clover: false, wordmark: true, tagline: true },
  { id: 'I', clover: false, wordmark: true, tagline: false },
  { id: 'J', clover: false, wordmark: false, tagline: false },
]);

const CLOVER_ROWS = 9; // 与 logoArt.CLOVER_ROWS 同值；不 require 以保持本文件零图形依赖

function brandRowsOf(rung) {
  return (rung.clover ? CLOVER_ROWS : 0) + (rung.wordmark ? 1 : 0) + (rung.tagline ? 1 : 0);
}

/** 某档的完整帧高（尾部汇总行恒按 1 行预留）。 */
function frameRowsOf(rung) {
  return FIXED_ROWS + brandRowsOf(rung) + TAIL_ROWS;
}

function describe(rung, center) {
  return {
    rung: rung.id,
    clover: rung.clover,
    wordmark: rung.wordmark,
    tagline: rung.tagline,
    brandRows: brandRowsOf(rung),
    frameRows: frameRowsOf(rung),
    center,
  };
}

/**
 * 求当前应落哪一档。
 *
 * @param {object} [input]
 * @param {number} [input.rows] 终端行数；非法/缺失 ⇒ 落 I 档（见文件头「回滚语义」）。
 * @param {number} [input.cols] 终端列数；`0 < cols < 40` 时不做水平居中（窄终端保护）。
 * @returns {{rung:string, clover:boolean, wordmark:boolean, tagline:boolean,
 *            brandRows:number, frameRows:number, center:boolean}}
 */
function plan(input) {
  try {
    const opts = input || {};
    const colsN = Math.floor(Number(opts.cols));
    const center = !(Number.isFinite(colsN) && colsN > 0 && colsN < MIN_CENTER_COLS);

    const rowsN = Math.floor(Number(opts.rows));
    if (!Number.isFinite(rowsN) || rowsN <= 0) {
      // 保守缺省：I 档帧高 15 ≤ 现状 17 ⇒ 永不比现状差。
      return describe(RUNGS[3], center);
    }
    // H1：帧高必须 ≤ rows − 1。`−1` 走 chromeBudget 的 trailer 纪律。
    const budget = rowsN - CC_TRAILER_ROWS;
    for (let i = 0; i < RUNGS.length; i++) {
      if (frameRowsOf(RUNGS[i]) <= budget) {
        return describe(RUNGS[i], center);
      }
    }
    // 连 J 档都放不下：仍返回 J（渲染器画它该画的；本文件不替调用方决定更多）。
    return describe(RUNGS[RUNGS.length - 1], center);
  } catch {
    // 绝不抛：任何异常都回退到保守缺省（I 档 + 居中）。
    return { rung: 'I', clover: false, wordmark: true, tagline: false, brandRows: 1, frameRows: 15, center: true };
  }
}

module.exports = {
  FIXED_ROWS,
  TAIL_ROWS,
  BEAT_ROWS,
  PROGRESS_ROWS,
  MIN_CENTER_COLS,
  RUNGS,
  CLOVER_ROWS,
  plan,
  frameRowsOf,
};
