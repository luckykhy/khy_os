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
  updateLine,
  bridge,
  showArt = true,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // 「欢迎你，XXX」中的 XXX：必须显示**当前 khy 登录账号**而不是 OS 用户名。
  // 真源 = cliAuthService.checkSession()，读 ~/.khyquant/session.json 的 username 字段。
  // 回退链：未登录 → OS 用户名(USER/USERNAME)→ 'user'，保证不出现"账号空"或抛错。
  // 全部包 try/catch：cliAuthService 不可用/IO 异常时落到 OS 用户名，不炸 banner。
  let _greetingName = process.env.USER || process.env.USERNAME || 'user';
  try {
    const cliAuth = require('../../../services/cliAuthService');
    if (cliAuth && typeof cliAuth.checkSession === 'function') {
      const session = cliAuth.checkSession();
      if (session && session.loggedIn && session.username) {
        _greetingName = session.username;
      }
    }
  } catch {
    /* keep OS-user fallback */
  }

  // 协作链接行——与 FooterBar 的 bridgeLine 同口径(SSOT:bridge.getStatusSnapshot)。
  // 启动横幅只渲染一次(static 区),banner 上看不到协作信息就一直看不到——补这一行让用户
  // 首屏就能拿到 URL/PIN/端数。未运行则整行省略,绝不显示占位。
  // 关键时序:App 把 bridgeStatus 初始化延迟到 useEffect(避免阻塞首帧),所以首帧 banner
  // 拿到的是 null/falsy;这里再做一次同步回退——直接调一次 snapshot,绝不在 banner 上留空白。
  // bridge module 不可用/异常 → 不抛、不显示占位,只走「未运行」分支。
  let _bridge = bridge;
  if (!_bridge) {
    try {
      const bridgeServer = require('../../../bridge/bridgeServer');
      if (bridgeServer && typeof bridgeServer.getStatusSnapshot === 'function') {
        _bridge = bridgeServer.getStatusSnapshot();
      }
    } catch {
      _bridge = null;
    }
  }
  const bridgeLine =
    _bridge && _bridge.running
      ? h(
          Box,
          null,
          h(Text, { color: 'magenta' }, '🔗 协作 '),
          h(Text, { color: 'green' }, _bridge.url || ''),
          _bridge.pin ? h(Text, { dimColor: true }, '  PIN ') : null,
          _bridge.pin ? h(Text, { color: 'cyan', bold: true }, _bridge.pin) : null,
          h(Text, { dimColor: true }, `  ${_bridge.clientCount || 0} 端`),
          _bridge.tokenShort ? h(Text, { dimColor: true }, `  ${_bridge.tokenShort}…`) : null
        )
      : null;

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
      h(Text, { bold: true, color: 'green' }, _greetingName)
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
      h(Text, { dimColor: true }, `网关：${gatewayAdapters || 0} 个适配器就绪`),
      // 协作链接：与 FooterBar 同源(bridge.getStatusSnapshot),首屏可见。
      bridgeLine,
      // 更新时间与来源：无法确定来源时整行省略，绝不显示占位或猜测值。
      // 追加在「状态」区末尾（版本行之后），故 ROWS_BEFORE_VERSION 保持 0。
      updateLine ? h(Text, { dimColor: true }, `更新：${updateLine}`) : null
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
