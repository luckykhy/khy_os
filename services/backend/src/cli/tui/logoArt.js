'use strict';

/**
 * logoArt — khy 品牌标记的**唯一资产**（图形 + 字标 + 一句话）。纯叶子：零 IO、确定性、绝不抛、不读 env。
 *
 * 为什么单独成文件（[DESIGN-ARCH-134] §3.4）：
 * 同一份 13×9 像素四叶草原先**复制**在 `ink-components/WelcomeBanner.js` 里（就绪后画一次），
 * 而启动屏 `ink-components/BootScreen.js` 用的是另一套 `╱╲` 图案 —— 同一进程先后出现两种
 * 品牌符号，是 `[DESIGN-ARCH-115]` 登记的 D5 缺陷。本模块把四叶草提成**一份**资产，
 * 两个渲染器各自决定画在哪、画多大；`BootScreen` 与 `WelcomeBanner` 都不再自带像素表。
 *
 * `╱╲` 那套只画出两叶、读不出「四叶」，已随本模块的引入删除 —— 注释不再是谎话。
 *
 * 纪律（与 `cli/startupBeats.js` 头部同）：
 *   - **零 IO**：像素表就是字面量，不读文件、不读 env、不写 console。
 *   - **确定性**：同样的调用永远返回同样的结果。
 *   - **绝不抛**：畸形输入一律回退到安全值（fail-soft）。
 *   - **不改入参、返回新对象**：`cloverRows()` 每次构造新的 cell 对象，调用方可随意改。
 *
 * 字标与 tagline 取自 `utils/ccBrand.js` 的 `BRAND`（它是本仓的品牌文本单一真源，
 * 自述「修改品牌只需改此文件」）。**不再写第二份字面量** —— 代价是 ccBrand 的适用面
 * 从「CC 模式」扩到「品牌文本」，这是刻意的：品牌串漂移比模块归属更贵。
 */

const { BRAND } = require('./utils/ccBrand');

/** 字标。与 `WelcomeBanner.js` 的 `── khy OS vX.X.X ──` 同字面（不再写 `khy-os`：那是仓库目录名）。 */
const WORDMARK = 'khy OS';

/** 一句话说明。复用 `BRAND.tagline`，不写字面量。 */
const TAGLINE = BRAND.tagline;

/**
 * 13 列 × 9 行的块字符像素图。四叶草的 silhouette 有四个凹口（上/下/左/右），
 * 故四个圆叶能读出来，而不是一个 X 或 H。窄腰（第 3–4 行）刻出左右凹口；
 * 半块（▄/▀）圆角；底部一截短茎。**只用单宽 Unicode**。
 * 用 `\uXXXX` 转义而非直接字符：与既有写法一致，且不受编辑器编码影响。
 */
const CLOVER_ART = [
  '\u2584\u2588\u2588\u2584     \u2584\u2588\u2588\u2584',
  '\u2588\u2588\u2588\u2588     \u2588\u2588\u2588\u2588',
  '\u2580\u2588\u2588\u2588\u2588\u2584\u2584\u2584\u2588\u2588\u2588\u2588\u2580',
  '  \u2580\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2580  ',
  '  \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2584  ',
  '\u2584\u2588\u2588\u2588\u2588\u2580\u2580\u2580\u2588\u2588\u2588\u2588\u2584',
  '\u2588\u2588\u2588\u2588     \u2588\u2588\u2588\u2588',
  '\u2580\u2588\u2588\u2580     \u2580\u2588\u2588\u2580',
  '      \u2588      ',
];

/**
 * 逐字符明暗映射（同一 13×9 网格）。三档绿模仿像素画纵深：
 * `D` = 暗边（green + dim）· `M` = 主体（green）· `B` = 高光（greenBright）；空格映射为空格。
 */
const CLOVER_SHADE = [
  'DBBD     DBBD',
  'DBBM     MBBD',
  'DMBBMDDDMBBMD',
  '  DMBBBBBMD  ',
  '  DMBBBBBMD  ',
  'DMBBMDDDMBBMD',
  'DBBM     MBBD',
  'DBBD     DBBD',
  '      D      ',
];

/** 图形尺寸。显式常量而非从数组长度推导 —— 尺寸是设计值，不是实现细节。 */
const CLOVER_COLS = 13;
const CLOVER_ROWS = 9;

/** 合法的明暗档位（`' '` 表示该格不画东西）。 */
const SHADES = Object.freeze(['D', 'M', 'B', ' ']);

/**
 * 把两条表合成「逐行逐格」结构，供渲染器直接消费：`rows[i][j] = { ch, shade }`。
 *
 * 两个渲染器（启动屏 / 欢迎横幅）原先各自解析一遍 shade 表 —— 同一段映射写两处就会漂移。
 * 这里收成唯一一份，两边都调它。
 *
 * @returns {Array<Array<{ch: string, shade: string}>>} 新数组 + 新对象；绝不返回内部引用。
 */
function cloverRows() {
  const rows = [];
  for (let i = 0; i < CLOVER_ART.length; i++) {
    const line = String(CLOVER_ART[i] || '');
    const shadeLine = String(CLOVER_SHADE[i] || '');
    const cells = [];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      // 空格不参与着色；档位缺失/非法一律回退到主体色（fail-soft）。
      const raw = shadeLine[j];
      const shade = ch === ' ' ? ' ' : SHADES.indexOf(raw) >= 0 && raw !== ' ' ? raw : 'M';
      cells.push({ ch, shade });
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = {
  WORDMARK,
  TAGLINE,
  CLOVER_ART,
  CLOVER_SHADE,
  CLOVER_COLS,
  CLOVER_ROWS,
  SHADES,
  cloverRows,
};
