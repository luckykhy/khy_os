'use strict';

// Unit tests for the sidebarLayout pure leaf — fullscreen-gated sidebar
// (session-max heuristic), relative width, and relative stable height.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const {
  sidebarWidth, shouldShowSidebar, sidebarBg, isWideTerminal,
  isFullscreen, minCols, minRows, fallbackCols, fallbackRows, minColsFallback,
  sidebarStableRows, sidebarFillRows,
  mainColumnCols, classifyResize, stickyDim, nextSessionMax,
} = require('../../../src/cli/tui/sidebarLayout');

// ── isFullscreen: 会话内最大尺寸法 ─────────────────────────────────────────
test('isFullscreen: 当前=会话最大 → true', () => {
  assert.equal(isFullscreen(150, 40, 150, 40, {}), true);
});

test('isFullscreen: 容差内(默认 tol=2)缩小 → true', () => {
  assert.equal(isFullscreen(148, 38, 150, 40, {}), true);
  assert.equal(isFullscreen(149, 40, 150, 40, {}), true);
});

test('isFullscreen: 缩小超容差 → false', () => {
  assert.equal(isFullscreen(147, 40, 150, 40, {}), false, 'cols 差 3 > tol 2');
  assert.equal(isFullscreen(150, 37, 150, 40, {}), false, 'rows 差 3 > tol 2');
});

test('isFullscreen: 低于 minCols 地板(120) → false,即使等于自身最大', () => {
  assert.equal(isFullscreen(119, 40, 119, 40, {}), false);
  assert.equal(isFullscreen(100, 40, 100, 40, {}), false);
});

test('isFullscreen: 低于 minRows 地板(24) → false,即使等于自身最大', () => {
  assert.equal(isFullscreen(150, 23, 150, 23, {}), false);
  assert.equal(isFullscreen(150, 10, 150, 10, {}), false);
});

test('isFullscreen: 地板边界(120 列 / 24 行)恰好达到 → true', () => {
  assert.equal(isFullscreen(120, 24, 120, 24, {}), true);
});

test('isFullscreen: KHY_SIDEBAR_FULLSCREEN_TOL 自定义容差生效', () => {
  const env = { KHY_SIDEBAR_FULLSCREEN_TOL: '0' };
  assert.equal(isFullscreen(150, 40, 150, 40, env), true, 'tol=0 等于最大 → true');
  assert.equal(isFullscreen(149, 40, 150, 40, env), false, 'tol=0 少 1 列 → false');
  const env5 = { KHY_SIDEBAR_FULLSCREEN_TOL: '5' };
  assert.equal(isFullscreen(145, 35, 150, 40, env5), true, 'tol=5 差 5 → true');
});

test('isFullscreen: 容差非法值回退默认 2', () => {
  for (const v of ['abc', '-1', '']) {
    assert.equal(isFullscreen(148, 38, 150, 40, { KHY_SIDEBAR_FULLSCREEN_TOL: v }), true, `value ${v}`);
    assert.equal(isFullscreen(147, 40, 150, 40, { KHY_SIDEBAR_FULLSCREEN_TOL: v }), false, `value ${v}`);
  }
});

test('isFullscreen: KHY_SIDEBAR_MIN_ROWS 覆盖行地板', () => {
  const env = { KHY_SIDEBAR_MIN_ROWS: '30' };
  assert.equal(isFullscreen(150, 29, 150, 29, env), false, '29 行 < 地板 30');
  assert.equal(isFullscreen(150, 30, 150, 30, env), true, '30 行 → true');
});

test('isFullscreen: 任一参数非法 → false', () => {
  assert.equal(isFullscreen(NaN, 40, 150, 40, {}), false);
  assert.equal(isFullscreen(150, undefined, 150, 40, {}), false);
  assert.equal(isFullscreen(150, 40, null, 40, {}), false);
  assert.equal(isFullscreen(150, 40, 150, NaN, {}), false);
});

// ── minRows: 行地板解析 ─────────────────────────────────────────────────────
test('minRows: 默认 24;非法回退 24', () => {
  assert.equal(minRows({}), 24);
  for (const v of ['abc', '-5', '0', '']) {
    assert.equal(minRows({ KHY_SIDEBAR_MIN_ROWS: v }), 24, `value ${v}`);
  }
  assert.equal(minRows({ KHY_SIDEBAR_MIN_ROWS: '30' }), 30);
});

