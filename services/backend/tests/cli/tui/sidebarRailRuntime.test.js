'use strict';

// Unit tests for runtime/sidebarRail — state machine, the "paintBytes performs no
// IO" contract, suspend/resume/resize clears, and idempotent teardown.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('stream');

const RAIL = require.resolve('../../../src/cli/tui/runtime/sidebarRail');

// Each load() installs its own exit/SIGINT/SIGTERM hook (production loads the
// module exactly once; this suite reloads it per test). Lift the listener cap so
// the resulting warning does not mask a REAL leak warning from elsewhere.
process.setMaxListeners(0);

/** Fresh module instance per test — the runtime holds module-level state. */
function load() {
  delete require.cache[RAIL];
  return require(RAIL);
}

/** A TTY-shaped sink that records every write. */
function fakeTTY(cols = 150, rows = 40) {
  const writes = [];
  const s = new Writable({ write(c, e, cb) { writes.push(String(c)); cb(); } });
  s.columns = cols;
  s.rows = rows;
  s.isTTY = true;
  s.writes = writes;
  return s;
}

const SNAP = { taskLines: ['→ 修复登录校验', '○ 补充单元测试'], queueLen: 1 };

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// ── enable ─────────────────────────────────────────────────────────────────
test('enable: 门控未开 → false,且不碰终端', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '0' }, () => {
    assert.equal(rail.enable(out), false);
  });
  assert.equal(rail.isEnabled(), false);
  assert.equal(out.writes.length, 0);
});

test('enable: 非 TTY → false(管道里没有可寻址的单元格)', () => {
  const rail = load();
  const pipe = fakeTTY();
  pipe.isTTY = false;
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    assert.equal(rail.enable(pipe), false);
  });
});

test('enable: 门控开 + TTY → true,幂等', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    assert.equal(rail.enable(out), true);
    assert.equal(rail.enable(out), true, '重复调用应幂等返回 true');
    assert.equal(rail.isEnabled(), true);
    assert.equal(rail.isActive(), true);
  });
});

test('isActive: 终端过窄时即便 enabled 也为 false', () => {
  const rail = load();
  const narrow = fakeTTY(80, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    assert.equal(rail.enable(narrow), true, 'enable 只看门控与 TTY');
    rail.setDims(80, 40); // App 每帧推送真实尺寸;画笔不再直读流
    assert.equal(rail.isActive(), false, '80 列 < minCols 120 → 不占列');
    assert.equal(rail.paintBytes(), '', '不激活时不得产生任何字节');
  });
});

// ── paintBytes:核心契约 ───────────────────────────────────────────────────
test('paintBytes: 绝不写 IO —— 只返回字节串', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    const bytes = rail.paintBytes();
    assert.ok(bytes.length > 0, '应产生字节');
    assert.equal(out.writes.length, 0, 'paintBytes 期间终端必须一个字节都没收到');
  });
});

test('paintBytes: 未 enable / 已 suspend → 空串', () => {
  const rail = load();
  const out = fakeTTY();
  assert.equal(rail.paintBytes(), '', '未 enable');
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.suspend();
    assert.equal(rail.paintBytes(), '', '已 suspend');
    rail.resume();
    assert.ok(rail.paintBytes().length > 0, 'resume 后恢复');
  });
});

test('paintBytes: 无快照 → 仍画满空白槽位(不留旧像素)', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40); // App 每帧推送尺寸;画笔用推送值而非直读流
    const bytes = rail.paintBytes();
    assert.ok(bytes.startsWith('\x1b7') && bytes.endsWith('\x1b8'));
    assert.equal((bytes.match(/\x1b\[\d+;127H/g) || []).length, 39, '150-24+1=127 列,rows-1=39 行');
  });
});

test('paintBytes: 内容来自 SidebarPanel.buildSidebarLines(同一份内容管线)', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    const bytes = rail.paintBytes();
    assert.ok(bytes.includes('修复登录校验'), '任务行应出现在槽位里');
    assert.ok(bytes.includes('任务 0/2'), '总进度头行应出现在槽位里');
  });
});

// ── clearBytes:滚屏残影根因修复的前置清理契约 ──────────────────────
test('clearBytes: 未画过(lastGeom 空) → 空串;画过 → 返回清槽位字节且不写 IO', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40); // 画笔用推送尺寸
    assert.equal(rail.clearBytes(), '', '尚未画过 → 无可清');
    rail.setSnapshot(SNAP);
    rail.paintBytes(); // 建立 lastGeom
    const bytes = rail.clearBytes();
    assert.equal(bytes, '', '已有稳定绘制 → 前置清屏必须跳过,避免清屏后重复帧不回画');
    assert.equal(out.writes.length, 0, 'clearBytes 与 paintBytes 同契约:绝不写 IO');
  });
});

