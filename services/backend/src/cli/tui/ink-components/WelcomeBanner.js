'use strict';

/**
 * WelcomeBanner — startup header with version, model, auth info.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

function WelcomeBanner({ version, model, adapter, authMethod, contextWindow, gatewayAdapters }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { dimColor: true }, `── khy OS v${version || '0.0.0'} ──`),
    h(Text, null, ''),
    h(Box, null,
      h(Text, { bold: true }, '欢迎你，'),
      h(Text, { bold: true, color: 'green' }, process.env.USER || process.env.USERNAME || 'user')
    ),
    h(Text, null, ''),
    h(Box, { flexDirection: 'column', marginLeft: 2 },
      h(Text, null,
        h(Text, { color: 'yellow' }, '系统'),
      ),
      h(Text, { dimColor: true },
        `认证：${authMethod || 'API 密钥'}` +
        (contextWindow ? ` · 上下文：${contextWindow}` : '')
      ),
      h(Text, null, ''),
      h(Text, null, h(Text, { color: 'yellow' }, '状态')),
      h(Text, { dimColor: true },
        `网关：${gatewayAdapters || 0} 个适配器就绪`
      )
    ),
    h(Text, null, ''),
    h(Text, { dimColor: true },
      `${model || 'auto'}::${adapter || 'auto'} · 工作目录：${process.cwd()}`
    )
  );
}

module.exports = WelcomeBanner;
