'use strict';

/**
 * ccMessageProjection leaf tests (node:test).
 *
 * Covers the invariants that the whole CC selection feature rests on:
 *   - `lines.length === anchors.length` (the CONSTRUCTIVE form of row === index)
 *   - assistant bullet prefix in all four (logicalRow, softSegment) cases
 *   - `soft` marking: true only when the next row continues the SAME logical line
 *   - extractByAnchors: soft wrap joins with NO '\n', hard wrap joins with one,
 *     content comes from the ORIGINAL message text (never from screen chrome)
 *   - structural rows (logo / toasts / status / prompt) line-count parity
 *   - never throws on garbage input
 *
 * Run: `node --test tests/cli/tui/ccMessageProjection.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');

const P = require('../../../src/cli/tui/ink-components/ccMessageProjection');

const {
  projectCcScene,
  sliceViewport,
  screenRowToIndex,
  applyScrollToProjection,
  extractByAnchors,
  colToOffset,
  centerIn,
  padEnd,
  windowHint,
  PROMPT_PREFIX,
  PLACEHOLDERS,
  STREAMING_TEXT,
} = P;

/** 便捷构造：只有消息的场景（其余 chrome 用默认）。 */
function scene(messages, extra = {}) {
  return projectCcScene(Object.assign({ cols: 60, rows: 24, messages }, extra));
}

function sel(aLine, aCol, hLine, hCol) {
  return { anchor: { line: aLine, col: aCol }, head: { line: hLine, col: hCol }, dragging: false };
}

/**
 * 第一条消息的首行下标（按 anchor 定位）。
 * 不要写死 `lines[5]` —— chrome 高度会随列宽变化（窄终端下 Logo 副标题本身就要
 * 折行多占一行），写死的下标会在某天悄悄指向隔壁行。
 */
function m0(r) {
  const i = r.anchors.findIndex((a) => a !== null);
  assert.ok(i >= 0, '场景里应当有消息行');
  return i;
}

/** 最后一条消息行下标。 */
function mLast(r) {
  return r.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
}

// ── 不变式 ──────────────────────────────────────────────────────────────────

test('lines 与 anchors 长度恒等（row === index 的构造性保证）', () => {
  const cases = [
    scene([]),
    scene([{ id: 1, role: 'user', text: 'hi' }]),
    scene([{ id: 1, role: 'assistant', text: 'a\nb\n\nc' }]),
    scene([{ id: 1, role: 'assistant', text: 'x'.repeat(500) }], { cols: 20 }),
    scene([{ id: 1, role: 'user', text: 'hi' }], { busy: true }),
    scene([], { messageBar: { type: 'error', message: 'boom' } }),
    scene([], { toasts: [{ id: 1, message: 'a', type: 'info' }] }),
  ];
  for (const r of cases) {
    assert.strictEqual(r.lines.length, r.anchors.length, 'lines/anchors 长度必须恒等');
  }
});

test('绝不抛：垃圾输入一律退化', () => {
  const garbage = [undefined, null, 0, '', [], {}, NaN];
  for (const g of garbage) {
    const r = projectCcScene(g);
    assert.ok(Array.isArray(r.lines));
    assert.strictEqual(r.lines.length, r.anchors.length);
    assert.strictEqual(extractByAnchors(r, null), '');
  }
  // 垃圾消息
  const r2 = scene([null, undefined, {}, { id: 1 }, { id: 2, role: 'weird', text: 123 }]);
  assert.strictEqual(r2.lines.length, r2.anchors.length);
});

// ── Logo ────────────────────────────────────────────────────────────────────

test('CcLogo：marginY 1×2 + 标题 + 副标题，且 alignItems center 居中', () => {
  const r = scene([], { cols: 60 });
  assert.strictEqual(r.lines[0], ''); // marginTop
  assert.strictEqual(r.lines[1], centerIn('✳ Khy', 60));
  assert.strictEqual(r.lines[2], centerIn('AI-powered coding assistant', 60));
  assert.strictEqual(r.lines[3], ''); // marginBottom
  // 居中：前导空格数 = floor((cols - w) / 2)
  assert.ok(r.lines[1].startsWith(' '));
  assert.strictEqual(r.lines[1], r.lines[1].trim().padStart(r.lines[1].length - 0));
});

