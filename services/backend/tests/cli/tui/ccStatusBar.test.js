'use strict';

/**
 * tests/cli/tui/ccStatusBar.test.js —— 状态栏片段决策的回归护栏。
 *
 * 钉住 BUG-105：vim-insert 段的竖线字形曾与列分隔符 STATUS_SEPARATOR(' │ ') 同为 │，
 * 拼出 '│ │' 双竖线。这里用**结构不变式**（渲染行不得出现相邻分隔符 / 任一段不得以
 * 分隔符字符为首尾）来守，而不硬编码具体替换字形（▌/● 属视觉取舍）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildStatusSegments } = require('../../../src/cli/tui/utils/ccStatusBar');
const { STATUS_SEPARATOR } = require('../../../src/cli/tui/utils/ccLayout');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

// 与 CcStatusLine.renderSegments 同构：前导空格 + 各段以 STATUS_SEPARATOR 连接。
function renderJoined(segments) {
  return ' ' + segments.map((s) => s.text).join(STATUS_SEPARATOR);
}

// 全量片段输入（宽 cols → 不触发丢段），逐 vim 子模式。
function fullSegments(vimMode) {
  return buildStatusSegments({
    cols: 200,
    modelName: 'anthropic:claude-sonnet-4-5',
    contextStr: 'Context 42% (54k/128k)',
    contextColor: undefined,
    cost: 1.23,
    costStr: '$1.23',
    vimMode,
    taskEstimate: '9h',
    permissionProfile: 'acceptEdits',
    cacheHitRate: 55,
    mcpStatus: { servers: [{ name: 'a', state: 'connected' }, { name: 'b', state: 'disconnected' }] },
  });
}

const SEP_CHAR = STATUS_SEPARATOR.trim(); // '│'

test('BUG-105: 任一 vim 子模式下渲染行都不出现 "│ │" 相邻分隔符碰撞', () => {
  for (const mode of ['normal', 'insert', 'visual']) {
    const line = renderJoined(fullSegments(mode));
    assert.ok(!line.includes(`${SEP_CHAR} ${SEP_CHAR}`),
      `vim=${mode} 出现双竖线碰撞: ${JSON.stringify(line)}`);
  }
});

test('BUG-105: 无片段文本以分隔符字符为首或尾（否则与 " │ " 粘连）', () => {
  for (const mode of ['normal', 'insert', 'visual']) {
    for (const seg of fullSegments(mode)) {
      const t = seg.text.trim();
      assert.ok(!t.startsWith(SEP_CHAR) && !t.endsWith(SEP_CHAR),
        `vim=${mode} 片段 "${seg.text}" 首尾含分隔符 "${SEP_CHAR}"`);
    }
  }
});

test('不变式：cols 越紧，被选中的片段总显示宽度不超过 cols', () => {
  for (const cols of [200, 80, 60, 40, 30, 20]) {
    const segs = buildStatusSegments({
      cols,
      modelName: 'anthropic:claude-sonnet-4-5',
      contextStr: 'Context 42% (54k/128k)',
      cost: 1.23, costStr: '$1.23',
      vimMode: 'insert', taskEstimate: '9h',
      permissionProfile: 'acceptEdits', cacheHitRate: 55,
      mcpStatus: { servers: [{ name: 'a', state: 'connected' }] },
    });
    assert.ok(visWidth(renderJoined(segs)) <= cols,
      `cols=${cols} 溢出：宽 ${visWidth(renderJoined(segs))} > ${cols}（会折成 2 行 → 2J 残影）`);
  }
});
