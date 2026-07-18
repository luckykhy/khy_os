'use strict';

/**
 * topicBarWorkingIndicator — 纯叶子:决定「对话标题左边那个字符」长什么样。
 *
 * 背景(用户诉求):topicBar 在终端窗口标题里给当前话题前缀一个静态 `✱`(用户称之为
 * 「太阳」)。用户希望——**工作时**把这个太阳换成一个「左右移动的小点」以示 khy 正在忙,
 * 忙完再变回静态太阳。本叶子只做纯逻辑:给定「是否在工作 + 帧序号」,返回标题前缀字符串;
 * 由 topicBar 的定时器驱动帧序号并重绘(IO 留在调用壳)。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 做门控;不碰 fs/网络/子进程/时钟/随机——帧序号由调用方传入,保确定性)。
 *   - 确定性:同 (working, tick) 恒返同前缀。
 *   - 绝不抛:任何异常路径回落到静态 `✱ ` 前缀(与历史逐字节一致)。
 *   - env 门控 KHY_TOPIC_BAR_WORKING_DOT 默认开;关 → titlePrefix 恒返 `'✱ '`(静态太阳),
 *     topicBar 永不启动动画定时器 → 逐字节回退旧行为。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

function isEnabled(env = process.env) {
  // flagRegistry 优先(集中真源),失败/不可用再退本地 CANON 解析。绝不抛。
  try {
    return require('../../../services/flagRegistry').isFlagEnabled('KHY_TOPIC_BAR_WORKING_DOT', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_TOPIC_BAR_WORKING_DOT;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 静态(空闲)时的「太阳」前缀 —— 与 topicBar 历史逐字节一致(`✱ ${topic}`)。
const STATIC_GLYPH = '✱';
const STATIC_PREFIX = `${STATIC_GLYPH} `;

// 工作动画:一个小点在固定宽度的轨道上「左→右→左」弹跳。
// 空白格用盲文空格 U+2800(定宽、不会被终端标题裁掉首尾空白),点用中点 U+00B7。
// 轨道宽 3 → 弹跳一个完整周期共 4 帧(左、中、右、中),读起来就是「左右移动」。
const _DOT = '·';        // ·  middle dot
const _GAP = '⠀';        //    braille blank(定宽占位,首字符永不是普通空格 → 不被裁剪)
const FRAMES = [
  `${_DOT}${_GAP}${_GAP}`,    // ···  (点在最左)
  `${_GAP}${_DOT}${_GAP}`,    //  ··
  `${_GAP}${_GAP}${_DOT}`,    //   ·  (点在最右)
  `${_GAP}${_DOT}${_GAP}`,    //  ··  (回弹)
];

function frameCount() {
  return FRAMES.length;
}

/**
 * 返回话题标题左侧的前缀字符串(含与话题之间的分隔空格)。
 *   - 门控关 → 恒 `'✱ '`(静态太阳,逐字节回退)。
 *   - 门控开 + 非工作 → `'✱ '`(空闲仍是静态太阳)。
 *   - 门控开 + 工作中 → 弹跳小点当前帧 + 一个分隔空格(`FRAMES[tick] + ' '`)。
 * 绝不抛:任何异常 → `'✱ '`。
 *
 * @param {{working?:boolean, tick?:number}} [opts]
 * @param {object} [env=process.env]
 * @returns {string}
 */
function titlePrefix({ working = false, tick = 0 } = {}, env = process.env) {
  try {
    if (!isEnabled(env)) return STATIC_PREFIX;
    if (!working) return STATIC_PREFIX;
    const n = FRAMES.length;
    let i = Number.isFinite(tick) ? Math.floor(tick) : 0;
    i = ((i % n) + n) % n; // 归一到 [0,n) —— 负 tick 也安全
    return `${FRAMES[i]} `;
  } catch {
    return STATIC_PREFIX;
  }
}

/** 自描述(给工具 / 文档 / 调试用)。 */
function describeTopicBarWorkingIndicator() {
  return {
    gate: 'KHY_TOPIC_BAR_WORKING_DOT',
    defaultOn: true,
    staticGlyph: STATIC_GLYPH,
    frames: FRAMES.length,
    summary: '话题标题左侧字符:空闲=静态太阳 ✱,工作中=左右弹跳的小点(topicBar 定时器驱动帧序号);'
      + '门控关 → 恒静态太阳(逐字节回退)。',
  };
}

module.exports = {
  isEnabled,
  STATIC_GLYPH,
  STATIC_PREFIX,
  FRAMES,
  frameCount,
  titlePrefix,
  describeTopicBarWorkingIndicator,
};
