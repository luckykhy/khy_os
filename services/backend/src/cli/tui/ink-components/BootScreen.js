'use strict';

/**
 * BootScreen — startup loading animation shown while the TUI initializes.
 *
 * Renders a short sequence of initialization steps with a braille spinner.
 * Once all steps complete the parent replaces BootScreen with the main UI.
 *
 * Gate KHY_BOOT_SCREEN (default on). Off → parent skips this component and
 * renders the main UI directly (byte-identical legacy startup).
 *
 * Steps are derived from the actual async work in app.js / App.js:
 *   1. Load ink runtime
 *   2. Initialize gateway
 *   3. Load session state
 *   4. Ready
 */

const React = require('react');
const inkRuntime = require('../inkRuntime');
const Spinner = require('./Spinner');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

const STEPS = [
  { id: 'ink',    label: '加载渲染引擎',   icon: '◈' },
  { id: 'gateway', label: '连接 AI 网关',   icon: '◇' },
  { id: 'session', label: '恢复会话状态',   icon: '◆' },
  { id: 'ready',   label: '准备就绪',       icon: '✓' },
];

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isBootScreenEnabled(env = process.env) {
  const v = String(env && env.KHY_BOOT_SCREEN || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * Track which boot steps have completed. Each step transitions from
 * `pending → loading → done` as the async work progresses.
 */
function BootScreen({ steps = [] }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const [frame, setFrame] = React.useState(0);
  const [currentStep, setCurrentStep] = React.useState(0);

  // Braille spinner animation
  React.useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // Advance step when caller marks one complete
  React.useEffect(() => {
    // Find the first pending step after currentStep
    const nextPending = steps.findIndex((s, i) => i >= currentStep && !s.done);
    if (nextPending >= 0) {
      setCurrentStep(nextPending);
    }
  }, [steps, currentStep]);

  // Build step rows
  const stepRows = STEPS.map((step, i) => {
    const stepDone = i < currentStep || (steps[i] && steps[i].done);
    const stepActive = i === currentStep && !stepDone;

    let status = '';
    if (stepDone) {
      status = h(Text, { color: 'green', dimColor: false }, ' ✓');
    } else if (stepActive) {
      status = h(Text, { color: 'cyan' }, ' ' + FRAMES[frame]);
    } else {
      status = h(Text, { dimColor: true }, ' ·');
    }

    const color = stepDone ? 'green' : stepActive ? 'cyan' : 'gray';
    const dim = !stepActive && !stepDone;

    return h(
      Box,
      { key: step.id },
      h(Text, { dimColor: dim }, '  '),
      h(Text, { dimColor: dim, color }, step.icon + ' '),
      h(Text, { dimColor: dim, color }, step.label),
      status
    );
  });

  // Title art: khy-os clover silhouette (compact, single-width chars)
  const titleArt = [
    '  ╱╲    ╱╲  ',
    ' ╱  ╲  ╱  ╲ ',
    ' ╲  ╱  ╲  ╱ ',
    '  ╲╱    ╲╱  ',
    '   khy-os    ',
  ];

  const artRows = titleArt.map((line, i) =>
    h(Text, { key: `art-${i}`, color: 'green', bold: i === 4 ? true : false, dimColor: i < 4 }, line)
  );

  return h(
    Box,
    {
      flexDirection: 'column',
      paddingX: 2,
      paddingY: 1,
    },
    // Logo art
    ...artRows,
    h(Text, null, ''),
    // Divider
    h(Text, { color: 'green', dimColor: true }, '─'.repeat(14)),
    h(Text, null, ''),
    // Steps
    ...stepRows,
    h(Text, null, ''),
  );
};

/**
 * Create a boot-step tracker. Each call to `done(stepId)` marks that step
 * complete and advances the visual indicator.
 *
 * @returns {{ done: (id: string) => void, steps: Array }}
 */
function createBootTracker() {
  const state = STEPS.map((s) => ({ ...s, done: false }));
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(state));

  return {
    get steps() {
      return state.slice();
    },
    done(id) {
      const step = state.find((s) => s.id === id);
      if (step && !step.done) {
        step.done = true;
        notify();
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { BootScreen, createBootTracker, isBootScreenEnabled, STEPS };