test('centerIn / padEnd 按显示宽度（CJK=2）', () => {
  assert.strictEqual(centerIn('ab', 6), '  ab');
  assert.strictEqual(centerIn('中文', 8), '  中文'); // 宽 4 → 前导 2
  assert.strictEqual(padEnd('ab', 5), 'ab   ');
  assert.strictEqual(padEnd('中文', 6), '中文  '); // 宽 4 → 补 2
});

// ── 消息区 ──────────────────────────────────────────────────────────────────

test('每条消息前恰一个空行（marginTop: 1）', () => {
  const r = scene([
    { id: 1, role: 'user', text: 'u' },
    { id: 2, role: 'assistant', text: 'a' },
  ]);
  // logo 占 0..3，然后消息1 = [空行, 'u']，消息2 = [空行, '● a']
  assert.strictEqual(r.lines[4], '');
  assert.strictEqual(r.lines[5], 'u');
  assert.strictEqual(r.lines[6], '');
  assert.strictEqual(r.lines[7], '● a');
});

test('assistant 首行：● 恒占第 0 列，正文在 cols-1 内折行', () => {
  // cols=20 → `●` 固定 1 列，正文折行宽度 = 19 → ' ' + 9 个 CJK（19 列）正好放满
  const r = scene([{ id: 1, role: 'assistant', text: '中'.repeat(10) + '\n' + '中'.repeat(10) }], {
    cols: 20,
  });
  const i = m0(r);
  // 首逻辑行首段：● + ' ' + 9 CJK
  assert.strictEqual(r.lines[i], '● ' + '中'.repeat(9));
  // 首逻辑行软续段：1 空格（对齐 ●）+ 剩下的 1 个 CJK
  assert.strictEqual(r.lines[i + 1], ' ' + '中');
  // 第二逻辑行：整段是 `'  ' + 10 CJK`，wrap-ansi 按**词**折 —— 20 列的词塞不进
  // 前 2 列之后，被整个挪到下一行，首段只剩前缀（trimEnd 后为空）
  assert.strictEqual(r.lines[i + 2], '');
  assert.strictEqual(r.lines[i + 3], '中'.repeat(10));
});

test('assistant 首行：● 永不消失（哪怕正文远超屏宽）—— 与旧「挤压」行为的回归防线', () => {
  for (const cols of [20, 40, 60, 80]) {
    for (const len of [1, 20, cols - 2, cols - 1, cols, cols + 1, 300]) {
      const r = scene([{ id: 1, role: 'assistant', text: 'x'.repeat(len) }], { cols });
      const first = r.lines.findIndex((l) => l.startsWith('●'));
      assert.ok(first >= 0, 'cols=' + cols + ' len=' + len + '：● 必须可见\n' + r.lines.join('\n'));
      // 首行必须是 `●` 打头，且总宽度不超过 cols
      assert.ok(
        r.lines[first].length <= cols,
        'cols=' + cols + '：首行不得超宽，实为 ' + r.lines[first].length
      );
    }
  }
});

test('soft 标记：只有同逻辑行的续段之间才是软换行', () => {
  const r = scene([{ id: 1, role: 'assistant', text: 'a'.repeat(40) + '\n' + 'b' }], { cols: 20 });
  const i = m0(r);
  // cols=20，● 占 1 列 → 正文折行宽度 19 → 40 个字符折成 18/18/4 三段
  assert.strictEqual(r.anchors[i].soft, true, '第 1 段后还有同逻辑行的第 2 段');
  assert.strictEqual(r.anchors[i + 1].soft, true, '第 2 段后还有同逻辑行的第 3 段');
  assert.strictEqual(r.anchors[i + 2].soft, false, '第 3 段是首逻辑行末段 → 硬换行');
  assert.strictEqual(r.anchors[i + 3].soft, false, '最后一行 → 不是软续');
});