// ── shouldShowSidebar: 只在全屏(会话最大)时显示 ────────────────────────────
test('shouldShowSidebar: 全屏(当前=会话最大且过地板) → true', () => {
  assert.equal(shouldShowSidebar(150, 40, 150, 40, {}), true);
});

test('shouldShowSidebar: 非全屏(缩小超容差) → false', () => {
  assert.equal(shouldShowSidebar(150, 40, 200, 50, {}), false);
});

test('shouldShowSidebar: 窄/矮终端(低于地板) → false,即使等于自身最大', () => {
  assert.equal(shouldShowSidebar(100, 40, 100, 40, {}), false, '窄');
  assert.equal(shouldShowSidebar(150, 20, 150, 20, {}), false, '矮');
});

test('shouldShowSidebar: KHY_SIDEBAR 各关闭写法 → false(即使全屏)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.equal(shouldShowSidebar(200, 50, 200, 50, { KHY_SIDEBAR: v }), false, `value ${v}`);
  }
});

test('shouldShowSidebar: KHY_SIDEBAR 其他值 → 保持默认开', () => {
  for (const v of ['', '1', 'on', 'yes', 'anything']) {
    assert.equal(shouldShowSidebar(200, 50, 200, 50, { KHY_SIDEBAR: v }), true, `value ${v}`);
  }
});

test('shouldShowSidebar: 参数非法 → false', () => {
  assert.equal(shouldShowSidebar(NaN, 40, 150, 40, {}), false);
  assert.equal(shouldShowSidebar(undefined, undefined, undefined, undefined, {}), false);
});

// ── sidebarWidth: 相对宽度 round(cols*ratio) + clamp ───────────────────────
test('sidebarWidth: 默认比例 0.16,round(cols*0.16) (变窄,原 0.20)', () => {
  assert.equal(sidebarWidth(200, {}), 32, '200*0.16=32');
  assert.equal(sidebarWidth(150, {}), 24, '150*0.16=24');
  assert.equal(sidebarWidth(120, {}), 24, 'round(19.2)=19 → clamp 24');
});

test('sidebarWidth: clamp 下界 24 / 上界 36(默认,原上界 48)', () => {
  assert.equal(sidebarWidth(80, {}), 24, 'round(12.8)=13 → clamp 24');
  assert.equal(sidebarWidth(300, {}), 36, '48 → clamp 36');
});

test('sidebarWidth: KHY_SIDEBAR_WIDTH_RATIO 自定义比例生效', () => {
  assert.equal(sidebarWidth(100, { KHY_SIDEBAR_WIDTH_RATIO: '0.5' }), 36, '50 → 新默认上界 36 钳制');
  assert.equal(sidebarWidth(60, { KHY_SIDEBAR_WIDTH_RATIO: '0.5' }), 30, '60*0.5=30 未触钳');
  assert.equal(sidebarWidth(120, { KHY_SIDEBAR_WIDTH_RATIO: '0.25' }), 30);
});

test('sidebarWidth: 比例非法(含 ≥1)回退默认 0.16', () => {
  for (const v of ['abc', '-1', '0', '1', '1.5', '']) {
    assert.equal(sidebarWidth(200, { KHY_SIDEBAR_WIDTH_RATIO: v }), 32, `value ${v}`);
  }
});

test('sidebarWidth: 旧 KHY_SIDEBAR_WIDTH 显式绝对值优先于比例(clamp)', () => {
  assert.equal(sidebarWidth(300, { KHY_SIDEBAR_WIDTH: '30' }), 30, '绝对值无视 cols');
  assert.equal(sidebarWidth(300, { KHY_SIDEBAR_WIDTH: '10' }), 24, 'clamp 下界 24');
  assert.equal(sidebarWidth(300, { KHY_SIDEBAR_WIDTH: '99' }), 36, 'clamp 上界 36');
});

test('sidebarWidth: 绝对值非法/未设置 → 走比例路径(相对为默认首选)', () => {
  for (const v of ['abc', '', '-3', '0', 'NaN']) {
    assert.equal(sidebarWidth(200, { KHY_SIDEBAR_WIDTH: v }), 32, `value ${v}`);
  }
  // env 完全未设置 KHY_SIDEBAR_WIDTH 时绝不抢占相对模式。
  assert.equal(sidebarWidth(200, {}), 32);
});

test('sidebarWidth: 自定义 clamp 界 KHY_SIDEBAR_WIDTH_MIN/MAX 生效', () => {
  const env = { KHY_SIDEBAR_WIDTH_MIN: '30', KHY_SIDEBAR_WIDTH_MAX: '40' };
  assert.equal(sidebarWidth(80, env), 30, '22 → clamp 30');
  assert.equal(sidebarWidth(300, env), 40, '84 → clamp 40');
});