test('clearBytes: 未 enable / 已 suspend → 空串', () => {
  const rail = load();
  const out = fakeTTY();
  assert.equal(rail.clearBytes(), '', '未 enable');
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    rail.suspend();
    assert.equal(rail.clearBytes(), '', '已 suspend(suspend 自己已清过)');
  });
});

test('paintBytes: 不含 \\n / \\r(一个换行就会滚屏)', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    const bytes = rail.paintBytes();
    assert.ok(!bytes.includes('\n'));
    assert.ok(!bytes.includes('\r'));
  });
});

test('paintBytes: 几何变化(变窄)时先清旧槽位再画新槽位', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(150, 40);
    rail.paintBytes();               // 建立 lastGeom(left=127, width=24)
    rail.setDims(130, 40);           // 变窄 → 栏宽 24 → left=107(经推送,非直读流)
    const bytes = rail.paintBytes();
    const firstClear = bytes.indexOf('\x1b[1;127H' + ' '.repeat(24));
    const firstPaint = bytes.indexOf('\x1b[1;107H');
    assert.ok(firstClear >= 0, '必须清理旧几何');
    assert.ok(firstPaint > firstClear, '清理必须发生在新绘制之前');
  });
});

test('paintBytes: 几何未变时不发多余的清屏字节', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    const bytes = rail.paintBytes();
    assert.equal(bytes, '', '几何与内容均未变时应跳过重复绘制');
  });
});

test('paintBytes(force): 滚屏帧即使内容相同也强制回画', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    assert.ok(rail.clearBytes(true).length > 0, '滚屏帧前应清旧槽位');
    assert.ok(rail.paintBytes(true).length > 0, '滚屏帧后应强制回画相同内容');
  });
});

// ── suspend / resume / onResize / disable:直接写真实流 ─────────────────────
test('suspend: 直接写清屏字节到真实流,并幂等', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    out.writes.length = 0;
    rail.suspend();
    assert.equal(out.writes.length, 1, '应写出一次清屏');
    assert.ok(out.writes[0].includes(' '.repeat(24)));
    assert.ok(!out.writes[0].includes('48;2;'), '清屏不得带背景色');
    rail.suspend();
    assert.equal(out.writes.length, 1, '重复 suspend 不再写');
  });
});

test('onResize: 几何变化 → 清旧槽位;几何未变 → 不写', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(150, 40);
    rail.paintBytes();
    out.writes.length = 0;
    rail.onResize();
    assert.equal(out.writes.length, 0, '尺寸未变不应写');
    rail.setDims(130, 40);           // 经推送变窄(画笔不再直读流)
    rail.onResize();
    assert.equal(out.writes.length, 1, '尺寸变了应清旧槽位');
    assert.ok(out.writes[0].includes('\x1b[1;127H'), '清的是旧几何');
  });
});

test('onResize: 尚未画过(lastGeom 为空) → 不写', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.onResize();
    assert.equal(out.writes.length, 0);
  });
});

test('disable: 清空槽位、复位状态、幂等', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    out.writes.length = 0;
    rail.disable();
    assert.equal(out.writes.length, 1, '应写出一次清屏');
    assert.equal(rail.isEnabled(), false);
    assert.equal(rail.isActive(), false);
    rail.disable();
    assert.equal(out.writes.length, 1, '重复 disable 不再写');
    assert.equal(rail.paintBytes(), '');
  });
});

test('disable: 未 enable 时调用无副作用(退出路径必经)', () => {
  const rail = load();
  assert.doesNotThrow(() => rail.disable());
});

// ── setDims：App 推送尺寸，画笔与树内判定同源(抖动/重影根因 A) ─────────
test('setDims: 几何跟随推送尺寸，流上读数帧间震荡不再影响画笔', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(150, 40);
    rail.paintBytes(); // 建立 lastGeom(left=127)
    out.columns = undefined; // conpty 震荡：流上瞬时读不到宽度
    out.rows = undefined;
    const bytes = rail.paintBytes();
    assert.equal(bytes, '', '几何未变且帧内容未变 → 跳过重复绘制');
  });
});

test('setDims: 未推送时按单一真源 fallback 出图(绝不直读 stdout)', () => {
  // 根因 A:画笔已封堵直读 process.stdout.columns/rows 的回退分支。未推送尺寸
  // → dims 未知 → railGeometry 用单一真源 fallback(假定 80x24),而不是流上的 150。
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    const bytes = rail.paintBytes();
    assert.ok(bytes.includes('\x1b[1;57H'), '未推送 → 按假定 80 列(left=57),不读流上的 150');
    assert.ok(!bytes.includes('\x1b[1;127H'), '绝不落到流上 150 列的 left=127');
  });
});

