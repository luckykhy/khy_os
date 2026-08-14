'use strict';

// Unit tests for the railLayout pure leaf — right-rail gate, the effective-columns
// single source of truth, screen geometry, and the exact ANSI bytes.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const {
  railGateOn, railActive, contentCols, railBottomChrome, railTopOffset, railGeometry,
  bgSequence, buildRailPaint, buildRailClear, DECSC, DECRC,
} = require('../../../src/cli/tui/railLayout');

const WIDE = 150; // ≥ KHY_SIDEBAR_MIN_COLS default 120
// Default width ratio 0.16 clamped into [24, 36] → round(150 * 0.16) = 24
const WIDE_RAIL = 24;
// The rail is ON by default; ON stays explicit in the active cases so each test
// still states the gate it depends on, and OFF is the escape-hatch writing.
const ON = { KHY_SIDEBAR_RAIL: '1' };
const OFF = { KHY_SIDEBAR_RAIL: '0' };
// Bottom-anchor tests below pin the top offset to 0 so they exercise the pure
// bottom-anchor relative geometry (offset=0 == the original behavior before the
// KHY_SIDEBAR_RAIL_TOP_OFFSET lift was introduced). The default (6) is covered
// separately in its own section.
const ON0 = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' };

// ── 门控 ────────────────────────────────────────────────────────────────────
test('railGateOn: 未设置 → 开(默认开,右栏是常态布局)', () => {
  assert.equal(railGateOn({}), true);
});

test('railGateOn: 四种开写法(大小写/空格无关)', () => {
  for (const v of ['1', 'true', 'on', 'yes', ' ON ', 'True']) {
    assert.equal(railGateOn({ KHY_SIDEBAR_RAIL: v }), true, `值 ${JSON.stringify(v)} 应开`);
  }
});

test('railGateOn: 只有明确的关写法才关;垃圾值不误关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.equal(railGateOn({ KHY_SIDEBAR_RAIL: v }), false, `值 ${JSON.stringify(v)} 应关`);
  }
  for (const v of ['', 'maybe', '2']) {
    assert.equal(railGateOn({ KHY_SIDEBAR_RAIL: v }), true, `值 ${JSON.stringify(v)} 不该关掉默认开`);
  }
});

test('railGateOn: KHY_SIDEBAR=0 总开关压过栏位开关', () => {
  assert.equal(railGateOn({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR: '0' }), false);
  assert.equal(railGateOn({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR: 'off' }), false);
});

test('railActive: 宽屏 → true;窄于 minCols(120) → false', () => {
  assert.equal(railActive(WIDE, ON), true);
  assert.equal(railActive(120, ON), true, '恰好等于阈值应通过');
  assert.equal(railActive(119, ON), false);
  assert.equal(railActive(80, ON), false);
});

test('railActive: 门控关时无论多宽都 false', () => {
  assert.equal(railActive(WIDE, OFF), false);
  assert.equal(railActive(300, { KHY_SIDEBAR_RAIL: 'off' }), false);
  assert.equal(railActive(300, { KHY_SIDEBAR: '0' }), false, '总开关同样压死');
});

test('railActive: 什么都不设(默认开)+ 宽屏 → true', () => {
  assert.equal(railActive(WIDE, {}), true);
});

test('railActive: 垃圾 cols(非 null)→ false;null/undefined = 尺寸未知 → 放宽门控通过', () => {
  for (const c of [0, -10, NaN, 'abc']) {
    assert.equal(railActive(c, ON), false, `cols=${String(c)} 应 false`);
  }
  // Windows PowerShell/conpty 下 out.columns 可能为 undefined:尺寸未知时
  // 按假定宽度(80)走放宽门槛(80) → 默认激活,看板不永久隐藏。
  assert.equal(railActive(undefined, ON), true);
  assert.equal(railActive(null, ON), true);
  // 放宽门槛可由 env 抬高,抬高后假定宽度不够 → false。
  assert.equal(railActive(undefined, { ...ON, KHY_SIDEBAR_MIN_COLS_FALLBACK: '100' }), false);
  // 门控关时尺寸未知也不激活。
  assert.equal(railActive(undefined, OFF), false);
});