test('sidebarWidth: clamp 界倒置/非法 → 回退默认 24/36', () => {
  const inverted = { KHY_SIDEBAR_WIDTH_MIN: '50', KHY_SIDEBAR_WIDTH_MAX: '30' };
  assert.equal(sidebarWidth(80, inverted), 24);
  const bad = { KHY_SIDEBAR_WIDTH_MIN: 'abc', KHY_SIDEBAR_WIDTH_MAX: '-1' };
  assert.equal(sidebarWidth(300, bad), 36);
});

test('sidebarWidth: cols 非法 → 回退旧默认 30(clamp 后)', () => {
  for (const v of [NaN, undefined, null, 0, -5]) {
    assert.equal(sidebarWidth(v, {}), 30, `cols ${v}`);
  }
});

// ── sidebarStableRows: 相对稳定高度(既是下限也是上限,任务#20) ───────────
test('sidebarStableRows: 默认 min(round(rows*0.85), rows-10) (任务#22 加高)', () => {
  assert.equal(sidebarStableRows(50, {}), 40, 'round(42.5)=43 → minChrome 钳到 40');
  assert.equal(sidebarStableRows(40, {}), 30, 'round(34)=34 → 钳到 30');
  assert.equal(sidebarStableRows(30, {}), 20, 'round(25.5)=26 → 钳到 20');
  assert.equal(sidebarStableRows(24, {}), 14, '20 → 钳到 14');
  assert.equal(sidebarStableRows(60, {}), 50, 'round(51)=51 → 钳到 50');
});

test('sidebarStableRows: 小 rows(rows-minChrome≤0) → 硬下限 1 行', () => {
  assert.equal(sidebarStableRows(10, {}), 1);
  assert.equal(sidebarStableRows(5, {}), 1);
});

test('sidebarStableRows: rows 非法 → 0(禁用稳定高度,回退 hug)', () => {
  for (const v of [NaN, undefined, null, 0, -5]) {
    assert.equal(sidebarStableRows(v, {}), 0, `rows ${v}`);
  }
});

test('sidebarStableRows: KHY_SIDEBAR_MAX_RATIO 关闭写法 → 0(禁用,回退 hug)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MAX_RATIO: v }), 0, `value ${v}`);
  }
});

test('sidebarStableRows: 自定义比例生效', () => {
  assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MAX_RATIO: '0.5' }), 20);
  assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MAX_RATIO: '1' }), 30, 'ratio=1 → 钳到 rows-10');
});

test('sidebarStableRows: 比例非法(>1/负/文本)回退默认 0.85', () => {
  for (const v of ['abc', '1.5', '-0.5', '']) {
    assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MAX_RATIO: v }), 30, `value ${v}`);
  }
});

test('sidebarStableRows: KHY_SIDEBAR_MIN_CHROME 自定义结构下界生效', () => {
  assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MIN_CHROME: '20' }), 20, '34 → 钳到 40-20');
  assert.equal(sidebarStableRows(40, { KHY_SIDEBAR_MIN_CHROME: 'abc' }), 30, '非法回退 10');
});

test('sidebarStableRows: 稳定高+chrome 恒 ≤ rows(结构安全,不触发全屏重绘)', () => {
  for (const rows of [24, 30, 40, 50, 60, 80]) {
    const stable = sidebarStableRows(rows, {});
    assert.ok(stable + 10 <= rows, `rows=${rows}: stable ${stable} + chrome 10 ≤ ${rows}`);
  }
});

test('sidebarStableRows: 稳定高只由 rows 决定,与左列内容多寡无关(纯函数)', () => {
  // Same rows → same value, deterministically — the model-output volume is
  // simply not an input, so streaming can never collapse the sidebar.
  assert.equal(sidebarStableRows(50, {}), sidebarStableRows(50, {}));
  assert.equal(sidebarStableRows(50, {}), 40);
});

// ── sidebarFillRows: 填满高度(任务#8,发消息后看板顶贴消息区、底贴输入框拉满中间区域) ─
test('sidebarFillRows: 默认 rows - minChrome(10),无比例上限(默认即填满)', () => {
  assert.equal(sidebarFillRows(50, {}), 40, '50-10=40');
  assert.equal(sidebarFillRows(40, {}), 30, '40-10=30');
  assert.equal(sidebarFillRows(24, {}), 14, '24-10=14');
});

