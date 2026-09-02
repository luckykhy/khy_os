'use strict';

/**
 * scrollbackPreserve 测试 — stdout 写入规范化器(第二/三/四层)。
 *
 * 契约要点(第四层为本文件新增):
 *  1. fullscreen 帧(`clear + static + output`)在 static 与快照逐字节一致时剥掉冗余重发;
 *  2. 已验证帧的活动区 output 尾切到 rows-1 个**视觉行**(CJK/软换行感知),保证 ED0 就地擦除后
 *     重印不滚屏 —— 否则帧头/尾行逐帧滚进 scrollback 堆叠成串副本(用户报「对话中重复渲染多次」);
 *  3. 未经字节级校验的帧(快照不一致/不可用)绝不剥也绝不切(fail-soft,宁漏勿错);
 *  4. rows/columns 不可用 → 只剥不切;门控关 → 逐字节直通;Buffer 原样进出;
 *  5. 跨 write 拆开的帧(framing 路径)字节保全,flush() 兜底归还。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const sp = require('./scrollbackPreserve');

const ESC = '\x1b';
const CLEAR = ESC + '[2J' + ESC + '[3J' + ESC + '[H'; // modern ink clearTerminal
const CLEAR_FIXED = ESC + '[H' + ESC + '[J'; // win32 normalized in-place erase

// CJK/宽字符显示宽度(与 formatters.displayWidth 同口径的最小替身)。
function fakeWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function makeNormalizer(snapshot, geo) {
  return sp.createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => snapshot,
    ...(geo || {}),
  });
}

function fullscreenFrame(staticText, output) {
  return CLEAR + staticText + output;
}

test('第四层: 超视口 output 被尾切到 rows-1 个视觉行,clear 改写为就地擦除', () => {
  const snapshot = 'S1\nS2\n';
  const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
  const norm = makeNormalizer(snapshot, {
    getRows: () => 10,
    getColumns: () => 80,
    measureWidth: fakeWidth,
  });
  const out = norm.write(fullscreenFrame(snapshot, output));
  assert.ok(out.startsWith(CLEAR_FIXED), 'clear 应改写为 H+J 就地擦除');
  assert.ok(!out.includes(ESC + '[2J') && !out.includes(ESC + '[3J'), '不应残留 2J/3J');
  const kept = out.slice(CLEAR_FIXED.length).split('\n');
  assert.strictEqual(kept.length, 9, '应保留 rows-1 = 9 行');
  assert.strictEqual(kept[kept.length - 1], 'L39', '底部锚定:保留末行');
  assert.strictEqual(kept[0], 'L31', '头部行被舍弃');
});

test('第四层: CJK 宽行的软换行计入视觉行预算', () => {
  const snapshot = '';
  // 每条 100 列显示宽(CJK 50 字)的行,列宽 80 → 每行占 2 视觉行。
  const line = '汉'.repeat(50);
  const output = Array.from({ length: 10 }, (_, i) => line + i).join('\n');
  const norm = makeNormalizer(snapshot, {
    getRows: () => 11,
    getColumns: () => 80,
    measureWidth: fakeWidth,
  });
  const out = norm.write(fullscreenFrame(snapshot, output));
  const kept = out.slice(CLEAR_FIXED.length).split('\n');
  // 预算 rows-1 = 10 视觉行,每行 2 视觉行 → 保留 5 条原始行。
  assert.strictEqual(kept.length, 5);
  assert.strictEqual(kept[kept.length - 1], line + '9');
});

test('第四层: output 在预算内 → 只剥 static,不改动 output 字节', () => {
  const snapshot = 'S\n';
  const output = 'a\nb\nc';
  const norm = makeNormalizer(snapshot, {
    getRows: () => 36,
    getColumns: () => 80,
    measureWidth: fakeWidth,
  });
  const out = norm.write(fullscreenFrame(snapshot, output));
  assert.strictEqual(out, CLEAR_FIXED + output);
});

test('第三层契约不受影响: static 与快照不一致 → 不剥不切(仅清屏形式改写仍生效)', () => {
  const output = Array.from({ length: 100 }, (_, i) => 'L' + i).join('\n');
  const norm = makeNormalizer('MISMATCH', {
    getRows: () => 10,
    getColumns: () => 80,
    measureWidth: fakeWidth,
  });
  const frame = CLEAR + 'OTHER-STATIC\n' + output;
  // 清屏形式改写(第二层)对任何含清屏头的帧生效;但 static 保留、output 不尾切。
  assert.strictEqual(norm.write(frame), CLEAR_FIXED + 'OTHER-STATIC\n' + output);
});

test('第三层契约: 快照不可用(null) → 不剥不切(仅清屏形式改写仍生效)', () => {
  const norm = makeNormalizer(null, { getRows: () => 10 });
  const frame = CLEAR + 'S\n' + 'x\ny';
  assert.strictEqual(norm.write(frame), CLEAR_FIXED + 'S\n' + 'x\ny');
});

test('第四层门控 KHY_FULLSCREEN_TAILCUT=0 → 只剥 static 不切', () => {
  const snapshot = 'S\n';
  const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
  const norm = sp.createClearTerminalNormalizer(
    { KHY_FULLSCREEN_TAILCUT: '0' },
    'win32',
    { getStaticSnapshot: () => snapshot, getRows: () => 10, measureWidth: fakeWidth }
  );
  const out = norm.write(fullscreenFrame(snapshot, output));
  assert.strictEqual(out, CLEAR_FIXED + output);
});

test('fail-soft: getRows 缺失或 ≤1 → 只剥 static 不切', () => {
  const snapshot = 'S\n';
  const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
  const noGeo = makeNormalizer(snapshot, {});
  assert.strictEqual(noGeo.write(fullscreenFrame(snapshot, output)), CLEAR_FIXED + output);
  const badRows = makeNormalizer(snapshot, { getRows: () => 1 });
  assert.strictEqual(badRows.write(fullscreenFrame(snapshot, output)), CLEAR_FIXED + output);
  const throwing = sp.createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => snapshot,
    getRows: () => {
      throw new Error('tty gone');
    },
  });
  assert.strictEqual(throwing.write(fullscreenFrame(snapshot, output)), CLEAR_FIXED + output);
});

test('_tailcutOutputToRows 纯函数: 预算内返回原引用;单行超预算饱和保留末行;末尾 \\n 保留', () => {
  const text = 'a\nb\nc';
  assert.strictEqual(sp._tailcutOutputToRows(text, 10), text, '预算内 → 同引用');
  // 单行 200 列、列宽 80 → 3 视觉行;maxRows=2 放不下 → 饱和保留末行整行。
  const wide = 'x'.repeat(200);
  assert.strictEqual(
    sp._tailcutOutputToRows('a\n' + wide, 2, fakeWidth, 80),
    wide,
    '单行超预算 → 保留末行'
  );
  // 末尾 \n 状态保留。
  assert.strictEqual(sp._tailcutOutputToRows('a\nb\n', 1, fakeWidth, 80), 'b\n');
  // 异常/垃圾入参 → 原样返回。
  assert.strictEqual(sp._tailcutOutputToRows(null, 5), null);
  assert.strictEqual(sp._tailcutOutputToRows('abc', NaN), 'abc');
});

test('Buffer 输入仍工作: 返回 Buffer 且内容为归一化字节', () => {
  const snapshot = 'S\n';
  const norm = makeNormalizer(snapshot, { getRows: () => 36 });
  const out = norm.write(Buffer.from(fullscreenFrame(snapshot, 'a\nb'), 'utf8'));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString('utf8'), CLEAR_FIXED + 'a\nb');
});

test('跨 write 拆开的帧: 字节保全(暂存到完整再判,flush 兜底)', () => {
  const snapshot = 'STATIC-BODY\n';
  const norm = makeNormalizer(snapshot, { getRows: () => 36 });
  const frame = CLEAR + snapshot + 'live\nrows';
  const first = norm.write(frame.slice(0, 6));
  assert.strictEqual(first, '', '半帧被暂存');
  const second = norm.write(frame.slice(6));
  assert.strictEqual(second, CLEAR_FIXED + 'live\nrows', '凑齐后剥 static 输出');
  assert.strictEqual(norm.flush(), '');
});

test('第二层契约: 非 fullscreen 增量帧逐字节直通(仅剥可能混入的 3J)', () => {
  const norm = makeNormalizer('S\n', { getRows: () => 36 });
  const frame = ESC + '[2K' + ESC + '[1A' + ESC + '[2K' + ESC + '[G' + 'hello\nworld';
  assert.strictEqual(norm.write(frame), frame);
});

test('门控 KHY_PRESERVE_SCROLLBACK=0 → 整体逐字节直通', () => {
  const norm = sp.createClearTerminalNormalizer({ KHY_PRESERVE_SCROLLBACK: '0' }, 'win32', {
    getStaticSnapshot: () => 'S\n',
    getRows: () => 10,
  });
  const frame = CLEAR + 'S\n' + 'output';
  assert.strictEqual(norm.write(frame), frame);
});
