'use strict';

/**
 * ThreeColumnLayout — the preview-home.html three-column shell, built ENTIRELY
 * from the project's existing leaf components. This is a PARALLEL layout path:
 * App.js chooses between its legacy single-column render and this one via the
 * `threeColumnMode` flag, so the legacy path stays 100% untouched.
 *
 * Structure (mirrors preview-home.html):
 *   <column>
 *     <Topbar />
 *     <row flexGrow>
 *       <SessionSidebar />
 *       <ChatColumn />         — transcript + streaming + task panel + prompt
 *       <RightPanel />         — plan / tasks / terminal / files tabs
 *     </row>
 *     <Statusbar />
 *     {overlays}              — full-screen overlays rendered on top
 *   </column>
 *
 * All interactive state (scroll offsets, active tab, session selection) lives in
 * App and is passed through here, so this component is presentational.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

const Topbar = require('./Topbar');
const Statusbar = require('./Statusbar');
const SessionSidebar = require('./SessionSidebar');
const RightPanel = require('./RightPanel');
const ChatColumn = require('./ChatColumn');

function ThreeColumnLayout(props) {
  const { Box } = inkRuntime.get();
  const h = React.createElement;

  const {
    // Topbar
    title = 'KhyOS Desktop',
    provider = '',
    model = '',
    onSearch,
    onSettings,
    // Session sidebar
    sessionGroups = [],
    activeSessionId = '',
    onSelectSession,
    // Right panel
    rightPanelTab = 'plan',
    onTabChange,
    rightPanelScroll = 0,
    onRightPanelScroll,
    rightPanelFocused = false,
    plan = null,
    taskLines = [],
    terminalOutput = '',
    terminalPrompt = '$',
    files = [],
    rightPanelViewport = 12,
    // Statusbar
    status = {},
    // Center chat (prop bag forwarded to ChatColumn)
    chat = {},
    // Overlays (React nodes rendered full-screen on top)
    overlays = null,
  } = props;

  return h(
    Box,
    { flexDirection: 'column', height: '100%' },
    // ── Topbar ──
    h(Topbar, {
      model,
      provider: provider || model,
      onSearch,
      onSettings,
    }),
    // ── Middle row: sidebar | chat | right panel ──
    h(
      Box,
      { flexDirection: 'row', flexGrow: 1, overflow: 'hidden' },
      // Left: session sidebar
      h(SessionSidebar, {
        groups: sessionGroups,
        activeId: activeSessionId,
        onSelect: onSelectSession,
        width: 22,
      }),
      // Center: chat surface
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
        h(ChatColumn, chat)
      ),
      // Right: tabbed panel
      h(RightPanel, {
        activeTab: rightPanelTab,
        onTabChange,
        focused: rightPanelFocused,
        plan,
        taskLines,
        terminalOutput,
        terminalPrompt,
        files,
        viewportHeight: rightPanelViewport,
        scrollOffset: rightPanelScroll,
        onScroll: onRightPanelScroll,
      })
    ),
    // ── Statusbar ──
    h(Statusbar, status),
    // ── Overlays (full-screen, on top) ──
    overlays || null
  );
}

module.exports = ThreeColumnLayout;