test('sidebarFillRows: 小终端(rows-minChrome≤0) → 硬下限 1 行', () => {
  assert.equal(sidebarFillRows(10, {}), 1);
  assert.equal(sidebarFillRows(5, {}), 1);
});

test('sidebarFillRows: rows 非法 → 0', () => {
  for (const v of [NaN, undefined, null, 0, -5, 'abc']) {
    assert.equal(sidebarFillRows(v, {}), 0, `rows ${v}`);
  }
});

test('sidebarFillRows: KHY_SIDEBAR_MIN_CHROME 覆盖结构下界生效', () => {
  assert.equal(sidebarFillRows(40, { KHY_SIDEBAR_MIN_CHROME: '20' }), 20, '40-20=20');
  assert.equal(sidebarFillRows(40, { KHY_SIDEBAR_MIN_CHROME: 'abc' }), 30, '非法回退 10');
});

test('sidebarFillRows: KHY_SIDEBAR_STACK_MAX_RATIO 显式设置才施加上限保护(可选)', () => {
  assert.equal(sidebarFillRows(50, { KHY_SIDEBAR_STACK_MAX_RATIO: '0.2' }), 10, 'round(10)=10 < fill 40');
  assert.equal(sidebarFillRows(50, { KHY_SIDEBAR_STACK_MAX_RATIO: '0.8' }), 40, 'round(40)=40 = fill 40');
  assert.equal(sidebarFillRows(50, { KHY_SIDEBAR_STACK_MAX_RATIO: '1' }), 40, 'ratio=1 → 仍受 fill 钳制');
});

test('sidebarFillRows: 比例非法(>1/负/文本/空/0) → 无上限(默认行为=填满)', () => {
  for (const v of ['abc', '1.5', '-0.5', '', '0']) {
    assert.equal(sidebarFillRows(50, { KHY_SIDEBAR_STACK_MAX_RATIO: v }), 40, `value ${v}`);
  }
});

test('sidebarFillRows: fill + chrome 恒 ≤ rows(结构安全,防 scroll-jump)', () => {
  for (const rows of [24, 30, 40, 50, 60, 80]) {
    const fill = sidebarFillRows(rows, {});
    assert.ok(fill + 10 <= rows, `rows=${rows}: fill ${fill} + chrome 10 ≤ ${rows}`);
  }
});

test('sidebarFillRows: 恒 ≥ sidebarStableRows(填满高 ≥ 启动稳定高,看板只增不减)', () => {
  for (const rows of [24, 30, 40, 50, 60, 80]) {
    const stable = sidebarStableRows(rows, {});
    const fill = sidebarFillRows(rows, {});
    assert.ok(fill >= stable, `rows=${rows}: fill ${fill} ≥ stable ${stable}`);
  }
});

// ── mainColumnCols: 左列可用宽度(任务#12/#16,流式换行预算按真实剩余宽) ─────
test('mainColumnCols: 默认 = cols - sidebarWidth(与看板宽单源不漂移)', () => {
  for (const cols of [120, 150, 200, 300]) {
    assert.equal(mainColumnCols(cols, {}), cols - sidebarWidth(cols, {}), `cols=${cols}`);
  }
});

test('mainColumnCols: 恒 < cols(看板占位后左列必变窄)', () => {
  for (const cols of [120, 150, 200]) {
    assert.ok(mainColumnCols(cols, {}) < cols, `cols=${cols}`);
  }
});

test('mainColumnCols: 恒 ≤ 真实剩余宽,绝不高估(任务#16 Major 修复)', () => {
  // 旧实现 max(20, raw) 在窄屏会把 12/16 抬到 20 —— contentWidth 超过物理剩余宽,
  // 视觉行数被低估 → live 区超高 → staircase/全屏重绘。现在只返回真实几何。
  // KHY_SIDEBAR_WIDTH 绝对宽 36(上限钉满)，cols=48 → 真实剩余 48-36=12。
  assert.equal(mainColumnCols(48, { KHY_SIDEBAR_WIDTH: '36' }), 12);
  // 评审极端例:cols=40 + KHY_SIDEBAR_MIN_COLS=40 → sidebarWidth(40)=24(下限钳) → 剩余 16。
  const env40 = { KHY_SIDEBAR_MIN_COLS: '40' };
  assert.equal(mainColumnCols(40, env40), 40 - sidebarWidth(40, env40));
  assert.equal(mainColumnCols(40, env40), 16);
  assert.ok(mainColumnCols(40, env40) <= 40 - sidebarWidth(40, env40), '不得超真实剩余宽');
});

