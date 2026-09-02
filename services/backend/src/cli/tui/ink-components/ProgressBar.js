'use strict';

/**
 * ProgressBar — sticky single-line progress indicator for the live region.
 *
 * Used by openModelPicker to show buildGatewayModelChoices phase progress
 * (sync / init / probe / listModels) without flooding the transcript. Renders
 * one row: a 16-cell bar + percent + (current/total) + a free-form label
 * (e.g. "探测通道 (3/18) kiro"). Bar colour tracks phase:
 *   - init/sync      cyan (early phase)
 *   - probe          yellow (mid)
 *   - listModels     green  (finalising)
 *   - done           green  ✓
 *
 * Updated on every onProgress tick from gatewayModelChoices.js; the
 * parent (App.js) clears `gatewayProgress` state when the build resolves
 * so this row is unmounted before the ModelPicker takes over.
 */
const React = require('react');
const h = React.createElement;
const inkRuntime = require('../inkRuntime');

const BAR_WIDTH = 16;
const PHASE_COLORS = {
  sync: 'cyan',
  init: 'cyan',
  probe: 'yellow',
  listModels: 'green',
  done: 'green',
};

function renderBar(current, total) {
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const filled = Math.round(ratio * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function ProgressBar({ progress }) {
  const { Text, Box } = inkRuntime.get();
  const p = progress || {};
  const phase = String(p.phase || 'init');
  const current = Number(p.current) || 0;
  const total = Number(p.total) || 1;
  const label = String(p.label || phase);
  const color = PHASE_COLORS[phase] || 'gray';
  const percent = Math.round((current / (total > 0 ? total : 1)) * 100);

  return h(
    Box,
    { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
    h(Text, { color }, '⏳ '),
    h(Text, { color }, renderBar(current, total)),
    h(Text, { color }, ` ${String(percent).padStart(3)}% `),
    h(Text, { dimColor: true }, label),
  );
}

module.exports = ProgressBar;