test('user 消息无前缀', () => {
  const r = scene([{ id: 1, role: 'user', text: 'x'.repeat(40) }], { cols: 20 });
  const i = m0(r);
  assert.strictEqual(r.lines[i], 'x'.repeat(20));
  assert.strictEqual(r.lines[i + 1], 'x'.repeat(20));
});

test('非 user 角色一律走 assistant 形状（与 CcApp 的三元一致）', () => {
  const r = scene([{ id: 1, role: 'weird', text: 'q' }]);
  assert.strictEqual(r.lines[5], '● q');
});

test('窗口化提示行在消息区之前', () => {
  const r = scene([{ id: 1, role: 'user', text: 'u' }], { hiddenCount: 7 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.lines[4], windowHint(7));
  assert.strictEqual(r.lines[5], '');
});

test('busy 时追加流式行（● 思考中...│）', () => {
  const r = scene([{ id: 1, role: 'user', text: 'u' }], { busy: true });
  const idx = r.lines.length - 1 - 1; // 末尾是 prompt，往前找
  const joined = r.lines.join('\n');
  assert.ok(joined.includes('● ' + STREAMING_TEXT + '│'), '应含流式行与光标: ' + joined);
  assert.ok(idx >= 0);
});

// ── 抽取（复制的唯一真源）────────────────────────────────────────────────────

test('extractByAnchors：单行取词', () => {
  const r = scene([{ id: 1, role: 'assistant', text: 'abcdefgh' }], { cols: 60 });
  assert.strictEqual(extractByAnchors(r, sel(5, 2, 5, 6)), 'abcd');
});

test('extractByAnchors：跨软换行**不**插硬 \\n', () => {
  const src = 'a'.repeat(18) + 'b'.repeat(18) + 'CDEFG';
  const r = scene([{ id: 1, role: 'assistant', text: src }], { cols: 20 });
  // 整条消息拖到底：软换行处不得插入硬换行
  const got = extractByAnchors(r, sel(m0(r), 2, mLast(r), r.lines[mLast(r)].length));
  assert.strictEqual(got, src, '软换行处不得插入硬换行，实为 ' + JSON.stringify(got));
  assert.ok(!got.includes('\n'));
});

test('extractByAnchors：跨硬换行插恰好一个 \\n', () => {
  const r = scene([{ id: 1, role: 'assistant', text: 'ab\ncd' }], { cols: 60 });
  // 行5 = '● ab'，行6 = '  cd'
  assert.strictEqual(extractByAnchors(r, sel(5, 2, 6, 4)), 'ab\ncd');
});

test('extractByAnchors：CJK 按显示列换算（col 2→8 = 3 个汉字）', () => {
  const r = scene([{ id: 1, role: 'assistant', text: '中文测试内容' }], { cols: 60 });
  assert.strictEqual(extractByAnchors(r, sel(5, 2, 5, 8)), '中文测');
});

test('extractByAnchors：取的是原文，绝不带 ● 前缀／软续空格', () => {
  const r = scene([{ id: 1, role: 'assistant', text: 'hello' }], { cols: 60 });
  const got = extractByAnchors(r, sel(5, 0, 5, 20));
  assert.strictEqual(got, 'hello');
  assert.ok(!got.includes('●'));
});

test('extractByAnchors：跨消息用空行分隔', () => {
  const r = scene(
    [
      { id: 1, role: 'user', text: 'AAA' },
      { id: 2, role: 'assistant', text: 'BBB' },
    ],
    { cols: 60 }
  );
  // 行5 = 'AAA'，行6 = ''（marginTop），行7 = '● BBB'
  const got = extractByAnchors(r, sel(5, 0, 7, 6));
  assert.strictEqual(got, 'AAA\n\nBBB');
});

test('extractByAnchors：空选区 → 空串，越界行不炸', () => {
  const r = scene([{ id: 1, role: 'user', text: 'AAA' }], { cols: 60 });
  assert.strictEqual(extractByAnchors(r, sel(5, 1, 5, 1)), '');
  assert.strictEqual(extractByAnchors(r, null), '');
  assert.strictEqual(extractByAnchors(r, sel(999, 0, 1000, 5)), '');
});

test('extractByAnchors：结构行退化为按列切屏幕行', () => {
  const r = scene([{ id: 1, role: 'user', text: 'AAA' }], {
    toasts: [{ id: 9, message: 'copied', type: 'success' }],
  });
  const i = r.lines.findIndex((l) => l.includes('copied'));
  assert.ok(i > 0);
  // '✓ copied' → col [0,6) = '✓ copi'（图标 + 空格 + 4 个字母）
  assert.strictEqual(extractByAnchors(r, sel(i, 0, i, 6)), '✓ copi');
});

test('colToOffset：宽字符落点取字符起点，越界取行尾', () => {
  assert.strictEqual(colToOffset('abcd', 0), 0);
  assert.strictEqual(colToOffset('abcd', 2), 2);
  assert.strictEqual(colToOffset('中文', 0), 0);
  assert.strictEqual(colToOffset('中文', 2), 1, '第 2 个汉字的起始列');
  assert.strictEqual(colToOffset('中文', 3), 1, '落在第 2 个汉字中间 → 取其起点');
  assert.strictEqual(colToOffset('中文', 99), 2);
  assert.strictEqual(colToOffset('', 5), 0);
});

// ── 结构行 ──────────────────────────────────────────────────────────────────

test('CcMessageBar：上边框 + 内容 + 下边框 = 3 行，且都满宽', () => {
  const r = scene([], { cols: 40, messageBar: { type: 'error', message: 'boom' } });
  const i = r.lines.findIndex((l) => l.startsWith('╭'));
  assert.ok(i >= 0);
  assert.strictEqual(r.lines[i].length, 40);
  assert.ok(r.lines[i + 1].startsWith('│ ') && r.lines[i + 1].endsWith(' │'));
  assert.strictEqual(r.lines[i + 1].length, 40);
  assert.strictEqual(r.lines[i + 2].length, 40);
  assert.ok(r.lines[i + 2].startsWith('╰'), '下边框');
  assert.ok(!r.lines[i + 1].includes('╭'), '内容行不得再含边框字符');
});

test('CcMessageBar：无 message 则不吐行', () => {
  const a = scene([], { messageBar: null });
  const b = scene([], { messageBar: { type: 'info', message: '' } });
  assert.ok(!a.lines.some((l) => l.startsWith('╭')));
  assert.ok(!b.lines.some((l) => l.startsWith('╭')));
});

test('CcToast：每个 toast 恰 1 行，含图标', () => {
  const base = scene([]).lines.length;
  const r = scene([], {
    toasts: [
      { id: 1, message: 'one', type: 'success' },
      { id: 2, message: 'two', type: 'error' },
      { id: 3, message: '', type: 'info' }, // 空 message → 组件 return null
    ],
  });
  assert.strictEqual(r.lines.length, base + 2);
  assert.ok(r.lines.includes('✓ one'));
  assert.ok(r.lines.includes('✗ two'));
});

test('CcStatusLine：恰 1 行，段落的取舍按**实际显示宽度**而非列数阈值（BUG-82）', () => {
  const { buildStatusSegments, lineWidth } = require('../../../src/cli/tui/utils/ccStatusBar');
  const fat = {
    modelName: 'anthropic:claude-sonnet-4-5',
    contextStr: 'Context 100% (148k/128k)',
    cost: 3.72,
    costStr: '$3.72',
    vimMode: 'normal',
    taskEstimate: '2m',
    permissionProfile: 'acceptEdits',
    cacheHitRate: 82,
    mcpStatus: { servers: [{ name: 'a', state: 'connected' }, { name: 'b', state: 'failed' }] },
  };

  // 契约：任何 cols 下行宽 ≤ cols（宁可丢段，绝不多占一行 —— 账本只记 1 行）。
  // 「保底三段」= 模型名 + 上下文**百分比** + 模式，用同一函数在宽终端量出它们的
  // 真实宽度（不能用当前 cols 的结果量：那里模型名可能已被裁，量出来永远放得下）。
  const floorWidth = lineWidth(buildStatusSegments({
    cols: 999,
    modelName: fat.modelName,
    contextStr: '100%',
    permissionProfile: fat.permissionProfile,
  }));
  for (const cols of [20, 30, 40, 55, 60, 80, 90, 100, 120, 200]) {
    const segs = buildStatusSegments(Object.assign({ cols }, fat));
    assert.ok(
      lineWidth(segs) <= cols,
      `cols=${cols} 状态栏宽 ${lineWidth(segs)} 应 ≤ ${cols}（否则 ink 折行 ⇒ 帧高越过终端 ⇒ \x1b[2J 重影）`
    );
    if (floorWidth <= cols) {
      const keys = segs.map((s) => s.key);
      for (const k of ['model', 'context', 'mode']) {
        assert.ok(keys.includes(k), `cols=${cols} 放得下保底三段（${floorWidth}）却丢了 ${k}`);
      }
    }
  }

  // 丢段顺序：锦上添花先走，安全信息（模式）留到最后。
  const keys90 = buildStatusSegments(Object.assign({ cols: 90 }, fat)).map((s) => s.key);
  assert.ok(!keys90.includes('mcp'), '90 列放不下 MCP 段 → 先丢它');
  assert.ok(keys90.includes('mode'), '模式段（会不会改文件）必须活到最后');
  const keys40 = buildStatusSegments(Object.assign({ cols: 40 }, fat)).map((s) => s.key);
  assert.ok(!keys40.includes('cost') && !keys40.includes('vim'), '40 列只留保底段');

  // 旧行为对照：`cols >= 50` 的门槛让 49 列**连模式都不显示**，哪怕一行放得下。
  // 现在放得下就显示 —— 这才是「1 行」这个不变式该有的样子。
  const midRow = scene([], {
    cols: 55,
    status: { modelName: 'Khy-4', contextStr: 'Context 12% (1/8k)', permissionProfile: 'yolo' },
  }).lines.find((l) => l.includes('Khy-4'));
  assert.ok(midRow.includes('⚡ yolo'), '55 列放得下就保留模式段');
  assert.ok(midRow.includes('1/8k'), '55 列放得下就保留完整上下文（旧实现按 <60 硬砍）');

  const tiny = scene([], {
    cols: 40,
    status: fat,
  }).lines.find((l) => l.includes('anthropic:claude-sonnet-4'));
  assert.ok(tiny, '状态栏仍应出现（被裁而非消失）');
  assert.ok(!tiny.includes('$3.72'), '40 列丢费用段');
});

test('CcPromptInput：空值显示占位符，busy 显示 thinking', () => {
  const idle = scene([], { prompt: { value: '', offset: 0 } });
  assert.ok(idle.lines.includes(PROMPT_PREFIX + PLACEHOLDERS.default));
  const busy = scene([], { prompt: { value: '', offset: 0, busy: true } });
  assert.ok(busy.lines.includes(PROMPT_PREFIX + PLACEHOLDERS.busy));
});

test('CcPromptInput：光标按真实列插入（BUG-99）', () => {
  // offset=文本长度 落在 segment 末 → 与旧「文本之后」姿势逐字节一致。
  const atEnd = scene([], { prompt: { value: 'abc', offset: 3 } });
  assert.strictEqual(atEnd.lines[atEnd.lines.length - 1], '> abc│');
  // 行内光标：offset=3 在 'abc def' 的 'c' 与空格之间，不得钉到 segment 末尾。
  const mid = scene([], { prompt: { value: 'abc def', offset: 3 } });
  assert.ok(mid.lines.includes('> abc│ def'), '行内光标须插在真实列: ' + JSON.stringify(mid.lines));
  // offset=0（恢复草稿）须落在提示符后第 2 列、文本之前。
  const head = scene([], { prompt: { value: 'abc def', offset: 0 } });
  assert.ok(head.lines.includes('> │abc def'), 'offset0 光标须在文本前: ' + JSON.stringify(head.lines));
});

test('CcPromptInput：超出 maxRows 时窗口化并加 ⋯ 指示', () => {
  const r = scene([], {
    rows: 24,
    prompt: { value: Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n'), offset: 0, maxRows: 3 },
  });
  const tail = r.lines.slice(-4).join('\n');
  assert.ok(tail.includes('lines below'), '应出现下方截断提示: ' + tail);
});

// ── 视口 / 滚动 ─────────────────────────────────────────────────────────────

test('sliceViewport：按 offset 切段且 anchors 同步', () => {
  const r = scene([{ id: 1, role: 'assistant', text: 'a'.repeat(100) }], { cols: 20 });
  const v = sliceViewport(r, 5, 2);
  assert.strictEqual(v.start, 5);
  assert.deepStrictEqual(v.lines, r.lines.slice(5, 7));
  assert.deepStrictEqual(v.anchors, r.anchors.slice(5, 7));
});

test('screenRowToIndex：offset 为 null/负数按贴底解释', () => {
  const total = 20;
  const height = 5;
  assert.strictEqual(screenRowToIndex(0, null, total, height), total - height);
  assert.strictEqual(screenRowToIndex(0, -1, total, height), total - height);
  assert.strictEqual(screenRowToIndex(3, 10, total, height), 13);
  assert.strictEqual(screenRowToIndex(999, 0, total, height), total - 1, 'clamp 到末行');
});

test('applyScrollToProjection：委托给 scrollActions 并 clamp', () => {
  // total 20, height 5 → maxOffset 15
  assert.strictEqual(applyScrollToProjection('lineDown', 0, 20, 5), 1);
  assert.strictEqual(applyScrollToProjection('bottom', 0, 20, 5), 15);
  assert.strictEqual(applyScrollToProjection('lineUp', 0, 20, 5), 0);
  assert.strictEqual(applyScrollToProjection('halfPageDown', 0, 20, 5), 2);
  assert.strictEqual(applyScrollToProjection('bogus', 7, 20, 5), 7, '未知动作 → 不动');
});

// ── 整帧行数（防止行号漂移的护栏）──────────────────────────────────────────

test('整帧行数 = chrome + 消息行（可预测，不随宽度意外膨胀）', () => {
  const r = scene(
    [
      { id: 1, role: 'user', text: 'u' },
      { id: 2, role: 'assistant', text: 'a' },
    ],
    { cols: 60 }
  );
  // logo 4 行 + (空行+u) 2 + (空行+● a) 2 + status 1 + prompt 1 = 10
  //   ↑ prompt 空值时只有 **1** 行（占位符 '> Send a message...'）。曾经多出的
  //   第 2 行 '> '（value='' 经 split('\n') 产出的空壳内容行，与占位符行的 '>' 叠成
  //   两行）是缺陷（BUG-106）；CcPromptInput.js 与 emitPromptInput 已同步跳过空缓冲区
  //   的内容行，画面与账本都少这 1 行。oracle 测试对占位符逐字节断言仍成立。
  assert.strictEqual(r.lines.length, 10);
  assert.strictEqual(r.lines[r.lines.length - 1], '> Send a message...');
  assert.notStrictEqual(r.lines[r.lines.length - 2], '> ', '空态不应再有多余的孤立 > 前缀行');
});

// ── 视口区间与 flexGrow 补白（[DESIGN-ARCH-124] 方案 A 的接线面）────────────

test('spans.viewport 覆盖「已提交消息」那一段（不含 Logo/提示/流式行/底栏）', () => {
  const r = scene(
    [
      { id: 1, role: 'user', text: 'u' },
      { id: 2, role: 'assistant', text: 'a' },
    ],
    { cols: 60 }
  );
  const vp = r.spans.viewport;
  // 消息区 = [空行, 'u', 空行, '● a']，正好是从 m0 之前那个空行起算
  assert.strictEqual(r.lines[vp.start], '');
  assert.strictEqual(r.lines[vp.start + 1], 'u');
  assert.strictEqual(r.lines[vp.end - 1], '● a');
  // 尾部是底栏与输入框 —— 绝不能被划进视口（无消息归属 = anchor 为 null）
  assert.strictEqual(r.anchors[vp.end], null, '视口之后应是底栏，不是消息行');
  assert.strictEqual(r.lines[r.lines.length - 1], '> ' + PLACEHOLDERS.default);
});

test('spans.viewport 在窗口化提示/流式行存在时也边界正确', () => {
  const r = scene([{ id: 1, role: 'user', text: 'u' }], { hiddenCount: 3, busy: true });
  const vp = r.spans.viewport;
  assert.strictEqual(r.lines[vp.start - 1], windowHint(3), '提示行在视口之前');
  assert.strictEqual(r.lines[vp.start], '');
  assert.strictEqual(r.lines[vp.end - 1], 'u', '视口末尾是最后一条消息行');
  const joined = r.lines.slice(vp.end).join('\n');
  assert.ok(joined.includes(STREAMING_TEXT), '流式行在视口之后，仍是组件渲染');
});

test('padToRows：补白落在视口区间内，且整帧行数 == 终端行数', () => {
  const r = scene([{ id: 1, role: 'user', text: 'u' }], { cols: 60, padToRows: 24 });
  assert.strictEqual(r.lines.length, 24, '整帧应当铺满终端');
  const vp = r.spans.viewport;
  // 补白是 Viewport 要画的空行 ⇒ 计入区间
  assert.ok(vp.end > r.spans.messages.end, '补白必须计入 viewport 区间');
  for (let i = r.spans.messages.end; i < vp.end; i++) {
    assert.strictEqual(r.lines[i], '', '补白行必须是空行');
    assert.strictEqual(r.anchors[i], null);
  }
  assert.strictEqual(r.lines.length, r.anchors.length, '补白后仍要长度恒等');
});

test('padToRows：不足/不传时按自然高度，不补也不截', () => {
  const natural = scene([{ id: 1, role: 'user', text: 'u' }], { cols: 60 }).lines.length;
  assert.strictEqual(
    scene([{ id: 1, role: 'user', text: 'u' }], { cols: 60, padToRows: 4 }).lines.length,
    natural,
    '目标行数小于自然高度 → 不截断（截断会让底栏凭空消失）'
  );
  assert.strictEqual(
    scene([{ id: 1, role: 'user', text: 'u' }], { cols: 60, padToRows: 0 }).lines.length,
    natural
  );
});

// ── BUG-77b：chrome 降级必须同步反映在投影里 ───────────────────────────────
// 短终端上账本会让欢迎横幅 / 折叠提示行降级。渲染侧不画而投影照旧吐这些行 ⇒
// 「屏幕行 == 投影下标」整体错位，拖选选中的是隔壁那行文字。

test('chrome 降级：投影行数随 banner / tagline / hint 同步增减', () => {
  const msgs = [{ id: 1, role: 'user', text: 'hi' }, { id: 2, role: 'user', text: 'yo' }];
  const base = { cols: 60, rows: 24, messages: msgs, hiddenCount: 1 };
  const full = projectCcScene(base);
  const noTagline = projectCcScene({ ...base, chrome: { subtitle: false } });
  const noHint = projectCcScene({ ...base, chrome: { hint: false } });
  const noBanner = projectCcScene({ ...base, chrome: { banner: false } });

  assert.strictEqual(full.lines.length - noTagline.lines.length, 1, 'tagline 一档 = 1 行');
  assert.strictEqual(full.lines.length - noHint.lines.length, 1, '提示行一档 = 1 行');
  assert.strictEqual(full.lines.length - noBanner.lines.length, 4, '整块横幅 = 4 行(marginY 1×2 + 标题 + 副标题)');
  for (const r of [noTagline, noHint, noBanner]) {
    assert.strictEqual(r.lines.length, r.anchors.length, '降级后 lines/anchors 仍须恒等');
    assert.ok(r.spans.messages.start <= m0(r), '消息区起点不晚于首个锚点行');
  }
  // 提示行就压在消息区上面一行：它在不在，投影必须和画面说同一句话。
  const rowAbove = (r) => r.lines[r.spans.messages.start - 1] || '';
  assert.match(rowAbove(full), /已收起/);
  assert.doesNotMatch(rowAbove(noHint), /已收起/);
  assert.match(rowAbove(noTagline), /已收起/, '只降级 tagline 时提示行仍归账本所有');
});
