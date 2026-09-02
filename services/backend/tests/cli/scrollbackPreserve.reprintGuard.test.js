'use strict';

// scrollbackPreserve 第三层(全屏帧整段转录重发抑制)单测:
// fullscreen 帧 `clearTerminal + fullStaticOutput + output` 在字节级校验通过时
// 剥掉冗余 static 段;校验失败/快照缺失/门控关 → 逐字节回退。

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/scrollbackPreserve');
const { createClearTerminalNormalizer, isReprintGuardEnabled } = leaf;

const ESC = String.fromCharCode(27); // 显式构造,不在源码里嵌不可见字面 ESC 字节
const NIX_CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`; // 现代形式(Win11 亦然)
const WIN32_CLEAR = `${ESC}[2J${ESC}[0f`; // 老 conhost 形式
const WIN32_INPLACE = `${ESC}[H${ESC}[J`; // win32 归一化目标
const STRIPPED_NIX = `${ESC}[2J${ESC}[H`; // 现代形式剥 3J 后

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('isReprintGuardEnabled 默认开,显式 falsy 关', () => {
  assert.strictEqual(isReprintGuardEnabled({}), true);
  assert.strictEqual(isReprintGuardEnabled({ KHY_SUPPRESS_STATIC_REPRINT: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isReprintGuardEnabled({ KHY_SUPPRESS_STATIC_REPRINT: v }), false, v);
  }
});

// ── 完整帧(单次 write) ──────────────────────────────────────────────────────

test('win32 现代形式全屏帧:快照匹配 → static 段被剥,只留就地清屏 + 活动帧', () => {
  const staticOut = 'user: hi\nassistant: hello\nbanner\n';
  const output = 'input box\nfooter\n';
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => staticOut,
  });
  const out = n.write(NIX_CLEAR + staticOut + output);
  assert.strictEqual(out, WIN32_INPLACE + output);
});

test('win32 老 conhost 形式同样被剥', () => {
  const staticOut = 'transcript';
  const output = 'frame';
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => staticOut,
  });
  assert.strictEqual(n.write(WIN32_CLEAR + staticOut + output), WIN32_INPLACE + output);
});

test('non-win32:剥 3J 后校验剥离,保留 2J+H 就地清屏头', () => {
  const staticOut = 'S';
  const output = 'O';
  const n = createClearTerminalNormalizer({}, 'linux', {
    getStaticSnapshot: () => staticOut,
  });
  assert.strictEqual(n.write(NIX_CLEAR + staticOut + output), STRIPPED_NIX + output);
});

test('快照为空串(实例存在但 static 为空)→ 帧原样通过(剥 3J 行为不变)', () => {
  const output = 'frame';
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => '',
  });
  assert.strictEqual(n.write(NIX_CLEAR + output), WIN32_INPLACE + output);
});

// ── 防误伤:字节级校验 ────────────────────────────────────────────────────────

test('快照不匹配(伪造/其他写入)→ 逐字节回退,绝不误伤', () => {
  const frame = NIX_CLEAR + 'not-the-static\ncontent' + 'tail';
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'a-different-static-buffer',
  });
  assert.strictEqual(n.write(frame), WIN32_INPLACE + 'not-the-static\ncontent' + 'tail');
});

test('短于快照的清屏写入无法即时判定 → 暂存,flush 原样归还(不误删字节)', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'much-longer-static-than-the-frame',
  });
  // 长度 < 清屏头 + 快照:无法区分「拆帧」与「无关短写入」→ 暂存等待,flush 兜底归还。
  assert.strictEqual(n.write(NIX_CLEAR + 'short'), '');
  assert.strictEqual(n.flush(), WIN32_INPLACE + 'short');
});

test('快照不可用(null / 非 string)→ 逐字节回退今日行为', () => {
  for (const bad of [null, undefined, 42]) {
    const n = createClearTerminalNormalizer({}, 'win32', { getStaticSnapshot: () => bad });
    const frame = NIX_CLEAR + 'S' + 'O';
    assert.strictEqual(n.write(frame), WIN32_INPLACE + 'S' + 'O', String(bad));
  }
});

test('getter 抛异常 → fail-soft 回退,绝不外抛', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => {
      throw new Error('boom');
    },
  });
  const frame = NIX_CLEAR + 'S' + 'O';
  assert.strictEqual(n.write(frame), WIN32_INPLACE + 'S' + 'O');
});

test('未注入 options(既有调用方)→ 行为与今日逐字节一致', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  const frame = NIX_CLEAR + 'S' + 'O';
  assert.strictEqual(n.write(frame), WIN32_INPLACE + 'S' + 'O');
});

// ── 门控关 ───────────────────────────────────────────────────────────────────

test('KHY_SUPPRESS_STATIC_REPRINT 关 → 全屏帧不剥 static(回退第二层行为)', () => {
  const staticOut = 'S';
  const n = createClearTerminalNormalizer(
    { KHY_SUPPRESS_STATIC_REPRINT: 'off' },
    'win32',
    { getStaticSnapshot: () => staticOut }
  );
  assert.strictEqual(n.write(NIX_CLEAR + staticOut + 'O'), WIN32_INPLACE + staticOut + 'O');
});

test('KHY_PRESERVE_SCROLLBACK 关 = 总门,逐字节回退 ink 原始行为(重发抑制不越过它)', () => {
  const staticOut = 'S';
  const n = createClearTerminalNormalizer(
    { KHY_PRESERVE_SCROLLBACK: '0' },
    'win32',
    { getStaticSnapshot: () => staticOut }
  );
  // 总门关 → 整条 stdout 改写管线(含第三层)停用,ink 原字节直达终端。
  assert.strictEqual(n.write(NIX_CLEAR + staticOut + 'O'), NIX_CLEAR + staticOut + 'O');
});

// ── 跨 write 拆帧 ────────────────────────────────────────────────────────────

test('static 段跨 write 拆开:暂存到完整再校验剥离,不吞字节', () => {
  const staticOut = 'part1|part2';
  const output = 'frame\n';
  let calls = 0;
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => {
      calls += 1;
      return staticOut;
    },
  });
  assert.strictEqual(n.write(NIX_CLEAR + 'part1|'), '');
  assert.strictEqual(n.write('part2' + output), WIN32_INPLACE + output);
  assert.strictEqual(calls, 1, '快照只在暂存时刻读取一次(冻结语义)');
});

test('拆帧后校验失败 → 组装帧逐字节归还(fallback 不丢字节)', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'expected-static',
  });
  // 组装后的 static 段 'expected-Xstatic' ≠ 快照 → 原样归还。
  assert.strictEqual(n.write(NIX_CLEAR + 'expected-X'), '');
  assert.strictEqual(n.write('static' + 'O'), WIN32_INPLACE + 'expected-XstaticO');
});

test('拆帧时快照冻结:后续快照增长不影响本帧校验', () => {
  const staticAtFrameTime = 'frozen-static';
  let snap = staticAtFrameTime;
  const n = createClearTerminalNormalizer({}, 'win32', { getStaticSnapshot: () => snap });
  assert.strictEqual(n.write(NIX_CLEAR + 'frozen-'), '');
  snap = staticAtFrameTime + '-and-much-more-grown-content';
  assert.strictEqual(n.write('static' + 'O'), WIN32_INPLACE + 'O');
});

test('flush 归还未组装完的暂存帧,不吞字节', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'never-completes',
  });
  const partial = NIX_CLEAR + 'half-';
  assert.strictEqual(n.write(partial), '');
  assert.strictEqual(n.flush(), WIN32_INPLACE + 'half-');
  assert.strictEqual(n.flush(), '');
});

// ── Buffer / 普通输出 ────────────────────────────────────────────────────────

test('Buffer 输入:剥离后仍返回 Buffer', () => {
  const staticOut = 'S';
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => staticOut,
  });
  const out = n.write(Buffer.from(NIX_CLEAR + staticOut + 'O', 'utf8'));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString('utf8'), WIN32_INPLACE + 'O');
});

test('普通(非清屏)输出逐字节不动', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'S',
  });
  const s = 'hello\r\nworld\n\x1b[32mgreen\x1b[39m';
  assert.strictEqual(n.write(s), s);
});

test('活动帧以 clear 字节开头但校验失败时,后续帧互不影响', () => {
  const n = createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => 'static-A',
  });
  // 第一帧:匹配 → 剥离。
  assert.strictEqual(n.write(NIX_CLEAR + 'static-A' + 'O1'), WIN32_INPLACE + 'O1');
  // 第二帧:内容不同(伪造)且长度足以即时判定 → 回退。
  assert.strictEqual(
    n.write(NIX_CLEAR + 'other-content-longer-than-snapshot' + 'O2'),
    WIN32_INPLACE + 'other-content-longer-than-snapshotO2'
  );
  // 第三帧:再次匹配 → 再剥离。
  assert.strictEqual(n.write(NIX_CLEAR + 'static-A' + 'O3'), WIN32_INPLACE + 'O3');
});
