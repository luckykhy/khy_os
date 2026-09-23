'use strict';

/**
 * BUG-70/71/72 的数学层守卫：CC 浮层的行预算与窗口起点（纯叶子，无 ink）。
 *
 * 渲染层的等价断言在 tests/tui/ccOverlayFit.test.js。这里钉的是三条判据本身：
 *   ① 列表行预算 = rows - 1 - chrome，且**必须严格小于 rows**
 *      （ink 在 outputHeight >= stdout.rows 时走全屏分支写 \x1b[2J，
 *       win32 的 2J 把旧帧滚进回滚缓冲 → 每次重画留一份整屏残影）；
 *   ② 窗口起点由选中下标派生 → 选中项恒在窗内（旧代码 slice(0, N) 钉死在开头，
 *      ↓ 过第 N 条后高亮「▸」根本不在屏上，Enter 选中的是看不见的那条）；
 *   ③ 条目裁成一行（长条目折行会让「条数上限」不再等于「行预算」）。
 */

const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../src/cli/tui/ink-components/ccOverlayLayout';

function freshLeaf(envOverrides) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides || {})) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve(LEAF)];
  const mod = require(LEAF);
  return {
    mod,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[require.resolve(LEAF)];
    },
  };
}

test('行预算随终端行数收紧，且总高严格小于 rows（不留等于 rows 的边界）', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    const chrome = 6; // 上下边框 2 + 输入行 1 + 分隔线 1 + 空行 1 + 提示行 1
    for (const rows of [40, 24, 16, 12, 8]) {
      const visible = mod.listRows({ rows, chrome, total: 200 });
      assert.ok(visible >= 1, `rows=${rows} 至少要画 1 行`);
      assert.ok(
        visible + chrome < rows,
        `rows=${rows}: 总高 ${visible + chrome} 必须严格小于 rows（否则 ink 走全屏分支）`
      );
    }
  } finally { restore(); }
});

test('条目更多时窗口跟着下标走：选中项恒在 [start, start+visible) 内', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    const visible = 10;
    const total = 25;
    for (let selected = 0; selected < total; selected += 1) {
      const start = mod.pageStart(selected, visible, total);
      assert.ok(start >= 0, `start 不能为负（selected=${selected}）`);
      assert.ok(start + visible <= total, `末窗越界（selected=${selected}）`);
      assert.ok(
        selected >= start && selected < start + visible,
        `selected=${selected} 落在窗口 [${start},${start + visible}) 之外 → 屏上看不见`
      );
    }
  } finally { restore(); }
});

test('窗口贴底：最后一页不出现「只剩 2 条也占一页」的空白尾巴', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    assert.equal(mod.pageStart(24, 10, 25), 15, '末条应把窗口贴到 total-visible');
    assert.equal(mod.pageStart(0, 10, 5), 0, '装得下就不开窗');
    assert.equal(mod.pageStart(-3, 10, 25), 0, '负下标钳到 0');
    assert.equal(mod.pageStart(999, 10, 25), 15, '越界下标钳到末条');
  } finally { restore(); }
});

test('长条目裁成一行：内嵌换行被去掉、超宽补省略号、CJK 按显示宽度算', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    const { displayWidth } = require('../src/cli/formatters');
    assert.equal(mod.clipLine('a\nb\nc', 40), 'a b c');
    const wide = '用一段连续的中文长句回答为什么不该把 .env 提交进 git';
    const clipped = mod.clipLine(wide, 20);
    assert.ok(displayWidth(clipped) <= 20, `裁完仍占 ${displayWidth(clipped)} 列 > 20`);
    assert.ok(clipped !== wide, '超宽内容必须被裁');
    assert.equal(mod.clipLine(null, 10), '');
  } finally { restore(); }
});

test('门控关 → 回退旧选取语义：窗口钉在 0、条数用旧上限', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '0' });
  try {
    assert.equal(mod.pageStart(20, 10, 25), 0, '门控关则窗口不跟随');
    assert.equal(mod.listRows({ rows: 12, chrome: 6, total: 25, legacyCap: 10 }), 10,
      '门控关 → 旧的「10 条」硬上限，与终端行数无关');
    assert.equal(mod.moreHint(20, 10, 25), '');
  } finally { restore(); }
});

