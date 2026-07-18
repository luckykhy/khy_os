'use strict';

/**
 * HelpMenu — keyboard shortcut reference, toggled with "?" on an empty prompt.
 * Mirrors Claude Code's PromptInputHelpMenu content, scoped to KHY bindings.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
// 键位单一真源:精简浮层与 /keybindings 完整列举同源此叶子,绝不在此再内联一份。
const keybindingCatalog = require('../../../services/keybindings/keybindingCatalog');

const SHORTCUTS = keybindingCatalog.getEssentialShortcuts();

function HelpMenu() {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const keyWidth = SHORTCUTS.reduce((w, [k]) => Math.max(w, k.length), 0);

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, '键盘快捷键'),
    ...SHORTCUTS.map(([k, d], i) =>
      h(Box, { key: i },
        h(Text, { color: 'cyan' }, k.padEnd(keyWidth + 2)),
        h(Text, { dimColor: true }, d)
      )
    )
  );
}

module.exports = HelpMenu;
