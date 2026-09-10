'use strict';

/**
 * CcTranscriptView.js — CC 风格转录视图（Claude Code Ctrl+O 对齐）
 *
 * 设计：
 * - 时间戳 + 模型信息 + 可展开工具调用
 * - 每条消息显示发送时间、角色、模型名
 * - 工具调用可展开查看完整参数和结果
 * - 键盘导航：↑/↓ 浏览，Enter 展开/折叠，Esc 关闭
 *
 * 参考：Claude Code Transcript Viewer（Ctrl+O）
 * 对齐：[DESIGN-ARCH-088] 快捷键系统
 */

const React = require('react');
const { Box, Text, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { STATUS_SEPARATOR } = require('../utils/ccLayout');

/**
 * 格式化时间戳
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * 渲染单条消息的工具调用列表
 */
function renderToolSteps(steps, isExpanded) {
  const h = React.createElement;
  if (!steps || steps.length === 0) return null;

  return h(Box, { flexDirection: 'column', marginLeft: 2 },
    h(Text, {
      color: CC_COLORS.dimColor,
      dimColor: !isExpanded,
    }, isExpanded ? `▾ ${steps.length} 个工具调用` : `▸ ${steps.length} 个工具调用`),
    isExpanded
      ? steps.map((step, si) =>
          h(Box, { key: si, marginLeft: 2 },
            h(Text, { color: CC_COLORS.dimColor }, '│ '),
            h(Text, {
              color: step.status === 'error' ? CC_COLORS.error : CC_COLORS.toolName,
            }, step.tool || 'unknown'),
            step.input
              ? h(Text, { color: CC_COLORS.dimColor }, ` ← ${String(step.input).slice(0, 40)}`)
              : null,
            step.result
              ? h(Text, { color: CC_COLORS.dimColor }, ` → ${String(step.result).slice(0, 40)}`)
              : null,
          ),
        )
      : null,
  );
}

/**
 * 转录视图组件
 */
function CcTranscriptView({ messages = [], onClose }) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [expandedTools, setExpandedTools] = React.useState(new Set());

  const msgList = Array.isArray(messages) ? messages : [];

  // 键盘导航
  useInput((input, key) => {
    if (key.escape) {
      onClose?.();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(msgList.length - 1, i + 1));
    }
    if (key.return) {
      // 切换当前消息的工具展开
      setExpandedTools((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) {
          next.delete(selectedIndex);
        } else {
          next.add(selectedIndex);
        }
        return next;
      });
    }
  });

  const h = React.createElement;

  return h(Box, { flexDirection: 'column', flexGrow: 1 },
    // 标题栏
    h(Box, { paddingX: 1, paddingY: 0 },
      h(Text, { bold: true, color: CC_COLORS.brand }, '转录视图'),
      h(Text, { color: CC_COLORS.dimColor }, `  ${msgList.length} 条消息`),
      h(Text, { color: CC_COLORS.dimColor }, '  ·  ↑/↓ 浏览 · Enter 展开工具 · Esc 关闭'),
    ),

    // 消息列表
    h(Box, { flexDirection: 'column', flexGrow: 1, marginTop: 1 },
      msgList.map((msg, idx) => {
        const isSelected = idx === selectedIndex;
        const isExpanded = expandedTools.has(idx);
        const isUser = msg.role === 'user';
        const timestamp = formatTimestamp(msg.timestamp || msg.id);

        return h(Box, {
          key: msg.id || idx,
          flexDirection: 'column',
          paddingX: 1,
          backgroundColor: isSelected ? CC_COLORS.selectedBg : undefined,
        },
          // 消息头：时间戳 + 角色 + 模型
          h(Box, null,
            h(Text, { color: CC_COLORS.dimColor }, timestamp),
            h(Text, { color: CC_COLORS.dimColor }, ' ' + STATUS_SEPARATOR + ' '),
            h(Text, {
              bold: true,
              color: isUser ? CC_COLORS.toolName : CC_COLORS.success,
            }, isUser ? '你' : (msg.model || '小K')),
          ),
          // 消息内容
          h(Box, { marginLeft: 2 },
            h(Text, {
              color: isSelected ? undefined : CC_COLORS.textSecondary,
              dimColor: !isSelected,
            }, msg.content || msg.text || ''),
          ),
          // 工具调用（可展开）
          renderToolSteps(msg.steps, isExpanded),
        );
      }),
    ),
  );
}

module.exports = { CcTranscriptView: React.memo(CcTranscriptView) };