test('mainColumnCols: 看板宽 ≥ cols → 0(回退全宽 legacy,不给 clamp 坏几何)', () => {
  // 极端配置:绝对看板宽吃掉或超过全部列 → 左列无可用宽度,必须返 0。
  assert.equal(mainColumnCols(24, { KHY_SIDEBAR_WIDTH: '24' }), 0);
  assert.equal(mainColumnCols(20, { KHY_SIDEBAR_WIDTH: '48' }), 0);
});

test('mainColumnCols: cols 非法 → 0(调用方回退全宽 legacy 路径)', () => {
  for (const v of [NaN, undefined, null, 0, -5, 'abc']) {
    assert.equal(mainColumnCols(v, {}), 0, `cols ${v}`);
  }
});

test('mainColumnCols: 左列 + 看板 = cols(无重叠无缝隙,典型尺寸)', () => {
  for (const cols of [120, 150, 200, 240]) {
    assert.equal(mainColumnCols(cols, {}) + sidebarWidth(cols, {}), cols, `cols=${cols}`);
  }
});

// ── isWideTerminal: 宽屏门控(本次不改,仍 ≥minCols)─────────────────────────
test('isWideTerminal: 默认阈值 120 的边界(119/120/121)', () => {
  assert.equal(isWideTerminal(119, {}), false);
  assert.equal(isWideTerminal(120, {}), true);
  assert.equal(isWideTerminal(121, {}), true);
});

test('isWideTerminal: KHY_SIDEBAR_MIN_COLS 覆盖阈值(与侧栏同源)', () => {
  assert.equal(isWideTerminal(99, { KHY_SIDEBAR_MIN_COLS: '100' }), false);
  assert.equal(isWideTerminal(100, { KHY_SIDEBAR_MIN_COLS: '100' }), true);
});

test('isWideTerminal: 阈值非法值回退 120', () => {
  for (const v of ['abc', '-5', '0', '']) {
    assert.equal(isWideTerminal(119, { KHY_SIDEBAR_MIN_COLS: v }), false, `value ${v}`);
    assert.equal(isWideTerminal(120, { KHY_SIDEBAR_MIN_COLS: v }), true, `value ${v}`);
  }
});

test('isWideTerminal: cols 非法(非 null)→ false;null/undefined = 尺寸未知 → 走放宽门控', () => {
  assert.equal(isWideTerminal(NaN, {}), false, '垃圾值仍严格拒绝');
  // Windows PowerShell/conpty 下 process.stdout.columns 可能为 undefined:
  // 尺寸未知时用假定宽度(80)对比放宽门槛(80) → 默认通过,看板不永久隐藏。
  assert.equal(isWideTerminal(undefined, {}), true);
  assert.equal(isWideTerminal(null, {}), true);
});

test('isWideTerminal: 尺寸未知时 KHY_SIDEBAR_MIN_COLS_FALLBACK 抬高门槛 → false', () => {
  assert.equal(isWideTerminal(null, { KHY_SIDEBAR_MIN_COLS_FALLBACK: '100' }), false, '80 < 100');
  assert.equal(isWideTerminal(null, { KHY_TERM_FALLBACK_COLS: '120', KHY_SIDEBAR_MIN_COLS_FALLBACK: '100' }), true, '假定宽度抬到 120 ≥ 100');
});

test('fallbackCols/fallbackRows: 默认 80/24;env 覆盖;非法回退默认', () => {
  assert.equal(fallbackCols({}), 80);
  assert.equal(fallbackRows({}), 24);
  assert.equal(fallbackCols({ KHY_TERM_FALLBACK_COLS: '132' }), 132);
  assert.equal(fallbackRows({ KHY_TERM_FALLBACK_ROWS: '50' }), 50);
  for (const v of ['abc', '-1', '0', '']) {
    assert.equal(fallbackCols({ KHY_TERM_FALLBACK_COLS: v }), 80, `cols value ${v}`);
    assert.equal(fallbackRows({ KHY_TERM_FALLBACK_ROWS: v }), 24, `rows value ${v}`);
  }
});

test('minColsFallback: 默认 80;env 覆盖;非法回退 80', () => {
  assert.equal(minColsFallback({}), 80);
  assert.equal(minColsFallback({ KHY_SIDEBAR_MIN_COLS_FALLBACK: '96' }), 96);
  assert.equal(minColsFallback({ KHY_SIDEBAR_MIN_COLS_FALLBACK: 'abc' }), 80);
});

