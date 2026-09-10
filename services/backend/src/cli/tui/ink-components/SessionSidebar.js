'use strict';

/**
 * SessionSidebar — left-hand session list aligned with preview-home.html #sidebar.
 *
 * Shows sessions grouped by relative date (今天 / 昨天 / 更早). Each item has a
 * colored avatar, name, meta line, and a status dot (green = running, gray = idle).
 * Clicking a session item calls onSelect(sessionId).
 *
 * Data is passed in as `groups` (array of { title, items }) so the parent controls
 * the source (conversations, session forest, etc.). This component is pure presentational.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

const COLOR_BG = '#20201e';
const COLOR_ACTIVE_BG = '#302f2b';
const COLOR_TEXT = '#d9d9d4';
const COLOR_DIM = '#85847d';
const COLOR_GREEN = '#4ea96a';

// Deterministic color from a session id → avatar background.
const AVATAR_COLORS = ['#6a92d8', '#4ea96a', '#c9a24a', '#d9635b', '#7b5fc0', '#2ec4d5'];
function avatarColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function SessionSidebar({ groups = [], activeId = '', onSelect = () => {}, width = 22 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      height: '100%',
      backgroundColor: COLOR_BG,
      borderStyle: 'round',
      borderColor: '#34332f',
      flexShrink: 0,
    },
    // Header
    h(
      Box,
      { paddingX: 1, paddingY: 1, justifyContent: 'space-between', alignItems: 'center' },
      h(Text, { bold: true, color: COLOR_DIM, dim: true }, '会话'),
      h(
        Box,
        { onClick: () => onSelect('__new'), onMouseUp: () => onSelect('__new') },
        h(Text, { color: COLOR_DIM }, '+ 新建')
      )
    ),
    // Session groups
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
      ...groups.flatMap((group) => [
        h(
          Text,
          { key: `g-${group.title}`, bold: true, color: COLOR_DIM, dim: true, marginTop: 1 },
          group.title
        ),
        ...group.items.map((s) => {
          const active = s.id === activeId;
          return h(
            Box,
            {
              key: s.id,
              paddingX: 1,
              marginY: 0,
              backgroundColor: active ? COLOR_ACTIVE_BG : undefined,
              onClick: () => onSelect(s.id),
              onMouseUp: () => onSelect(s.id),
            },
            // Avatar
            h(
              Text,
              { backgroundColor: avatarColor(s.id), color: '#fff', bold: true },
              ' ' + (s.avatar || s.name.slice(0, 1).toUpperCase()) + ' '
            ),
            // Name + meta
            h(
              Box,
              { flexDirection: 'column', flexGrow: 1, marginLeft: 1 },
              h(Text, { color: COLOR_TEXT, bold: active }, truncate(s.name, width - 8)),
              h(Text, { color: COLOR_DIM, dim: true }, truncate(s.meta || '', width - 8))
            ),
            // Status dot
            h(Text, { color: s.running ? COLOR_GREEN : COLOR_DIM }, s.running ? '●' : '○')
          );
        }),
      ])
    ),
  );
}

function truncate(s, max) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, Math.max(1, max - 1)) + '…';
}

module.exports = SessionSidebar;
module.exports.avatarColor = avatarColor;