test('railActive: 栏宽吃满整屏(env 覆写) → false,绝不给 ink 留 0 列', () => {
  // 200 列、绝对栏宽 200 → clamp 到 WIDTH_MAX 36 → 仍有余量 → true
  assert.equal(railActive(200, { ...ON, KHY_SIDEBAR_WIDTH: '200' }), true);
  // 40 列窄屏本就不过 minCols 门槛
  assert.equal(railActive(40, { ...ON, KHY_SIDEBAR_WIDTH: '40' }), false);
  // 抬高 WIDTH_MIN/MAX 让栏宽 >= cols:130 列、栏宽固定 130
  assert.equal(
    railActive(130, { ...ON, KHY_SIDEBAR_WIDTH: '130', KHY_SIDEBAR_WIDTH_MIN: '130', KHY_SIDEBAR_WIDTH_MAX: '200' }),
    false,
    'mainColumnCols 为 0 → 必须判定不激活',
  );
});

// ── contentCols:有效列宽单一真源 ────────────────────────────────────────────
test('contentCols: 栏位开 → cols - 栏宽(真实几何,不抬地板)', () => {
  assert.equal(contentCols(WIDE, ON), WIDE - WIDE_RAIL);
});

test('contentCols: 栏位关 → 原样返回真实列宽(逐字节 legacy 的入口)', () => {
  assert.equal(contentCols(WIDE, OFF), WIDE);
  assert.equal(contentCols(WIDE, { KHY_SIDEBAR_RAIL: 'no' }), WIDE);
  assert.equal(contentCols(WIDE, { ...ON, KHY_SIDEBAR: 'off' }), WIDE);
});

test('contentCols: 默认(env 空)= 开 → 与显式开同值', () => {
  assert.equal(contentCols(WIDE, {}), contentCols(WIDE, ON));
});

test('contentCols: 窄屏不收窄(与 legacy 全宽路径一致)', () => {
  assert.equal(contentCols(80, ON), 80);
  assert.equal(contentCols(119, ON), 119);
});

test('contentCols: 垃圾输入(非 null)→ 0,让调用方走自己的 || 80 回退', () => {
  for (const c of [0, -5, NaN]) {
    assert.equal(contentCols(c, ON), 0, `cols=${String(c)} 应为 0`);
    assert.equal(contentCols(c, OFF), 0, `门控关时 cols=${String(c)} 也应为 0`);
  }
});

test('contentCols: 尺寸未知(null/undefined)+ 栏位激活 → 收窄后的假定宽度', () => {
  // 假定 80 列 → 栏宽 clamp(round(80*0.16)=13 → 下界 24)= 24 → 正文 56。
  // 必须与 railGeometry 的 fallback 几何一致,否则 ink 会写进已预留的槽位。
  const { sidebarWidth, fallbackCols } = require('../../../src/cli/tui/sidebarLayout');
  const fbMain = fallbackCols(ON) - sidebarWidth(fallbackCols(ON), ON);
  assert.equal(contentCols(undefined, ON), fbMain);
  assert.equal(contentCols(null, ON), fbMain);
  // 门控关时尺寸未知 → 仍返 0(调用方 legacy 回退,与无栏行为一致)。
  assert.equal(contentCols(undefined, OFF), 0);
  assert.equal(contentCols(null, OFF), 0);
});

test('contentCols: 小数列宽向下取整', () => {
  assert.equal(contentCols(150.9, ON), WIDE - WIDE_RAIL);
  assert.equal(contentCols(150.9, OFF), WIDE);
});

test('contentCols: 收窄量恒等于 sidebarWidth,两者不会漂移', () => {
  const { sidebarWidth } = require('../../../src/cli/tui/sidebarLayout');
  for (const cols of [120, 150, 200, 300]) {
    assert.equal(contentCols(cols, ON), cols - sidebarWidth(cols, ON), `cols=${cols}`);
  }
});

// ── railGeometry ────────────────────────────────────────────────────────────
test('railGeometry: 右对齐几何,top=1,height=rows-1', () => {
  const g = railGeometry(WIDE, 40, ON);
  assert.equal(g.on, true);
  assert.equal(g.width, WIDE_RAIL);
  assert.equal(g.left, WIDE - WIDE_RAIL + 1, '左边界 = cols - width + 1(1-based)');
  assert.equal(g.top, 1, '从屏幕第一行开始 —— 这就是「与正文平齐」的含义');
  assert.equal(g.height, 39, '跳过最底行,规避 pending-wrap 滚屏');
});

test('railGeometry: 槽位右边界恰好是最后一列,不越界也不留缝', () => {
  const g = railGeometry(WIDE, 40, ON);
  assert.equal(g.left + g.width - 1, WIDE);
});

test('railGeometry: 收窄宽度 + 栏宽 = 总宽(槽位与正文严丝合缝)', () => {
  const g = railGeometry(WIDE, 40, ON);
  assert.equal(contentCols(WIDE, ON) + g.width, WIDE);
});