test('isFullscreen: 尺寸未知(null/undefined)→ 用假定 80x24 + 放宽门槛判定', () => {
  // 首帧即可显示:假定 80x24 与会话最大 80x24 容差内,80 ≥ 放宽门槛 80。
  assert.equal(isFullscreen(null, null, 80, 24, {}), true);
  assert.equal(isFullscreen(undefined, undefined, 80, 24, {}), true);
  // 放宽门槛抬高后假定宽度不够 → false。
  assert.equal(isFullscreen(null, null, 80, 24, { KHY_SIDEBAR_MIN_COLS_FALLBACK: '100' }), false);
  // 会话最大非法时仍严格 false(与既有语义一致)。
  assert.equal(isFullscreen(null, null, undefined, undefined, {}), false);
});

test('shouldShowSidebar: 尺寸未知 + 会话最大为假定尺寸 → true(看板不永久隐藏)', () => {
  assert.equal(shouldShowSidebar(null, null, 80, 24, {}), true);
  assert.equal(shouldShowSidebar(null, null, 80, 24, { KHY_SIDEBAR: '0' }), false, '总开关仍压死');
});

test('isWideTerminal: 不受 KHY_SIDEBAR 开关影响(关侧栏不关宽屏门)', () => {
  assert.equal(isWideTerminal(200, { KHY_SIDEBAR: '0' }), true);
  assert.equal(shouldShowSidebar(200, 50, 200, 50, { KHY_SIDEBAR: '0' }), false);
});

test('minCols: shouldShowSidebar 地板与 isWideTerminal 同源(120)', () => {
  assert.equal(minCols({}), 120);
  // 119 列即使等于会话最大也不显示(与 isWideTerminal 同一阈值单源)。
  assert.equal(shouldShowSidebar(119, 40, 119, 40, {}), false);
});

// ── sidebarBg: 背景色解析(任务#6) ───────────────────────────────────
test('sidebarBg: 未设置 → 默认 #2e2e2e', () => {
  assert.equal(sidebarBg({}), '#2e2e2e');
  assert.equal(sidebarBg(undefined), '#2e2e2e');
  assert.equal(sidebarBg({ KHY_SIDEBAR_BG: '' }), '#2e2e2e');
});

test('sidebarBg: 关闭写法 → null(回退边框视觉)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(sidebarBg({ KHY_SIDEBAR_BG: v }), null, `value ${v}`);
  }
});

test('sidebarBg: 合法颜色格式原样使用', () => {
  for (const v of ['#333', '#1a2b3c', 'gray', 'blueBright', 'rgb(40, 40, 40)', 'ansi256(236)']) {
    assert.equal(sidebarBg({ KHY_SIDEBAR_BG: v }), v, `value ${v}`);
  }
});

test('sidebarBg: 非法值回退默认(绝不喂垃圾给 chalk)', () => {
  for (const v of ['#12', '#12345g', 'rgb(1,2)', 'ansi256()', 'not a color!', '###']) {
    assert.equal(sidebarBg({ KHY_SIDEBAR_BG: v }), '#2e2e2e', `value ${v}`);
  }
});

test('sidebarBg: ansi256 数值边界 0–255,超范围回退默认', () => {
  assert.equal(sidebarBg({ KHY_SIDEBAR_BG: 'ansi256(0)' }), 'ansi256(0)');
  assert.equal(sidebarBg({ KHY_SIDEBAR_BG: 'ansi256(255)' }), 'ansi256(255)');
  assert.equal(sidebarBg({ KHY_SIDEBAR_BG: 'ansi256(256)' }), '#2e2e2e');
  assert.equal(sidebarBg({ KHY_SIDEBAR_BG: 'ansi256(999999)' }), '#2e2e2e');
});

// ── classifyResize: 字体缩放 vs 真实窗口 resize(缩放免疫) ───────────────
test('classifyResize: 等比缩小(放大字体) → zoom', () => {
  assert.equal(classifyResize(200, 50, 160, 40, {}), 'zoom', 'rc=rr=0.8');
  assert.equal(classifyResize(150, 40, 120, 32, {}), 'zoom', 'rc=rr=0.8');
});

test('classifyResize: 等比放大(缩小字体) → zoom', () => {
  assert.equal(classifyResize(150, 40, 180, 48, {}), 'zoom', 'rc=rr=1.2');
  assert.equal(classifyResize(120, 30, 240, 60, {}), 'zoom', 'rc=rr=2');
});

