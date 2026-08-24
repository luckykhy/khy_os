'use strict';

/**
 * TranscriptView — 全量会话的可滚动视图(对齐 Claude Code 的 `Transcript` context)。
 *
 * 为什么要有它:khy 原本的 Ctrl+O 只能就地展开**最后一条** foldable 消息,回不到更早
 * 的段落;而想「用鼠标点开某段」又必然要接管鼠标,而终端的鼠标追踪是独占的 ——
 * 接管后终端原生的滚轮 scrollback 就失效(报位移的 1002/1003 连拖选一并吃掉)。
 * CC 的答案是根本不碰鼠标:把「展开」与「滚动」都做成键盘驱动的独立视图。本组件就是那个视图;
 * 鼠标层仍保留但已降到 1000(见 mouseButtons.js),默认全关。
 *
 * 键位由 App.js 的 Transcript context 分支分发,偏移算术走 `scrollActions` 叶子,
 * 文本投影走 `transcriptLines` 叶子 —— 本组件只负责「切片 + 画框」,不含业务判断。
 *
 * 视口沿用 ShellView 已验证的「bounded viewport + scroll offset」模式(按行切片,
 * 绝不用 ANSI 滚动区 —— 红线 4)。行数组由调用方(App)构建并传入,这样 App 能用同一
 * 个 `bodyHeight()` 算出 viewport 交给 scrollActions 做 clamp,视图与键位对同一组
 * 数字负责。
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

// 边框 + 标题 + 提示行 + 输入框 + 状态行占掉的行数(与 ShellView 的 rows - 12 同源:
// 那个数字已在真实终端里验证过不会挤掉输入区)。
const CHROME_ROWS = 12;
const MIN_BODY_ROWS = 4;

function _rows(rowsHint) {
  const n = Number(rowsHint);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  const t = process.stdout && process.stdout.rows;
  return Number.isFinite(t) && t > 0 ? t : 24;
}

/**
 * 视口能显示多少行正文。App 用它算 scrollActions 的 viewport,组件用它切片 ——
 * 同一个函数,所以「按半页翻」翻的正是屏幕上看到的那半页。
 *
 * @param {number} [rowsHint] 终端行数(缺省读 process.stdout.rows)
 * @param {number} [total] 内容总行数(内容少于视口时不必留空)
 */
function bodyHeight(rowsHint, total) {
  const avail = Math.max(MIN_BODY_ROWS, _rows(rowsHint) - CHROME_ROWS);
  const n = Number(total);
  if (Number.isFinite(n) && n > 0) {
    return Math.max(MIN_BODY_ROWS, Math.min(Math.floor(n), avail));
  }
  return avail;
}

function TranscriptView({ lines, scroll = 0, showAll = false, rows }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const all = Array.isArray(lines) ? lines : [];
  const maxBody = bodyHeight(rows, all.length);
  const maxScroll = Math.max(0, all.length - maxBody);
  const off = Math.max(0, Math.min(Number(scroll) || 0, maxScroll));
  const body = all.slice(off, off + maxBody);

  const title = showAll ? '⊟ 会话记录 · 全展开' : '⊟ 会话记录 · 折叠';
  const children = [
    h(
      Box,
      { key: 'title' },
      h(Text, { color: 'cyan', bold: true }, title),
      h(
        Text,
        { dimColor: true },
        all.length > 0 ? `  ·  第 ${off + 1}-${off + body.length} 行 / 共 ${all.length} 行` : ''
      )
    ),
  ];

  if (all.length === 0) {
    children.push(h(Text, { key: 'empty', dimColor: true }, '（本次会话还没有可回看的消息）'));
  } else {
    children.push(
      h(
        Box,
        { key: 'body', flexDirection: 'column', marginTop: 1 },
        ...body.map((ln, i) => h(Text, { key: i }, ln))
      )
    );
  }

  // 提示行按红线 2 写:每一项都是「动作 + 目标」,右侧是真实进度(第 X-Y 行 / 共 N 行),
  // 绝不出现「加载中…/处理中…」这类无目标无进度的字样。
  children.push(
    h(
      Text,
      { key: 'hint', dimColor: true },
      '↑↓/j k 滚动一行 · Ctrl+U/D 翻半页 · g/G 跳顶/底 · ' +
        (showAll ? 'Ctrl+E 折叠工具输出' : 'Ctrl+E 展开工具输出') +
        ' · Esc 关闭视图'
    )
  );

  return h(
    Box,
    {
      flexDirection: 'column',
      marginTop: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
    },
    ...children
  );
}

module.exports = TranscriptView;
module.exports.bodyHeight = bodyHeight;
module.exports.CHROME_ROWS = CHROME_ROWS;
module.exports.MIN_BODY_ROWS = MIN_BODY_ROWS;