test('railGeometry: 门控关 / 窄屏 / rows<2 / 垃圾值 → on=false', () => {
  assert.equal(railGeometry(WIDE, 40, OFF).on, false);
  assert.equal(railGeometry(WIDE, 40, { KHY_SIDEBAR: '0' }).on, false);
  assert.equal(railGeometry(80, 40, ON).on, false);
  assert.equal(railGeometry(WIDE, 1, ON).on, false, 'rows=1 → height 会是 0');
  assert.equal(railGeometry(WIDE, 0, ON).on, false);
  assert.equal(railGeometry(NaN, 40, ON).on, false);
  assert.equal(railGeometry(WIDE, NaN, ON).on, false);
});

test('railGeometry: 尺寸未知(null/undefined)→ 按假定 80x24 出图,与 contentCols 同源', () => {
  const { sidebarWidth, fallbackCols, fallbackRows } = require('../../../src/cli/tui/sidebarLayout');
  const fbCols = fallbackCols(ON);
  const fbRows = fallbackRows(ON);
  const g = railGeometry(undefined, undefined, ON);
  assert.equal(g.on, true, '尺寸未知时看板不永久隐藏');
  assert.equal(g.width, sidebarWidth(fbCols, ON));
  assert.equal(g.left, fbCols - g.width + 1);
  assert.equal(g.height, fbRows - 1, '仍跳过最底行');
  // 收窄宽度 + 栏宽 = 假定总宽 —— 画笔与 ink 收窄不得分歧。
  assert.equal(contentCols(undefined, ON) + g.width, fbCols);
  // 放宽门槛抬高 → off;门控关 → off。
  assert.equal(railGeometry(undefined, undefined, { ...ON, KHY_SIDEBAR_MIN_COLS_FALLBACK: '100' }).on, false);
  assert.equal(railGeometry(undefined, undefined, OFF).on, false);
});

test('railGeometry: KHY_TERM_FALLBACK_COLS/ROWS 覆盖假定尺寸(单一真源可调)', () => {
  const env = { ...ON, KHY_TERM_FALLBACK_COLS: '132', KHY_TERM_FALLBACK_ROWS: '50' };
  const g = railGeometry(undefined, undefined, env);
  assert.equal(g.on, true);
  assert.equal(g.left + g.width - 1, 132, '右边界落在覆盖后的假定最后一列');
  assert.equal(g.height, 49);
});

// ── railBottomChrome:输入框下线以下的页脚行数(底边锚定的偏移量) ──────────
test('railBottomChrome: 默认底部常驻两行(权限行 + 预算行)', () => {
  assert.equal(railBottomChrome({}, {}), 2);
  assert.equal(railBottomChrome(undefined, {}), 2);
});

test('railBottomChrome: 协作行 / 主题回退行各 +1,可叠加', () => {
  assert.equal(railBottomChrome({ collabActive: true }, {}), 3);
  assert.equal(railBottomChrome({ topicInFooter: true }, {}), 3);
  assert.equal(railBottomChrome({ collabActive: true, topicInFooter: true }, {}), 4);
});

test('railBottomChrome: KHY_SIDEBAR_RAIL_BOTTOM_CHROME 覆盖基数(单一真源可调)', () => {
  assert.equal(railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '4' }), 4);
  assert.equal(railBottomChrome({ collabActive: true }, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '4' }), 5);
  assert.equal(railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '0' }), 0);
});

test('railBottomChrome: 垃圾覆盖值回退默认基数', () => {
  assert.equal(railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: 'abc' }), 2);
  assert.equal(railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '-3' }), 2);
  assert.equal(railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '' }), 2);
});

// ── railGeometry:底边锚定(任务#7,覆盖旧的顶部锚定) ──────────────────────
test('railGeometry: bottomChrome + contentRows → 看板底边=rows-chrome(输入框下线),向上生长', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 3, contentRows: 5 });
  assert.equal(g.on, true);
  assert.equal(g.width, WIDE_RAIL, '宽度口径不变');
  assert.equal(g.left, WIDE - WIDE_RAIL + 1, '左边界口径不变');
  assert.equal(g.height, 5, 'hug:高度=内容行数,不填充');
  assert.equal(g.top + g.height - 1, 40 - 3, '底边行 = rows - bottomChrome = 输入框下线所在行');
  assert.equal(g.top, 40 - 3 - 5 + 1, '顶边 = 底边 - 内容行数 + 1(从底边向上生长)');
});

