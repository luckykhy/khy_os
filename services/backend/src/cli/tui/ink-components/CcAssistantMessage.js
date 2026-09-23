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
 *
 * ⚠ 布局约束（[DESIGN-ARCH-124]）：`●` 必须包在 `width:1 / flexShrink:0` 的 Box 里，
 *   不能与正文 Text 直接做兄弟节点。原因：两者做兄弟时，正文一长到接近终端宽度，
 *   yoga 会把 `●` 挤成 0 列 —— 实测（renderToString 对拍）出现两种病态：
 *     1. `●` **整个消失**；
 *     2. 消息块凭空多出 1~2 个空行，且条数不可预测（见本组件的历史探针）。
 *   这不只是视觉瑕疵：它让「屏幕行 → 文本」的投影无法成立（行号对不上），
 *   而拖选复制依赖这个不变式（ccMessageProjection 的 `row === index`）。
 *   固定 1 列后布局确定：正文折行宽度恒为 `cols - 1`，● 永不消失、不生空行。
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const BLACK_CIRCLE = '●'; // U+25CF
const STREAM_CURSOR = '│';

/** `●` 固定占 1 列且不参与收缩 —— 见文件头「布局约束」。 */
const Bullet = () =>
  React.createElement(Box, { width: 1, flexShrink: 0 },
    React.createElement(Text, { color: CC_COLORS.dimColor }, BLACK_CIRCLE));

/**
 * CC 风格助手消息
 *
 * `gap` = 消息前的 marginTop 空行。短终端上这一行由 chromeBudget.ccGapPlan
 * 判给帧高（BUG-91），画不画由账本说，不是组件自己定。
 */
function CcAssistantMessage({ text, isStreaming = false, gap = true }) {
  if (!text) return null;

  const lines = text.split('\n');

  return (
    React.createElement(Box, { flexDirection: 'column', marginTop: gap ? 1 : 0 },
      lines.map((line, i) => (
        React.createElement(Box, { key: i },
          i === 0
            ? React.createElement(React.Fragment, null,
                React.createElement(Bullet, null),
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
 *
 * `gap` 同 CcAssistantMessage：思考行前那一空行归 chromeBudget 判（BUG-91）。
 */
function CcStreamingMessage({ text, gap = true }) {
  const [showCursor, setShowCursor] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setShowCursor(c => !c);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  if (!text) return null;

  return (
    React.createElement(Box, { flexDirection: 'column', marginTop: gap ? 1 : 0 },
      React.createElement(Box, null,
        React.createElement(Bullet, null),
        React.createElement(Text, null, ' ' + text),
        // 光标位也固定 1 列：闪烁时只是内容在 '│' 与空之间切换，正文折行宽度
        // 恒为 cols-2，不会因闪烁而重排（投影按「恒有光标」记，见 ccMessageProjection）。
        React.createElement(Box, { width: 1, flexShrink: 0 },
          showCursor
            ? React.createElement(Text, { color: CC_COLORS.dimColor, bold: true }, STREAM_CURSOR)
            : null),
      )
    )
  );
}

module.exports = {
  CcAssistantMessage: React.memo(CcAssistantMessage),
  CcStreamingMessage: React.memo(CcStreamingMessage),
};
