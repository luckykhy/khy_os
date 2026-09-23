'use strict';

// logoArt.test — 品牌资产单一真源的锁定（[DESIGN-ARCH-134] §7.1 #6）。
//
// 四叶草像素表原先**复制**在 WelcomeBanner.js 里，启动屏另有一套 `╱╲` 图案 ——
// 同一进程先后出现两种品牌符号（[DESIGN-ARCH-115] 登记的 D5）。本测试锁三件事：
//   1. 像素表自身自洽（13×9、shade 网格同尺寸、空格不着色）；
//   2. `cli/tui/**` 内 `CLOVER_ART` / `CLOVER_SHADE` 的**定义**只出现在 logoArt.js 一处；
//   3. 字标 / tagline 来自 ccBrand 单一真源，不写第二份字面量。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const logoArt = require('../../../src/cli/tui/logoArt');
const { BRAND } = require('../../../src/cli/tui/utils/ccBrand');

test('像素表自洽：13 列 × 9 行，两条表同尺寸', () => {
  assert.equal(logoArt.CLOVER_ART.length, logoArt.CLOVER_ROWS);
  assert.equal(logoArt.CLOVER_SHADE.length, logoArt.CLOVER_ROWS);
  assert.equal(logoArt.CLOVER_COLS, 13);
  for (let i = 0; i < logoArt.CLOVER_ROWS; i++) {
    assert.equal(logoArt.CLOVER_ART[i].length, logoArt.CLOVER_COLS, `art 第 ${i} 行`);
    assert.equal(logoArt.CLOVER_SHADE[i].length, logoArt.CLOVER_COLS, `shade 第 ${i} 行`);
  }
});

test('cloverRows：逐格结构正确，空格不着色，非法档位回退主体色', () => {
  const rows = logoArt.cloverRows();
  assert.equal(rows.length, logoArt.CLOVER_ROWS);
  rows.forEach((cells, i) => {
    assert.equal(cells.length, logoArt.CLOVER_COLS, `第 ${i} 行`);
    cells.forEach((c, j) => {
      assert.equal(c.ch, logoArt.CLOVER_ART[i][j], `(${i},${j}) 字符必须与像素表逐字一致`);
      if (c.ch === ' ') {
        assert.equal(c.shade, ' ', `(${i},${j}) 空格不参与着色`);
      } else {
        assert.ok(['D', 'M', 'B'].includes(c.shade), `(${i},${j}) 非法档位 ${c.shade}`);
      }
    });
  });
  // 抽两格核对着色语义：左上角是暗边 D，高光 B 必须存在（否则三档纵深退化成单色）。
  assert.equal(rows[0][0].shade, 'D');
  assert.ok(
    rows.some((cells) => cells.some((c) => c.shade === 'B')),
    '必须保留 greenBright 高光档'
  );
});

test('cloverRows 返回新对象：改结果不得污染像素表', () => {
  const a = logoArt.cloverRows();
  a[0][0].ch = 'X';
  a[0][0].shade = 'Z';
  const b = logoArt.cloverRows();
  assert.equal(b[0][0].ch, logoArt.CLOVER_ART[0][0]);
  assert.notEqual(b[0][0].shade, 'Z');
});

test('字标与 tagline 来自 ccBrand 单一真源', () => {
  assert.equal(logoArt.WORDMARK, 'khy OS');
  assert.equal(logoArt.TAGLINE, BRAND.tagline, 'tagline 必须复用 BRAND.tagline，不得写字面量');
  assert.ok(!/khy-os/i.test(logoArt.WORDMARK), '字标不得用仓库目录名 khy-os');
});

// ── 单一资产：定义只允许出现在 logoArt.js 一处 ──────────────────────────

const TUI_DIR = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui');

function walk(dir, out) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('CLOVER_ART / CLOVER_SHADE 的定义在 cli/tui/** 内只出现一次', () => {
  const files = walk(TUI_DIR, []);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const isOwner = path.basename(f) === 'logoArt.js';
    if (!isOwner && /const CLOVER_ART|const CLOVER_SHADE/.test(src)) {
      offenders.push(path.relative(TUI_DIR, f));
    }
  }
  assert.deepEqual(offenders, [], '四叶草像素表不得在任何其它文件里再定义一份');
});

test('两个渲染器都必须消费共享资产', () => {
  const boot = fs.readFileSync(
    path.join(TUI_DIR, 'ink-components', 'BootScreen.js'),
    'utf8'
  );
  const banner = fs.readFileSync(
    path.join(TUI_DIR, 'ink-components', 'WelcomeBanner.js'),
    'utf8'
  );
  assert.ok(/require\('\.\.\/logoArt'\)/.test(boot), 'BootScreen 必须 require logoArt');
  assert.ok(/require\('\.\.\/logoArt'\)/.test(banner), 'WelcomeBanner 必须 require logoArt');
  assert.ok(/cloverRows\(\)/.test(banner), 'WelcomeBanner 必须走 cloverRows()，不得自持像素表');
});
