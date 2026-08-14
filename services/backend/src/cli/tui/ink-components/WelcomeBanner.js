'use strict';

/**
 * WelcomeBanner — startup header with version, model, auth info.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

// Rows the banner renders BEFORE the version line (`── khy OS vX.X.X ──`).
// Single source of truth for App.js sidebar top-alignment: the sidebar's
// first row must share a terminal row with the version line, so App offsets
// the sidebar by exactly this many rows. Currently the version line IS the
// banner's first rendered row → 0. Keep in sync with the render tree below.
const ROWS_BEFORE_VERSION = 0;

/**
 * Pure: number of banner rows rendered above the version line inside the
 * Ink live region. Never throws.
 * @returns {number}
 */
function bannerRowsBeforeVersion() {
  return ROWS_BEFORE_VERSION;
}

// "khyos lucky clover" art — compact pixel-art four-leaf clover.
// The silhouette has FOUR concave notches (top / bottom / left / right) so
// the four rounded lobes read clearly as a clover rather than an X or H.
// A narrow waist (rows 3-4) carves the side notches; half-blocks (▄/▀)
// round every corner; a short stem anchors the bottom.
// Single-width Unicode ONLY. Dimensions: 13 cols × 9 rows.
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
// Per-character shade map (same 13×9 grid). Three green tones mimic the
// depth of pixel art: D = dark edge (green+dim), M = mid body (green),
// B = bright highlight (greenBright). Spaces map to spaces.
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

function WelcomeBanner({
  version,
  model,
  adapter,
  authMethod,
  contextWindow,
  gatewayAdapters,
  showArt = true,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // Left column: the original banner content, byte-identical to before.
  const left = h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, `── khy OS v${version || '0.0.0'} ──`),
    h(Text, null, ''),
    h(
      Box,
      null,
      h(Text, { bold: true }, '欢迎你，'),
      h(Text, { bold: true, color: 'green' }, process.env.USER || process.env.USERNAME || 'user')
    ),
    h(Text, null, ''),
    h(
      Box,
      { flexDirection: 'column', marginLeft: 2 },
      h(Text, null, h(Text, { color: 'yellow' }, '系统')),
      h(
        Text,
        { dimColor: true },
        `认证：${authMethod || 'API 密钥'}` + (contextWindow ? ` · 上下文：${contextWindow}` : '')
      ),
      h(Text, null, ''),
      h(Text, null, h(Text, { color: 'yellow' }, '状态')),
      h(Text, { dimColor: true }, `网关：${gatewayAdapters || 0} 个适配器就绪`)
    ),
    h(Text, null, ''),
    h(
      Text,
      { dimColor: true },
      `${model || 'auto'}::${adapter || 'auto'} · 工作目录：${process.cwd()}`
    )
  );

  // Right column: compact clover with three-tone green shading for depth.
  // Shade map drives colour: D = dark edge (dim green), M = mid body (green),
  // B = bright highlight (greenBright). Falls back to mid green if unmapped.
  const art = showArt
    ? h(
        Box,
        { flexDirection: 'column', marginLeft: 4 },
        ...CLOVER_ART.map((line, i) =>
          h(
            Text,
            { key: `clover-${i}` },
            ...line.split('').map((ch, j) => {
              if (ch === ' ') {
                return h(Text, { key: `c${i}-${j}` }, ' ');
              }
              const shade = (CLOVER_SHADE[i] && CLOVER_SHADE[i][j]) || 'M';
              if (shade === 'B') {
                return h(Text, { key: `c${i}-${j}`, color: 'greenBright' }, ch);
              }
              if (shade === 'D') {
                return h(Text, { key: `c${i}-${j}`, color: 'green', dimColor: true }, ch);
              }
              return h(Text, { key: `c${i}-${j}`, color: 'green' }, ch);
            })
          )
        )
      )
    : null;

  return h(Box, { flexDirection: 'row', marginBottom: 1 }, left, art);
}

module.exports = WelcomeBanner;
module.exports.bannerRowsBeforeVersion = bannerRowsBeforeVersion;