test('classifyResize: 近似等比(差异在默认容差 0.15 内) → zoom', () => {
  // rc=170/150≈1.133, rr=46/40=1.15, |diff|≈0.017 ≤ 0.15
  assert.equal(classifyResize(150, 40, 170, 46, {}), 'zoom');
});

test('classifyResize: 仅单轴变化 → resize(非同向)', () => {
  assert.equal(classifyResize(150, 40, 180, 40, {}), 'resize', '仅宽度变');
  assert.equal(classifyResize(150, 40, 150, 50, {}), 'resize', '仅高度变');
});

test('classifyResize: 非等比变化(差异超容差) → resize', () => {
  // rc=200/150≈1.333, rr=45/40=1.125, |diff|≈0.208 > 0.15
  assert.equal(classifyResize(150, 40, 200, 45, {}), 'resize');
  // 反向变化(宽增高减)不可能是字体缩放。
  assert.equal(classifyResize(150, 40, 180, 30, {}), 'resize');
});

test('classifyResize: 首帧(prev 非法/缺失) → resize', () => {
  assert.equal(classifyResize(0, 0, 150, 40, {}), 'resize');
  assert.equal(classifyResize(NaN, 40, 150, 40, {}), 'resize');
  assert.equal(classifyResize(undefined, undefined, 150, 40, {}), 'resize');
});

test('classifyResize: 尺寸不变 → none', () => {
  assert.equal(classifyResize(150, 40, 150, 40, {}), 'none');
});

test('classifyResize: 新尺寸非法 → none', () => {
  assert.equal(classifyResize(150, 40, 0, 40, {}), 'none');
  assert.equal(classifyResize(150, 40, NaN, 40, {}), 'none');
  assert.equal(classifyResize(150, 40, 150, undefined, {}), 'none');
});

test('classifyResize: KHY_SIDEBAR_ZOOM_TOL 自定义容差生效', () => {
  // 收紧到 0.01:原本 zoom 的近似等比(diff≈0.017)判为 resize。
  assert.equal(classifyResize(150, 40, 170, 46, { KHY_SIDEBAR_ZOOM_TOL: '0.01' }), 'resize');
  // 放宽到 0.5:原本 resize 的非等比(diff≈0.208)判为 zoom。
  assert.equal(classifyResize(150, 40, 200, 45, { KHY_SIDEBAR_ZOOM_TOL: '0.5' }), 'zoom');
});

test('classifyResize: 容差非法回退默认 0.15', () => {
  for (const v of ['abc', '-1', '0', '']) {
    assert.equal(classifyResize(150, 40, 170, 46, { KHY_SIDEBAR_ZOOM_TOL: v }), 'zoom', `value ${v}`);
    assert.equal(classifyResize(150, 40, 200, 45, { KHY_SIDEBAR_ZOOM_TOL: v }), 'resize', `value ${v}`);
  }
});

// ── stickyDim：帧间尺寸粘滞（看板抖动/重影根因 B）────────────────────────────
test('stickyDim: 合法读数 → floor，新合法值替换旧值', () => {
  assert.equal(stickyDim(150, null, {}), 150);
  assert.equal(stickyDim(150.9, 120, {}), 150, '向下取整');
  assert.equal(stickyDim(80, 150, {}), 80, '新合法值必须替换旧值，不能粘滞在旧宽度');
});

test('stickyDim: 震荡序列 合法→undefined→合法 全程稳定（不跌回 fallback）', () => {
  let prev = null;
  const frames = [120, undefined, 120, undefined, undefined, 120];
  const out = frames.map((raw) => {
    const v = stickyDim(raw, prev, {});
    if (typeof v === 'number' && v > 0) prev = v;
    return v;
  });
  assert.deepEqual(out, [120, 120, 120, 120, 120, 120]);
});

test('stickyDim: unknown 且无 prev → null（调用方走单一 fallback + 放宽门控）', () => {
  assert.equal(stickyDim(undefined, null, {}), null);
  assert.equal(stickyDim(null, undefined, {}), null);
});

test('stickyDim: 垃圾读数（NaN/0/负/非数）→ 0，且绝不粘滞', () => {
  for (const raw of [0, -5, NaN, 'abc']) {
    assert.equal(stickyDim(raw, 120, {}), 0, `raw=${String(raw)}`);
  }
});