test('railGeometry: 内容少 → 只占几行,底边仍贴输入框下线', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 2, contentRows: 1 });
  assert.equal(g.height, 1);
  assert.equal(g.top + g.height - 1, 38, '底边 = rows - chrome');
  assert.equal(g.top, 38, '单行看板顶=底=38');
});

test('railGeometry: 内容超过可用高度 → 截断到可用高度,底边不变', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 3, contentRows: 999 });
  const bottom = 40 - 3;
  assert.equal(g.height, bottom, '可用高度 = 底边(从第1行到底边)');
  assert.equal(g.top, 1, '顶到屏幕第一行为止,不再上溢');
  assert.equal(g.top + g.height - 1, bottom, '底边仍 = rows - chrome');
});

test('railGeometry: 底部 chrome 变化时看板整体上移,内容不变则高度不变', () => {
  const a = railGeometry(WIDE, 40, ON0, { bottomChrome: 2, contentRows: 4 });
  const b = railGeometry(WIDE, 40, ON0, { bottomChrome: 5, contentRows: 4 });
  assert.equal(a.top + a.height - 1, 38, 'chrome=2 → 底边 38');
  assert.equal(b.top + b.height - 1, 35, 'chrome=5 → 底边 35(随页脚变高上移)');
  assert.equal(a.height, b.height, '内容行数不变 → 高度不变,只是整体上移');
});

test('railGeometry: bottomChrome 但 contentRows 未测量 → 填充槽位(top=1,便于先建行)', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 3 });
  assert.equal(g.top, 1);
  assert.equal(g.height, 37, '可用高度 = rows - chrome');
});

test('railGeometry: contentRows=0 → off(空看板不预留任何行)', () => {
  assert.equal(railGeometry(WIDE, 40, ON0, { bottomChrome: 3, contentRows: 0 }).on, false);
});

test('railGeometry: chrome 过大时底边被钳到 pending-wrap 安全行(rows-1)', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 0, contentRows: 5 });
  assert.equal(g.top + g.height - 1, 39, 'chrome=0 也不写最底行(钳到 rows-1)');
});

test('railGeometry: 无 opts → 保持 legacy 顶部锚定(向后兼容,不受本次改动影响)', () => {
  const g = railGeometry(WIDE, 40, ON);
  assert.equal(g.top, 1);
  assert.equal(g.height, 39);
});

// ── railTopOffset + railGeometry:整体上移固定行数(离底部更远) ──────────────
test('railTopOffset: 默认上移 6 行(单一真源)', () => {
  assert.equal(railTopOffset({}), 6);
  assert.equal(railTopOffset(undefined), 6);
});

test('railTopOffset: KHY_SIDEBAR_RAIL_TOP_OFFSET 覆盖(非负整数生效)', () => {
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '3' }), 3);
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }), 0);
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '10' }), 10);
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '4.9' }), 4, '小数向下取整');
});

test('railTopOffset: 非法/空/负值回退默认 6', () => {
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '' }), 6);
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: '-3' }), 6);
  assert.equal(railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: 'abc' }), 6);
});

test('railGeometry: 默认 offset=6 → 相较 offset=0 底边与顶边都上移 6 行,高度不变', () => {
  const base = railGeometry(WIDE, 40, ON0, { bottomChrome: 2, contentRows: 4 });
  const lifted = railGeometry(WIDE, 40, ON, { bottomChrome: 2, contentRows: 4 });
  assert.equal(lifted.on, true);
  assert.equal(lifted.height, base.height, '内容行数不变 → 高度不变');
  assert.equal(lifted.top, base.top - 6, '顶边整体上移 6 行');
  assert.equal(lifted.top + lifted.height - 1, (base.top + base.height - 1) - 6, '底边整体上移 6 行');
  // 具体行号:底边 = rows - chrome - offset = 40 - 2 - 6 = 32。
  assert.equal(lifted.top + lifted.height - 1, 40 - 2 - 6);
});

test('railGeometry: KHY_SIDEBAR_RAIL_TOP_OFFSET=3 覆盖生效', () => {
  const env = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '3' };
  const g = railGeometry(WIDE, 40, env, { bottomChrome: 2, contentRows: 4 });
  assert.equal(g.height, 4, '高度仍由 contentRows 决定');
  assert.equal(g.top + g.height - 1, 40 - 2 - 3, '底边 = rows - chrome - offset = 35');
});

test('railGeometry: offset=0 等同原底边锚定(回归保护)', () => {
  const g = railGeometry(WIDE, 40, ON0, { bottomChrome: 2, contentRows: 4 });
  assert.equal(g.top + g.height - 1, 40 - 2, '底边 = rows - chrome(与引入 offset 前一致)');
  assert.equal(g.top, 40 - 2 - 4 + 1);
});

