'use strict';

// componentMemoExports.test — export contract for the React.memo-wrapped TUI
// components (ToolLines / ProcessGroup / Spinner, gate KHY_TUI_COMPONENT_MEMO).
// The memo wrap must NOT break the static-property surface that ProcessGroup
// and unit tests consume via require('./ToolLines').xxx, and the gate-off
// writing must restore plain (function) exports with the same surface.

const test = require('node:test');
const assert = require('node:assert');
const React = require('react');

const TOOL_LINES_PATH = '../../../../src/cli/tui/ink-components/ToolLines';
const PROCESS_GROUP_PATH = '../../../../src/cli/tui/ink-components/ProcessGroup';
const SPINNER_PATH = '../../../../src/cli/tui/ink-components/Spinner';

const TOOL_LINES_STATICS = [
  'buildWriteDiffRows', 'renderDiffRows', 'buildShellDiffRows',
  'looksLikeUnifiedDiff', 'planWordDiffPairs', 'tuiWordDiffEnabled',
  'isShellResult', 'stripInternalControlText', 'errorText', 'summarizeArgs',
  'formatToolDuration', 'toolDurationMs', 'toolHeaderDurationEnabled',
  'buildResultTruncationTag', 'toolResultTruncationTagEnabled',
  'toolsPropsEqual',
];
const PROCESS_GROUP_STATICS = [
  'groupConsecutiveTools', 'groupTimeline', 'statusSummary', 'groupTitle', 'classifyTool',
];
const SPINNER_STATICS = ['buildSpinnerMeta'];

// The gate is read at module-load time, so gate-variation tests must re-require
// with a fresh cache entry (only the component's own entry — deps stay cached).
function freshRequire(relPath, envValue) {
  const abs = require.resolve(relPath);
  const prevCache = require.cache[abs];
  const prevEnv = process.env.KHY_TUI_COMPONENT_MEMO;
  delete require.cache[abs];
  if (envValue === undefined) delete process.env.KHY_TUI_COMPONENT_MEMO;
  else process.env.KHY_TUI_COMPONENT_MEMO = envValue;
  try {
    return require(relPath);
  } finally {
    delete require.cache[abs];
    if (prevCache) require.cache[abs] = prevCache;
    if (prevEnv === undefined) delete process.env.KHY_TUI_COMPONENT_MEMO;
    else process.env.KHY_TUI_COMPONENT_MEMO = prevEnv;
  }
}

function isRenderable(exported) {
  // Plain function component OR a React.memo wrapper — both are accepted by
  // React.createElement.
  if (typeof exported === 'function') return true;
  return !!(exported && exported.$$typeof === Symbol.for('react.memo'));
}

function assertStatics(exported, names, label) {
  for (const name of names) {
    assert.equal(typeof exported[name], 'function', `${label}.${name} must stay a function`);
  }
}

test('default (gate on): exports are memo-wrapped yet renderable, statics reachable', () => {
  const cases = [
    [TOOL_LINES_PATH, TOOL_LINES_STATICS, 'ToolLines'],
    [PROCESS_GROUP_PATH, PROCESS_GROUP_STATICS, 'ProcessGroup'],
    [SPINNER_PATH, SPINNER_STATICS, 'Spinner'],
  ];
  for (const [p, statics, label] of cases) {
    const mod = freshRequire(p, undefined); // default → memo on
    assert.ok(isRenderable(mod), `${label} export must be renderable`);
    assert.equal(mod.$$typeof, Symbol.for('react.memo'), `${label} should be memo-wrapped by default`);
    assert.ok(React.isValidElement(React.createElement(mod)), `${label} must createElement cleanly`);
    assertStatics(mod, statics, label);
  }
});

test('gate off (KHY_TUI_COMPONENT_MEMO=0): plain function exports, statics reachable', () => {
  const cases = [
    [TOOL_LINES_PATH, TOOL_LINES_STATICS, 'ToolLines'],
    [PROCESS_GROUP_PATH, PROCESS_GROUP_STATICS, 'ProcessGroup'],
    [SPINNER_PATH, SPINNER_STATICS, 'Spinner'],
  ];
  for (const [p, statics, label] of cases) {
    const mod = freshRequire(p, '0');
    assert.equal(typeof mod, 'function', `${label} must fall back to a plain component`);
    assert.ok(React.isValidElement(React.createElement(mod)), `${label} must createElement cleanly`);
    assertStatics(mod, statics, label);
  }
});

test('toolsPropsEqual: identity over tool elements, field compare on primitives', () => {
  const ToolLines = require(TOOL_LINES_PATH);
  const eq = ToolLines.toolsPropsEqual;
  const t1 = { name: 'Read' };
  const t2 = { name: 'Bash' };
  // Fresh arrays with the SAME element references → equal (the per-frame
  // array rebuild must not defeat the memo).
  assert.equal(eq({ tools: [t1, t2], expanded: false, live: false }, { tools: [t1, t2], expanded: false, live: false }), true);
  // An immutably-replaced element ({...t}) → not equal (change must render).
  assert.equal(eq({ tools: [t1, t2], expanded: false, live: false }, { tools: [t1, { ...t2 }], expanded: false, live: false }), false);
  // Primitive prop flips → not equal.
  assert.equal(eq({ tools: [t1], expanded: false, live: false }, { tools: [t1], expanded: true, live: false }), false);
  assert.equal(eq({ tools: [t1], expanded: false, live: false }, { tools: [t1], expanded: false, live: true }), false);
  // Length change → not equal.
  assert.equal(eq({ tools: [t1], expanded: false, live: false }, { tools: [t1, t2], expanded: false, live: false }), false);
});