test('stickyDim: 垃圾 prev 不参与粘滞 → null', () => {
  for (const prev of [0, -5, NaN, 'abc']) {
    assert.equal(stickyDim(undefined, prev, {}), null, `prev=${String(prev)}`);
  }
});

test('stickyDim: KHY_TERM_STICKY_DIMS 关写法 → unknown 恒为 null（逐字节回退）', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(stickyDim(undefined, 120, { KHY_TERM_STICKY_DIMS: v }), null, `value ${v}`);
  }
  for (const v of ['1', 'true', '', 'maybe']) {
    assert.equal(stickyDim(undefined, 120, { KHY_TERM_STICKY_DIMS: v }), 120, `value ${v} 不该关掉默认开`);
  }
});

test('stickyDim: prev 为小数时同样向下取整', () => {
  assert.equal(stickyDim(undefined, 120.7, {}), 120);
});

// ── nextSessionMax：会话最大尺寸单调更新（D2：fallback 帧不得污染基线）─────
test('nextSessionMax: 尺寸已知且更大 → 增长会话最大', () => {
  assert.deepEqual(nextSessionMax(true, 150, 40, 120, 30), { cols: 150, rows: 40 });
  assert.deepEqual(nextSessionMax(true, 150, 25, 120, 30), { cols: 150, rows: 30 }, '单轴增长另一轴保持');
});

test('nextSessionMax: 尺寸已知但更小/相等 → 最大值不变（单调性）', () => {
  assert.deepEqual(nextSessionMax(true, 100, 20, 120, 30), { cols: 120, rows: 30 });
  assert.deepEqual(nextSessionMax(true, 120, 30, 120, 30), { cols: 120, rows: 30 });
});

test('nextSessionMax: 尺寸未知（dimsKnown=false）→ fallback 值绝不参与更新', () => {
  // Windows conpty 真实尺寸 ↔ undefined 震荡：unknown 帧携带假定 80x24，
  // 若写入会话最大会破坏全屏判定基线 → 看板间歇性 show/hide 闪烁。
  assert.deepEqual(nextSessionMax(false, 200, 60, 120, 30), { cols: 120, rows: 30 });
  assert.deepEqual(nextSessionMax(false, 80, 24, 120, 30), { cols: 120, rows: 30 });
});

test('nextSessionMax: dimsKnown 非严格 true（truthy 垃圾）→ 视为未知不更新', () => {
  for (const v of [1, 'true', {}, undefined, null]) {
    assert.deepEqual(nextSessionMax(v, 200, 60, 120, 30), { cols: 120, rows: 30 }, `dimsKnown=${String(v)}`);
  }
});

test('nextSessionMax: 当前尺寸垃圾值（NaN/0/负）→ 不增长最大', () => {
  for (const bad of [NaN, 0, -5, undefined]) {
    assert.deepEqual(nextSessionMax(true, bad, bad, 120, 30), { cols: 120, rows: 30 }, `dim=${String(bad)}`);
  }
});

test('nextSessionMax: 旧最大非法（NaN/undefined）→ 归一化为 0 后照常增长', () => {
  assert.deepEqual(nextSessionMax(true, 150, 40, NaN, undefined), { cols: 150, rows: 40 });
  assert.deepEqual(nextSessionMax(false, 150, 40, NaN, undefined), { cols: 0, rows: 0 }, 'unknown 帧下仅归一化');
});

test('nextSessionMax: 返回新对象，不就地修改调用方状态', () => {
  const before = { cols: 120, rows: 30 };
  const out = nextSessionMax(true, 150, 40, before.cols, before.rows);
  assert.notEqual(out, before);
  assert.deepEqual(before, { cols: 120, rows: 30 });
});

test('nextSessionMax: 震荡序列 真实→unknown→真实 基线全程稳定（D2 回归场景）', () => {
  // 真实 150x40 → unknown（fallback 80x24）→ 真实 150x40：最大值全程 150x40，
  // 且每一真实帧都在容差内 → isFullscreen 恒 true，看板不闪。
  let max = { cols: 0, rows: 0 };
  const frames = [
    { known: true, c: 150, r: 40 },
    { known: false, c: 80, r: 24 },
    { known: true, c: 150, r: 40 },
  ];
  for (const f of frames) {
    max = nextSessionMax(f.known, f.c, f.r, max.cols, max.rows);
    assert.deepEqual(max, { cols: 150, rows: 40 });
  }
  assert.equal(isFullscreen(150, 40, max.cols, max.rows, {}), true);
});
