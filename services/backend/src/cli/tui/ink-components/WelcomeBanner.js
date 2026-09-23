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

// 四叶草像素表已收敛到 `cli/tui/logoArt.js` —— 本组件与启动屏共用**一份**品牌资产
// （[DESIGN-ARCH-134] §3.4；修 [DESIGN-ARCH-115] 登记的 D5：同一进程先后出现两种品牌符号）。
const { cloverRows } = require('../logoArt');

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

  // 使用共享 banner 数据服务（与经典模式同源）
  let greetingName = process.env.USER || process.env.USERNAME || 'user';
  try {
    const { getBannerData } = require('../../bannerDataService');
    const data = getBannerData({ version });
    greetingName = data.greetingName || greetingName;
  } catch {
    /* fallback to OS username */
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
      h(Text, { bold: true, color: 'green' }, greetingName)
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
  // 像素与明暗都来自 `logoArt.cloverRows()`（单一资产）；着色映射与启动屏保持同一份口径。
  const SHADE_COLOR = { D: 'green', M: 'green', B: 'greenBright' };
  const art = showArt
    ? h(
        Box,
        { flexDirection: 'column', marginLeft: 4 },
        ...cloverRows().map((cells, i) =>
          h(
            Text,
            { key: `clover-${i}` },
            ...cells.map((c, j) =>
              c.ch === ' '
                ? h(Text, { key: `c${i}-${j}` }, ' ')
                : h(
                    Text,
                    {
                      key: `c${i}-${j}`,
                      color: SHADE_COLOR[c.shade] || 'green',
                      dimColor: c.shade === 'D',
                    },
                    c.ch
                  )
            )
          )
        )
      )
    : null;

  return h(Box, { flexDirection: 'row', marginBottom: 1 }, left, art);
}

module.exports = WelcomeBanner;
module.exports.bannerRowsBeforeVersion = bannerRowsBeforeVersion;
