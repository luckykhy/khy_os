'use strict';

/**
 * CcAssistantMessage.js —— CC 风格助手消息
 *
 * 设计：
 * - 以 ● (U+25CF) 前缀开头
 * - 纯文本流式渲染
 * - 支持 Markdown 内容（简化为纯文本）
 * - marginTop=1 对齐 CC 视觉节奏
 *
 * 参考：[DESIGN-ARCH-081] Phase 3: 消息显示格式
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const BLACK_CIRCLE = '●'; // U+25CF

/**
 * CC 风格助手消息
 */
function CcAssistantMessage({ text, isStreaming = false }) {
  if (!text) return null;

  const lines = text.split('\n');

  return (
    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      lines.map((line, i) => (
        React.createElement(Box, { key: i },
          i === 0
            ? React.createElement(React.Fragment, null,
                React.createElement(Text, { color: CC_COLORS.dimColor }, BLACK_CIRCLE),
                React.createElement(Text, null, ' ' + line),
              )
            : React.createElement(Text, null, '  ' + line), // 对齐 ● + 空格
        )
      ))
    )
  );
}

/**
 * 流式助手消息（带光标闪烁效果）
 */
function CcStreamingMessage({ text }) {
  const [showCursor, setShowCursor] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setShowCursor(c => !c);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  if (!text) return null;

  return (
    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      React.createElement(Box, null,
        React.createElement(Text, { color: CC_COLORS.dimColor }, BLACK_CIRCLE),
        React.createElement(Text, null, ' ' + text),
        showCursor
          ? React.createElement(Text, { color: CC_COLORS.dimColor, bold: true }, '│')
          : null,
      )
    )
  );
}

module.exports = {
  CcAssistantMessage: React.memo(CcAssistantMessage),
  CcStreamingMessage: React.memo(CcStreamingMessage),
};