test('rows 报 0/undefined（部分 Windows 终端）→ 兜底 24 而不是画 0 行', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    assert.equal(mod.normRows(0), 24);
    assert.equal(mod.normRows(undefined), 24);
    assert.ok(mod.listRows({ rows: 0, chrome: 6, total: 25 }) >= 1);
  } finally { restore(); }
});

/**
 * BUG-73：三个浮层曾各自裸读 process.stdout.columns/rows 求尺寸。非 TTY（管道/conpty）
 * 下那是 undefined，`undefined - 8` 一路 NaN，裁切宽度塌到 clipLine 的地板 4，
 * 面板条目全画成「h...」。termSize 把尺寸口径收进叶子：宿主值优先，其次
 * ../effectiveDims（全仓唯一允许读 stdout 的入口），且**永远返回有限正整数**。
 */
test('termSize：宿主值优先，垃圾值一律退回 effectiveDims 口径，绝不返回 NaN', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  const eff = require('../src/cli/tui/effectiveDims');
  try {
    // ① 宿主传下来的现值优先，且向下取整（不碰终端）
    assert.equal(mod.termSize('rows', 12), 12);
    assert.equal(mod.termSize('cols', 60.7), 60);

    // ② 垃圾宿主值不得自成一派：必须退回 effectiveDims 的同一个答案，
    //    否则「组件以为 24 行、ink 按 12 行判全屏」这种假绿就没人拦得住。
    const stickyRows = eff.stickyRows();
    const expectRows = Number.isFinite(stickyRows) && stickyRows > 0 ? Math.floor(stickyRows) : 24;
    for (const junk of [null, undefined, 0, -3, NaN, Infinity, 'abc', '', {}]) {
      assert.equal(
        mod.termSize('rows', junk), expectRows,
        `宿主值 ${String(junk)} 应退回 effectiveDims 的 ${expectRows}`
      );
    }

    // ③ 永不 NaN —— 这是「h...」的成因：非 TTY 下裸读 stdout 得到 undefined，
    //    `undefined - 8` 一路 NaN，裁切宽度塌到 clipLine 的地板 4。
    for (const axis of ['rows', 'cols']) {
      const v = mod.termSize(axis, undefined);
      assert.ok(Number.isInteger(v) && v > 0, `${axis} → ${v}`);
    }
  } finally { restore(); }
});

test('termSize 与宿主同源：宿主给了尺寸就不读终端（即便终端报 0/undefined）', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  try {
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true, writable: true });
    // defineProperty 在部分 Node/stdout 形态下会被忽略 —— 先验工具再验产品。
    if (process.stdout.rows === 40) {
      assert.equal(mod.termSize('rows', null), 40, '宿主没传 → 读 effectiveDims 的 40');
      assert.equal(mod.termSize('rows', 7), 7, '宿主传了 → 终端读数不得反客为主');
    }
  } finally {
    if (savedRows) Object.defineProperty(process.stdout, 'rows', savedRows);
    else delete process.stdout.rows;
    require('../src/cli/tui/effectiveDims')._resetStickyForTest();
    restore();
  }
});

// ── BUG-88：装饰让位梯 + 「另有 N 条」这一行必须从预算里出 ──────────────────

const SHED6 = [
  { name: 'tabGap', rows: 1 }, { name: 'contentGap', rows: 1 }, { name: 'footerGap', rows: 1 },
  { name: 'topRule', rows: 1 }, { name: 'bottomRule', rows: 1 }, { name: 'footer', rows: 1 },
];

test('chromePlan：装得下时总高严格小于 rows；装不下时砍装饰而不是撑破屏幕', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    for (let rows = 1; rows <= 40; rows += 1) {
      const p = mod.chromePlan({ rows, full: 9, shed: SHED6, minList: 2 });
      assert.ok(Number.isInteger(p.chrome) && p.chrome >= 0 && p.chrome <= 9, `chrome ${p.chrome} @${rows}`);
      // 让位梯只能按顺序整件砍：shed 必须是梯的前缀。
      assert.deepEqual(p.shed, SHED6.slice(0, p.shed.length).map((s) => s.name), `让位顺序 @${rows}`);
      assert.equal(p.budget, Math.max(2, rows - mod.FULLSCREEN_RESERVE - p.chrome), `预算 @${rows}`);
      assert.equal(p.fits, rows - mod.FULLSCREEN_RESERVE - p.chrome >= 2, `fits @${rows}`);
      // fits 是唯一契约：付得起时「chrome + 预算」绝不顶到 rows。
      if (p.fits) {
        assert.ok(p.chrome + p.budget <= rows - mod.FULLSCREEN_RESERVE, `fits 却付不起 @${rows}`);
      } else {
        assert.equal(p.shed.length, SHED6.length, `砍光仍不够才算 fits=false @${rows}`);
      }
    }
  } finally { restore(); }
});

