'use strict';

/**
 * ChatColumn — the center chat surface, reusable in both legacy and three-column
 * layouts. Packages: banner+transcript (Static), live streaming, tool cards,
 * spinner, completion, prompt input, and inline footer.
 *
 * This is an EXTRACT of App.js's center content so the same chat experience can
 * render at full width (legacy) or inside a three-column shell. It deliberately
 * excludes the right rail / SidebarPanel (the host layout supplies that) and the
 * outer footer (the host supplies Statusbar in three-column mode).
 *
 * Props mirror the App.js local variables this content consumed. Only the subset
 * actually rendered here is required; pass `null`/`{}` for the rest.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

const { Static } = inkRuntime.get();
const Transcript = require('./Transcript');
const StreamingBlock = require('./StreamingBlock');
const PromptFrame = require('./PromptFrame');
const TaskListPanel = require('./TaskListPanel');
const CompletionMenu = require('./CompletionMenu');
const Spinner = require('./Spinner');
const CompactionProgress = require('./CompactionProgress');
const HelpMenu = require('./HelpMenu');
const PlanApproval = require('./PlanApproval');
const ShellView = require('./ShellView');
const TranscriptView = require('./TranscriptView');
const MemoMessageBlock = Transcript.MessageBlock;

function ChatColumn({
  // Static region
  staticItems = [],
  bannerElement = null,
  expanded = false,
  // Live streaming
  streaming = null,
  status = 'idle',
  reserveRows = null,
  contentWidth = null,
  compacting = false,
  compaction = null,
  // Queue / steer / interrupt
  queueLen = 0,
  queueItems = [],
  steerLen = 0,
  busy = false,
  awaitingUserChoice = false,
  // Overlays hiding chrome
  overlayOwnsLive = false,
  // Tool error selection
  selectedTool = null,
  onToolErrorClick,
  // Plan
  planPhase = null,
  currentPlan = null,
  planGenText = '',
  // Subviews
  shellViewOpen = false,
  shellScroll = 0,
  onShellScroll,
  transcriptOpen = false,
  transcriptView = null,
  transcriptScroll = 0,
  resRows = 0,
  // Input
  value = '',
  offset = 0,
  placeholder = '',
  accent = null,
  vimEnabled = false,
  vimMode = 'INSERT',
  bashMode = false,
  memoryMode = false,
  pendingImages = [],
  onRemovePendingImage,
  mic = null,
  // Completion
  completion = { active: false, items: [] },
  selectedIndex = 0,
  completionPage = 0,
  completionMarginLeft = 0,
  // Hint
  hint = '',
  // Help
  showHelp = false,
  // Task panel
  taskProps = {},
  tasksHidden = false,
  // Context width
  mainCols = null,
  // nowTick
  nowTick = 0,
  // Labels
  turnPhaseLabel = '',
  statusLabel = '',
  liveActivity = '',
  taskActivity = '',
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  return h(
    Box,
    { flexDirection: 'column', flexGrow: 1 },
    // Static transcript + banner
    h(
      Static,
      { items: staticItems },
      (item) => {
        if (item.kind === 'banner') return bannerElement;
        return h(MemoMessageBlock, { key: item.key, msg: item.msg, expanded });
      }
    ),
    // Live region
    h(
      Box,
      { flexDirection: 'column' },
      // Streaming content
      streaming
        ? h(StreamingBlock, {
            streaming,
            status,
            expanded,
            reserveRows,
            contentWidth: mainCols || contentWidth,
            onErrorClick: onToolErrorClick,
          })
        : null,
      status === 'done' ? h(Text, { dimColor: true }, '✱ 完成') : null,
      // Plan surfaces
      planPhase === 'generating' ? h(PlanApproval, { generating: true, genText: planGenText }) : null,
      planPhase === 'reviewing' ? h(PlanApproval, { plan: currentPlan }) : null,
      planPhase === 'executing' ? h(Box, { marginTop: 1 }, h(Spinner, { label: '执行计划中…' })) : null,
      // Shell peek
      shellViewOpen ? h(ShellView, { streaming, scroll: shellScroll }) : null,
      // Transcript view
      transcriptOpen && transcriptView
        ? h(TranscriptView, {
            lines: transcriptView.lines,
            scroll: transcriptScroll,
            showAll: expanded,
            rows: resRows,
          })
        : null,
      // Activity region
      busy && !awaitingUserChoice
        ? compacting
          ? h(CompactionProgress, { compaction })
          : h(
              Box,
              { marginTop: 1, flexDirection: 'column' },
              h(Spinner, { label: turnPhaseLabel || statusLabel }),
              queueLen > 0
                ? h(Text, { dimColor: true }, `  ⧗ ${queueLen} 条待发送`)
                : null,
              steerLen > 0
                ? h(Text, { dimColor: true }, `  ⟳ ${steerLen} 条方向修正待注入`)
                : null
            )
        : null,
      showHelp ? h(HelpMenu, null) : null,
      bashMode ? h(Text, { color: 'magenta' }, '! BASH 模式') : null,
      memoryMode ? h(Text, { color: 'green' }, '# 记忆模式') : null,
      vimEnabled
        ? h(
            Text,
            { color: vimMode === 'NORMAL' ? 'green' : 'yellow', bold: true },
            vimMode === 'NORMAL' ? '-- NORMAL --' : '-- INSERT --'
          )
        : null,
      pendingImages.length > 0
        ? h(
            Box,
            { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
            h(Text, { color: 'blue' }, `📎 已附加 ${pendingImages.length} 张图片`),
          )
        : null,
      // Task panel (full-width, above prompt)
      h(TaskListPanel, {
        key: 'task-panel',
        tick: nowTick,
        ...taskProps,
        ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}),
      }),
      // Completion menu
      completion.active
        ? h(CompletionMenu, {
            completion,
            selectedIndex,
            marginLeft: completionMarginLeft,
            page: completionPage,
          })
        : null,
      hint ? h(Text, { dimColor: true }, hint) : null,
      // Prompt input
      overlayOwnsLive
        ? null
        : h(PromptFrame, {
            value,
            offset,
            busy,
            placeholder,
            accent,
            vimMode: vimEnabled ? vimMode : null,
            mic,
          })
    )
  );
}

// Thin re-export so host can pass the same props App.js used.
module.exports = ChatColumn;