test('setDims: 推送 unknown(null) → 按单一 fallback 几何激活(与 contentCols 同源)', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(null, null);
    const bytes = rail.paintBytes();
    // 假定 80x24 → 栏宽 clamp 下界 24 → left=57；与 railLayout fallback 几何一致。
    assert.ok(bytes.includes('\x1b[1;57H'), '按假定 80 列出图(left=57)');
  });
});

test('setDims: 推送垃圾值(0) → 画笔不激活、不产字节', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(0, 40);
    assert.equal(rail.isActive(), false, '垃圾宽度严格拒绝，不得凭空激活');
    assert.equal(rail.paintBytes(), '');
  });
});

test('setDims: 有效值后推 unknown(null) → 粘滞保留上次有效值(抗振荡)', () => {
  // 单一真源粘滞三态:conpty 振荡到 undefined 的一帧必须复用上次有效几何,
  // 而不是坠到 fallback —— 否则看板会在 130↔假定80 之间闪。
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_TERM_STICKY_DIMS: '1' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(130, 40);              // 有效 → 栏宽24 → left=107
    rail.paintBytes();
    rail.setDims(null, null);           // unknown → 应粘滞回 130,而非假定80
    rail.setSnapshot({ ...SNAP, queueLen: 2 }); // 触发一次新帧以观察粘滞几何
    const bytes = rail.paintBytes();
    assert.ok(bytes.includes('\x1b[1;107H'), 'unknown 帧粘滞保留 130 列(left=107)');
    assert.ok(!bytes.includes('\x1b[1;57H'), '绝不坠到假定 80 列(left=57)');
  });
});

test('setDims: disable 复位推送尺寸,重新 enable 后按单一 fallback(不读流)', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(130, 40);
    rail.disable();
    rail.enable(out);
    rail.setSnapshot(SNAP);
    const bytes = rail.paintBytes();
    assert.ok(bytes.includes('\x1b[1;57H'), 'disable 清空 dims → 按假定 80 列(left=57),不读流上的 150');
  });
});

// ── setChrome：底边锚定（任务#7，看板最后一行=输入框下线所在行）───────────
// Helper: collect the 1-based screen rows the paint targets at the rail's left
// column (127 on a 150-col terminal). buildRailPaint emits one absolute move per
// content row, contiguous, so min/max/count fully describe the block geometry.
function paintedRows(bytes, left = 127) {
  const re = new RegExp('\\x1b\\[(\\d+);' + left + 'H', 'g');
  return [...bytes.matchAll(re)].map((m) => Number(m[1]));
}

test('setChrome: 底边锚定 —— 看板最后一行 = rows-chrome（输入框下线），内容向上生长', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(150, 40);
    rail.setChrome({});                 // 默认底部 chrome = 2（权限+预算）
    const rows = paintedRows(rail.paintBytes());
    assert.ok(rows.length > 0, '应画出内容行');
    const bottom = Math.max(...rows);
    const top = Math.min(...rows);
    assert.equal(bottom, 40 - 2, '看板底边落在 rows-chrome=38（=输入框下线所在行）');
    assert.equal(bottom - top + 1, rows.length, '行连续，无空洞');
    assert.ok(rows.length < 39, 'hug：远少于 legacy 满屏的 39 行（不再从顶铺到底）');
  });
});

test('setChrome: 底部 chrome 变大 → 看板整体上移，仍与输入框下线平齐', () => {
  // Measure each chrome value from a FRESH first paint so the reading is the
  // pure PAINT geometry (a chrome change on a live rail also emits a stale-clear
  // at the OLD rows, which would otherwise pollute Math.max).
  const measure = (chrome) => {
    const rail = load();
    const out = fakeTTY(150, 40);
    return withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }, () => {
      rail.enable(out);
      rail.setSnapshot(SNAP);
      rail.setDims(150, 40);
      rail.setChrome(chrome);
      return paintedRows(rail.paintBytes());
    });
  };
  const b1 = measure({});                                        // chrome = 2
  const b2 = measure({ collabActive: true, topicInFooter: true }); // chrome = 4
  assert.equal(Math.max(...b1), 38, 'chrome=2 → 底边 38');
  assert.equal(Math.max(...b2), 36, 'chrome=4 → 底边 36（随页脚变高上移）');
  assert.equal(b1.length, b2.length, '内容行数不变 → 只是整体上移');
});

test('setChrome: 数字直传也生效（底边=rows-chrome）', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }, () => {
    rail.enable(out);
    rail.setSnapshot(SNAP);
    rail.setDims(150, 40);
    rail.setChrome(5);
    assert.equal(Math.max(...paintedRows(rail.paintBytes())), 35, '底边 = 40 - 5');
  });
});