test('listWithHint：提示行从预算里出，任何 budget 下「内容 + 提示」都不超预算', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    for (let budget = 0; budget <= 12; budget += 1) {
      for (const total of [0, 1, 2, 6, 12, 99]) {
        const { shown, hint } = mod.listWithHint(budget, total);
        assert.ok(shown + (hint ? 1 : 0) <= Math.max(budget, 1), `超预算 b=${budget} t=${total}`);
        assert.ok(shown <= total, `画了不存在的条目 b=${budget} t=${total}`);
        if (total <= budget) assert.equal(shown, total, `放得下却不画满 b=${budget} t=${total}`);
        else if (budget >= 2) assert.ok(hint, `截断了却不告诉用户 b=${budget} t=${total}`);
        assert.ok(!hint || shown < total, `提示说「还有 N 条」却一条没藏 b=${budget} t=${total}`);
      }
    }
    // 旧病灶：budget=1 时旧代码画 1 条**再加**1 行提示 = 2 行 > 预算（实画≠账本）。
    assert.deepEqual(mod.listWithHint(1, 12), { shown: 1, hint: false });
  } finally { restore(); }
});

const SHED3 = [
  { name: 'spacer', rows: 1 }, { name: 'rule', rows: 1 }, { name: 'footer', rows: 1 },
];

test('chromeLadder：列表 ≥2 条时先试着保 2 行，付不起才回落到 1 行；关门即旧口径', () => {
  const { mod, restore } = freshLeaf({ KHY_CC_OVERLAY_FIT: '1' });
  try {
    for (let rows = 1; rows <= 40; rows += 1) {
      const one = mod.chromeLadder({ rows, full: 6, shed: SHED3, total: 1 });
      const many = mod.chromeLadder({ rows, full: 6, shed: SHED3, total: 5 });
      // 想要 2 行的那份**只会更保守**：chrome 更小（多砍装饰），绝不多留装饰。
      assert.ok(many.chrome <= one.chrome, `条目多反而更不砍 @${rows}`);
      assert.ok(many.shed.length >= one.shed.length, `让位件数反向 @${rows}`);
      assert.deepEqual(many.shed.slice(0, one.shed.length), one.shed, `让位不是在同一条梯上往下走 @${rows}`);
      assert.deepEqual(many.shed, SHED3.slice(0, many.shed.length).map((s) => s.name), `让位顺序 @${rows}`);
      if (many.fits) assert.ok(many.chrome + many.budget <= rows - mod.FULLSCREEN_RESERVE, `fits 却付不起 @${rows}`);
      if (one.fits) assert.ok(one.chrome + one.budget <= rows - mod.FULLSCREEN_RESERVE, `fits 却付不起(1 行档) @${rows}`);
      // 两条在 fits 上必须一致：回落只允许发生在「2 行买不起」时，不能让 1 行档反而越屏。
      assert.equal(many.fits, one.fits, `fits 分叉 @${rows}`);
      // 空态永远只要 1 行地板：多砍一件装饰换来的是「多一行空白」，不划算。
      assert.deepEqual(one, mod.chromeLadder({ rows, full: 6, shed: SHED3, total: 0 }));
    }
    // 门关上 = 回到 BUG-88b 之前的那份写死账本：chrome 恒 full、一件不让、预算即条数。
  } finally { restore(); }
  const off = freshLeaf({ KHY_CC_OVERLAY_FIT: '0' });
  try {
    for (const rows of [4, 5, 7, 12, 24]) {
      assert.deepEqual(off.mod.chromeLadder({ rows, full: 6, shed: SHED3, total: 3 }),
        { chrome: 6, budget: 3, shed: [], fits: true }, `关门旧口径 @${rows}`);
    }
  } finally { off.restore(); }
});