test('railGeometry: offset 未测量 contentRows 的填充模式也基于新底边算 avail', () => {
  const env = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '4' };
  const g = railGeometry(WIDE, 40, env, { bottomChrome: 2 });
  assert.equal(g.top, 1);
  assert.equal(g.height, 40 - 2 - 4, '可用高度 = rows - chrome - offset = 34');
});

test('railGeometry: offset 过大 → bottom 触底钳到 1,不出现负数/越界', () => {
  // rows=10, chrome=2, offset=100 → R - chrome - offset = -92 → clamp 到 1。
  const env = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '100' };
  const g = railGeometry(WIDE, 10, env, { bottomChrome: 2, contentRows: 5 });
  assert.equal(g.on, true, '优雅降级,不崩溃、不隐藏');
  assert.ok(g.top >= 1, 'top 不越界');
  assert.equal(g.top + g.height - 1, 1, '底边被钳到第 1 行');
  assert.equal(g.height, 1, '可用高度仅剩 1 行,内容截断到 1');
});

// ── bgSequence ──────────────────────────────────────────────────────────────
test('bgSequence: #hex6 → truecolor 背景(默认 #2e2e2e)', () => {
  assert.equal(bgSequence('#2e2e2e'), '\x1b[48;2;46;46;46m');
});

test('bgSequence: #hex3 展开', () => {
  assert.equal(bgSequence('#abc'), '\x1b[48;2;170;187;204m');
});

test('bgSequence: rgb() / ansi256() / 颜色名', () => {
  assert.equal(bgSequence('rgb(1,2,3)'), '\x1b[48;2;1;2;3m');
  assert.equal(bgSequence('ansi256(240)'), '\x1b[48;5;240m');
  assert.equal(bgSequence('blue'), '\x1b[44m');
  assert.equal(bgSequence('grey'), '\x1b[100m');
});

test('bgSequence: 无法映射的值 → 空串(画纯文本,绝不把垃圾写上线)', () => {
  assert.equal(bgSequence(null), '');
  assert.equal(bgSequence(''), '');
  assert.equal(bgSequence('ansi256(999)'), '');
  assert.equal(bgSequence('chartreuse'), '');
});

// ── buildRailPaint:字节级 ───────────────────────────────────────────────────
const GEOM = { on: true, width: 10, left: 141, top: 1, height: 3 };

test('buildRailPaint: 存光标开头、取光标结尾', () => {
  const s = buildRailPaint({ lines: ['a'], geom: GEOM, bg: null });
  assert.ok(s.startsWith(DECSC), '必须以 DECSC(\\x1b7) 开头');
  assert.ok(s.endsWith(DECRC), '必须以 DECRC(\\x1b8) 结尾');
  assert.equal(DECSC, '\x1b7');
  assert.equal(DECRC, '\x1b8');
});

test('buildRailPaint: 绝对不含 \\n 或 \\r —— 一个换行就会滚屏并打乱 ink 的行计数', () => {
  const s = buildRailPaint({
    lines: ['含\n换行', '含\r回车', 'ok'],
    geom: GEOM,
    bg: '#2e2e2e',
    fit: (t, w) => String(t).replace(/[\r\n]/g, ' ').slice(0, w).padEnd(w, ' '),
  });
  assert.ok(!s.includes('\n'), '不得含 \\n');
  assert.ok(!s.includes('\r'), '不得含 \\r');
});

test('buildRailPaint: 每行一条 CSI row;left H,行号从 top 递增,列恒为 left', () => {
  const s = buildRailPaint({ lines: [], geom: GEOM, bg: null });
  const cups = s.match(/\x1b\[\d+;\d+H/g) || [];
  assert.deepEqual(cups, ['\x1b[1;141H', '\x1b[2;141H', '\x1b[3;141H']);
});

test('buildRailPaint: 超出内容的行也画满空白,旧内容不会残留在下面', () => {
  const s = buildRailPaint({ lines: ['x'], geom: GEOM, bg: null });
  const rows = s.slice(DECSC.length, -DECRC.length).split(/\x1b\[\d+;\d+H/).filter(Boolean);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], 'x' + ' '.repeat(9));
  assert.equal(rows[1], ' '.repeat(10));
  assert.equal(rows[2], ' '.repeat(10));
});