test('setChrome: 传 null 恢复 legacy 顶部锚定填充（top=1，满 39 行）', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setChrome({});
    rail.setChrome(null);               // 撤销 → 回到 legacy
    const bytes = rail.paintBytes();     // 无快照：legacy 填满空白槽位
    assert.equal(paintedRows(bytes).length, 39, 'legacy：从第1行铺到 rows-1=39 行');
  });
});

test('setChrome: 底边锚定下,内容增高时先清旧槽位再画新槽位(top 变化也触发清理)', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setChrome({});
    rail.setSnapshot({ taskLines: ['→ 一行'], queueLen: 0 });
    const r1 = paintedRows(rail.paintBytes());
    rail.setSnapshot({ taskLines: ['→ 一', '○ 二', '○ 三', '○ 四', '○ 五'], queueLen: 0 });
    const bytes = rail.paintBytes();
    const r2 = paintedRows(bytes);
    assert.ok(r2.length >= r1.length, '任务变多 → 看板变高');
    assert.equal(Math.max(...r2), 38, '底边始终贴输入框下线(38)');
    assert.ok(bytes.includes('\x1b7'), '含一段 DECSC…DECRC(先清后画同一次落地)');
  });
});

// ── 阶段四: setNav / viewportRows / 反色高亮 ─────────────────────────────
test('setNav: 设置合法 scrollOffset/focusIndex', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.setNav({ scrollOffset: 5, focusIndex: 2 });
    // The rail uses these values internally; we just verify it doesn't throw
    // and that a subsequent paint still works.
    const bytes = rail.paintBytes();
    assert.ok(bytes.length > 0, 'paint 正常产出字节');
  });
});

test('setNav: null 重置为默认(offset=0, index=-1)', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.setNav({ scrollOffset: 5, focusIndex: 2 });
    rail.setNav(null);
    const bytes = rail.paintBytes();
    assert.ok(bytes.length > 0, '重置后 paint 正常');
  });
});

test('viewportRows: 激活时返回几何高度(>0)', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    const rows = rail.viewportRows();
    assert.ok(rows > 0, `viewportRows 应 > 0, got ${rows}`);
    assert.ok(rows <= 39, '不超过 rows-1');
  });
});

test('viewportRows: 未激活时返回 0', () => {
  const rail = load();
  const out = fakeTTY(80, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(80, 40);
    assert.equal(rail.viewportRows(), 0, '窄屏无激活 → 0');
  });
});

test('反色高亮: focusIndex 内的行带 inverse 且不污染其它行', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR_SCROLL: '1', KHY_SIDEBAR_FOCUS: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot({ taskLines: ['→ 一', '○ 二', '○ 三'], queueLen: 0 });
    rail.setNav({ scrollOffset: 0, focusIndex: 1 });
    const bytes = rail.paintBytes();
    // chalk.inverse starts with ESC[7m and ends with ESC[27m
    const inverseStart = '\x1b[7m';
    const inverseEnd = '\x1b[27m';
    // If chalk is available, we expect inverse markers
    // but the key invariant is: only ONE row should have the inverse pair
    const inverseStarts = (bytes.match(/\x1b\[7m/g) || []).length;
    // Allow 0 (chalk unavailable) or exactly 1 (the selected row)
    assert.ok(inverseStarts <= 1, `最多 1 行 inverse, got ${inverseStarts}`);
  });
});

// ── 阶段四: lazy require 缓存计数 ──────────────────────────────────
test('lazy require 缓存: 成功后多次 paintBytes 不增加 require 调用', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    // First paint: lazy deps get resolved
    rail.paintBytes();
    // Count cache keys after first successful paint
    const cacheKeysBefore = Object.keys(require.cache).length;
    // Second and third paints: should NOT resolve new modules
    rail.paintBytes();
    rail.paintBytes();
    const cacheKeysAfter = Object.keys(require.cache).length;
    assert.equal(cacheKeysAfter, cacheKeysBefore, 'require.cache 不应增长(缓存命中)');
  });
});

test('_resetLazyCacheForTest: 清除后下次 paintBytes 重新 require(但仍成功)', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.paintBytes(); // populate cache
    rail._resetLazyCacheForTest();
    // After reset, the stable frame may be deduplicated; change the snapshot to
    // verify the dependencies are re-resolved on the next actual paint.
    rail.setSnapshot({ ...SNAP, queueLen: 2 });
    const bytes = rail.paintBytes();
    assert.ok(bytes.length > 0, '重置后发生新帧时 paint 仍正常');
  });
});