test('buildRailPaint: 每行文本恰好 width 列(fit 注入生效)', () => {
  const s = buildRailPaint({ lines: ['ab', 'abcdefghijklmno'], geom: GEOM, bg: null });
  const rows = s.slice(DECSC.length, -DECRC.length).split(/\x1b\[\d+;\d+H/).filter(Boolean);
  for (const r of rows) assert.equal(r.length, GEOM.width, `行 ${JSON.stringify(r)} 应为 ${GEOM.width} 列`);
});

test('buildRailPaint: 带背景时每行 bg SGR 在前、reset 在后', () => {
  const s = buildRailPaint({ lines: ['a'], geom: GEOM, bg: '#2e2e2e' });
  const bg = '\x1b[48;2;46;46;46m';
  assert.equal((s.match(new RegExp(bg.replace(/[[\]\\]/g, '\\$&'), 'g')) || []).length, 3);
  assert.equal((s.match(/\x1b\[0m/g) || []).length, 3);
  assert.ok(s.indexOf(bg) < s.indexOf('\x1b[0m'), 'bg 必须在 reset 之前');
});

test('buildRailPaint: 无背景时不发任何 SGR', () => {
  const s = buildRailPaint({ lines: ['a'], geom: GEOM, bg: null });
  assert.ok(!s.includes('\x1b[0m'));
  assert.ok(!s.includes('48;2;'));
});

test('buildRailPaint: 接受 {text} 对象行(SidebarPanel.buildSidebarLines 的形状)', () => {
  const s = buildRailPaint({ lines: [{ text: 'hi' }], geom: GEOM, bg: null });
  assert.ok(s.includes('hi' + ' '.repeat(8)));
});

test('buildRailPaint: geom 未激活 / 尺寸为 0 → 空串', () => {
  assert.equal(buildRailPaint({ lines: ['a'], geom: { ...GEOM, on: false } }), '');
  assert.equal(buildRailPaint({ lines: ['a'], geom: { ...GEOM, height: 0 } }), '');
  assert.equal(buildRailPaint({ lines: ['a'], geom: { ...GEOM, width: 0 } }), '');
  assert.equal(buildRailPaint({ lines: ['a'] }), '');
  assert.equal(buildRailPaint(), '');
});

test('buildRailPaint: 病态窄栏 width=1 + 边框启用时,单行可见宽度绝不超过 geom.width(不溢出)', () => {
  const narrow = { on: true, width: 1, left: 200, top: 1, height: 2 };
  const reqWidths = [];
  // Realistic fitter: pad/truncate to EXACTLY the requested width (SidebarPanel口径).
  const fit = (t, w) => {
    reqWidths.push(w);
    const str = String(t == null ? '' : t);
    return str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
  };
  const s = buildRailPaint({ lines: ['content'], geom: narrow, bg: null, border: '|', borderCols: 1, fit });
  const rows = s.slice(DECSC.length, -DECRC.length).split(/\x1b\[\d+;\d+H/).filter(Boolean);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    const visible = r.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(visible.length <= narrow.width, `行 ${JSON.stringify(r)} 宽 ${visible.length} 应 <= ${narrow.width}`);
  }
  // 内容宽度 = max(0, width - borderCols) = 0,否则 边框(1列) + 内容(>=1列) 会溢出 1 列的栏。
  for (const w of reqWidths) assert.equal(w, 0, '内容宽度必须为 0');
});

test('buildRailPaint: borderCols 越界(> geom.width)被夹紧,内容宽度不为负、不溢出', () => {
  const narrow = { on: true, width: 1, left: 200, top: 1, height: 1 };
  const reqWidths = [];
  const fit = (t, w) => { reqWidths.push(w); return ' '.repeat(Math.max(0, w)); };
  // borderCols 报 3(> width=1)必须被夹紧到 1 → 内容宽度 = max(0, 1-1) = 0。
  buildRailPaint({ lines: ['x'], geom: narrow, bg: null, border: '|', borderCols: 3, fit });
  for (const w of reqWidths) assert.equal(w, 0, '越界 borderCols 夹紧后内容宽度必须为 0');
});

// ── buildRailClear ──────────────────────────────────────────────────────────
test('buildRailClear: 只有定位 + 空格,不带背景色', () => {
  const s = buildRailClear(GEOM);
  assert.ok(s.startsWith(DECSC) && s.endsWith(DECRC));
  assert.ok(!s.includes('48;2;'), '清空必须把单元格还给终端默认背景');
  assert.ok(!s.includes('\n') && !s.includes('\r'));
  const rows = s.slice(DECSC.length, -DECRC.length).split(/\x1b\[\d+;\d+H/).filter(Boolean);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r, ' '.repeat(GEOM.width));
});

test('buildRailClear: 未激活几何 → 空串(幂等调用不会乱发字节)', () => {
  assert.equal(buildRailClear({ ...GEOM, on: false }), '');
  assert.equal(buildRailClear(null), '');
  assert.equal(buildRailClear(), '');
});

test('buildRailClear: 可用于清理「旧」几何(resize 变窄场景)', () => {
  const stale = { on: true, width: 40, left: 111, top: 1, height: 2 };
  const s = buildRailClear(stale);
  assert.ok(s.includes('\x1b[1;111H' + ' '.repeat(40)));
  assert.ok(s.includes('\x1b[2;111H' + ' '.repeat(40)));
});

// ── 互斥不变量(看板抖动/重影根因 A)：收窄 ⇔ 画笔激活，同输入永不分歧 ──
test('不变量: contentCols 收窄 ⇔ railGeometry.on(同一对输入，任意帧互斥)', () => {
  const { fallbackCols } = require('../../../src/cli/tui/sidebarLayout');
  const ROWS = 40;
  const cases = [200, 150, 120, 119, 80, 0, -5, NaN, null, undefined];
  for (const env of [ON, OFF, {}]) {
    for (const cols of cases) {
      const cc = contentCols(cols, env);
      const real = Number(cols);
      // 「收窄」= 有效列宽为正且小于本帧基准宽度(尺寸未知时基准为假定宽度)。
      const base = (Number.isFinite(real) && real > 0)
        ? Math.floor(real)
        : ((cols == null) ? fallbackCols(env) : 0);
      const narrowed = cc > 0 && base > 0 && cc < base;
      const g = railGeometry(cols, ROWS, env);
      assert.equal(narrowed, g.on,
        `cols=${String(cols)} env=${JSON.stringify(env)}: 树内收窄(${narrowed}) 必须等于画笔激活(${g.on})`);
    }
  }
});

test('不变量: rows 未知(undefined)时与 cols 同源 fallback，互斥关系仍成立', () => {
  const g = railGeometry(150, undefined, ON);
  assert.equal(g.on, true, 'rows 未知 → 假定 24 行 → 仍激活');
  assert.equal(contentCols(150, ON) + g.width, 150, '收窄量与栏宽严丝合缝');
});

// ── 阶段二: railActiveHysteresis 方向性 ──────────────────────────────────────
const { railActiveHysteresis, hysteresisCols } = require('../../../src/cli/tui/sidebarLayout');

test('railActiveHysteresis: 118 列 + wasActive=true → 保持激活(在死区内)', () => {
  // default hysteresis=2, minCols=120 → deactivate threshold=118
  assert.equal(railActiveHysteresis(118, true, ON), true, '边界值 118 ≥ 120-2');
  assert.equal(railActiveHysteresis(119, true, ON), true, '119 ≥ 118');
  assert.equal(railActiveHysteresis(120, true, ON), true, '120 ≥ 118');
});

test('railActiveHysteresis: 117 列 + wasActive=true → 失活(跌出死区)', () => {
  assert.equal(railActiveHysteresis(117, true, ON), false, '117 < 118');
});

test('railActiveHysteresis: wasActive=false 时需 ≥ minCols 才激活', () => {
  assert.equal(railActiveHysteresis(120, false, ON), true, '120 ≥ 120');
  assert.equal(railActiveHysteresis(119, false, ON), false, '119 < 120');
  assert.equal(railActiveHysteresis(118, false, ON), false, '118 < 120');
});

test('railActiveHysteresis: hysteresis=0 退化为无死区(byte-identical to plain gate)', () => {
  const env0 = { ...ON, KHY_SIDEBAR_HYSTERESIS: '0' };
  assert.equal(railActiveHysteresis(120, true, env0), true);
  assert.equal(railActiveHysteresis(119, true, env0), false, '无死区:119 < 120 即失活');
  assert.equal(railActiveHysteresis(120, false, env0), true);
  assert.equal(railActiveHysteresis(119, false, env0), false);
});

test('railActiveHysteresis: 荒谬迟滞值(9999)在低列数仍能关闭,不会永久锁定 ON', () => {
  const E = { ...ON, KHY_SIDEBAR_HYSTERESIS: '9999' };
  // 未夹紧时退出阈值 = minCols - 9999 为负,任何正列数都保持 ON(永久锁死)。
  // 夹紧后退出阈值下探至多到放宽下限 minColsFallback(80),低列数必须失活。
  assert.equal(railActiveHysteresis(1, true, E), false, '1 列必须关闭');
  assert.equal(railActiveHysteresis(50, true, E), false, '50 列必须关闭');
  assert.equal(railActiveHysteresis(79, true, E), false, '79 < 80 必须关闭');
  assert.equal(railActiveHysteresis(80, true, E), true, '80 = 放宽下限,保持激活');
});

test('railActiveHysteresis: cols=null (unknown) → 放宽门控(忽略 wasActive)', () => {
  assert.equal(railActiveHysteresis(null, false, ON), true, 'unknown + 默认 → 激活');
  assert.equal(railActiveHysteresis(null, true, ON), true);
  assert.equal(railActiveHysteresis(undefined, false, ON), true);
});

// ── 阶段二: railActive 第三参迟滞转发 ──────────────────────────────────────
test('railActive: 第三参 lastActive=true → 走迟滞(118 列保持激活)', () => {
  assert.equal(railActive(118, ON, true), true, '迟滞:118 在死区内保持激活');
  assert.equal(railActive(117, ON, true), false, '迟滞:117 跌出死区失活');
});

test('railActive: 第三参 lastActive=false → 无死区优惠(119 不激活)', () => {
  assert.equal(railActive(119, ON, false), false, '119 < 120 → 不激活');
  assert.equal(railActive(120, ON, false), true, '120 ≥ 120 → 激活');
});

test('railActive: 第三参 undefined(省略) → 无迟滞,兼容旧行为', () => {
  assert.equal(railActive(119, ON), false, '119 不激活');
  assert.equal(railActive(120, ON), true, '120 激活');
});

// ── 阶段二: railGeometry 小终端退化(avail<3 offset 退化) ────────────────────
test('railGeometry: 小终端退化(rows=9, chrome=4, offset=6 → avail<3 → offset 退化)', () => {
  // rows=9, chrome=4 → bottom=max(1,min(8, 9-4-6))=max(1,min(8,-1))=1 → avail=1 < 3
  // 退化条件: topOffset(6) <= R - chrome(5) → 6<=5 false → no decay!
  // Let's use offset=3 instead: rows=9, chrome=4, offset=3 → bottom=max(1,min(8,9-4-3))=2 → avail=2 < 3
  // 退化条件: offset(3) <= R - chrome(5) → 3<=5 true → decay!
  const envSmall = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '3' };
  const g = railGeometry(150, 9, envSmall, { bottomChrome: 4 });
  assert.equal(g.on, true);
  assert.ok(g.height >= 3, `退化后 height(${g.height}) ≥ 3`);
});

test('railGeometry: 正常大终端不退化(40 行 chrome=2 offset=6 → avail=32)', () => {
  const g = railGeometry(150, 40, { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '6' }, { bottomChrome: 2 });
  assert.equal(g.on, true);
  assert.equal(g.height, 32, 'avail = 40-2-6 = 32,未触发退化');
});

test('railGeometry: 病态大 offset 仍 clamp-to-1(topOffset > R-chrome)', () => {
  // rows=40 chrome=2 offset=50 → bottom=max(1,min(39,40-2-50))=max(1,-12)=1 → avail=1
  // 退化条件: offset(50) <= R-chrome(38) → false → 不退化
  const envBig = { ...ON, KHY_SIDEBAR_RAIL_TOP_OFFSET: '50' };
  const g = railGeometry(150, 40, envBig, { bottomChrome: 2 });
  assert.equal(g.on, true);
  assert.ok(g.height >= 1, '至少 1 行(clamped to bottom=1)');
});

// ── 阶段三: buildRailPaint 边框列预算 ──────────────────────────────────────
test('buildRailPaint: border 开启时每行可见宽 = width(border+content)', () => {
  const geom = { on: true, width: 24, left: 127, top: 1, height: 3 };
  const lines = [{ text: 'hello' }, { text: 'world' }, { text: '' }];
  const borderStr = '│'; // 1 visible column
  const bytes = buildRailPaint({ lines, geom, border: borderStr, borderCols: 1 });
  // Each row should start with CUP, optionally bg, then the border char, then content
  assert.ok(bytes.includes('│'), '边框字符应出现在输出中');
  // Check that DECSC/DECRC wraps
  assert.ok(bytes.startsWith(DECSC));
  assert.ok(bytes.endsWith(DECRC));
});

test('buildRailPaint: border 关闭(无 border/borderCols=0) → 与旧实现逐字节等价', () => {
  const geom = { on: true, width: 10, left: 41, top: 1, height: 2 };
  const lines = [{ text: 'ab' }, { text: 'cd' }];
  const withBorder = buildRailPaint({ lines, geom, border: '', borderCols: 0 });
  const noBorder = buildRailPaint({ lines, geom });
  assert.equal(withBorder, noBorder, '无边框时输出应完全相同');
});
