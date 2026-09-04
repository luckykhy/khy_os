'use strict';

/**
 * ProgressBar — differentiated progress indicator for the live region.
 *
 * Five visual modes, chosen by the `kind` prop:
 *
 *   kind: 'bytes'   → File download: ████░░░░ 12.4/56.8 MB · 2.1 MB/s
 *   kind: 'stage'   → Multi-phase:   ●●●○○ Step 3/5: Initializing database
 *   kind: 'count'   → Item-based:    ████████░░ 8/18 adapters probed
 *   kind: 'time'    → AI wait:       ⏳ 等待模型响应 (12s · ↓ 3.2k tokens)
 *   kind: 'pulse'   → Indeterminate: ▒▒▒░░░░░░░ Preparing...
 *
 * Props (common):
 *   kind:    'bytes' | 'stage' | 'count' | 'time' | 'pulse'
 *   label:   string — human-readable description
 *   color:   optional override (default per kind)
 *
 * Props (bytes):
 *   current: number — bytes downloaded
 *   total:   number — total bytes
 *   speed:   number — bytes/sec (optional, shows transfer rate)
 *
 * Props (stage):
 *   current: number — current stage (1-based)
 *   total:   number — total stages
 *
 * Props (count):
 *   current: number — items completed
 *   total:   number — total items
 *
 * Props (time):
 *   elapsed: number — milliseconds elapsed
 *   detail:   string — optional extra info (e.g. "↓ 3.2k tokens")
 *
 * Props (pulse):
 *   (none — just label + animation)
 */
const React = require('react');
const h = React.createElement;
const inkRuntime = require('../inkRuntime');

const BAR_WIDTH = 20;

const KIND_DEFAULTS = {
  bytes:  { icon: '↓', color: 'cyan' },
  stage:  { icon: '●', color: 'yellow' },
  count:  { icon: '◆', color: 'green' },
  time:   { icon: '⏳', color: 'magenta' },
  pulse:  { icon: '⏳', color: 'cyan' },
};

// Pulse frames for indeterminate progress.
const PULSE_FRAMES = [
  '░░░░░░░░░░░░░░░░░░░░',
  '▒░░░░░░░░░░░░░░░░░░░',
  '▒▒░░░░░░░░░░░░░░░░░░',
  '▒▒▒░░░░░░░░░░░░░░░░░',
  '░▒▒▒░░░░░░░░░░░░░░░░',
  '░░▒▒▒░░░░░░░░░░░░░░░',
  '░░░▒▒▒░░░░░░░░░░░░░░',
  '░░░░▒▒▒░░░░░░░░░░░░░',
  '░░░░░▒▒▒░░░░░░░░░░░░',
  '░░░░░░▒▒▒░░░░░░░░░░░',
  '░░░░░░░▒▒▒░░░░░░░░░░',
  '░░░░░░░░▒▒▒░░░░░░░░░',
  '░░░░░░░░░▒▒▒░░░░░░░░',
  '░░░░░░░░░░▒▒▒░░░░░░░',
  '░░░░░░░░░░░▒▒▒░░░░░░',
  '░░░░░░░░░░░░▒▒▒░░░░░',
  '░░░░░░░░░░░░░▒▒▒░░░░',
  '░░░░░░░░░░░░░░▒▒▒░░░',
  '░░░░░░░░░░░░░░░▒▒▒░░',
  '░░░░░░░░░░░░░░░░▒▒▒░',
  '░░░░░░░░░░░░░░░░░▒▒▒',
  '░░░░░░░░░░░░░░░░░░▒▒',
  '░░░░░░░░░░░░░░░░░░░▒',
  '░░░░░░░░░░░░░░░░░░░░',
];

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderBar(ratio, width = BAR_WIDTH) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function ProgressBar(props) {
  const { Text, Box } = inkRuntime.get();
  const kind = props.kind || 'pulse';
  const defaults = KIND_DEFAULTS[kind] || KIND_DEFAULTS.pulse;
  const label = String(props.label || '');
  const color = props.color || defaults.color;

  if (kind === 'bytes') {
    const current = Number(props.current) || 0;
    const total = Number(props.total) || 0;
    const speed = Number(props.speed) || 0;
    const ratio = total > 0 ? current / total : 0;
    const percent = Math.round(ratio * 100);
    const speedStr = speed > 0 ? ` · ${formatSpeed(speed)}` : '';
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, renderBar(ratio)),
      h(Text, { color }, ` ${formatBytes(current)}/${formatBytes(total)}`),
      h(Text, { dimColor: true }, ` (${percent}%${speedStr}) ${label}`),
    );
  }

  if (kind === 'stage') {
    const current = Math.max(1, Number(props.current) || 1);
    const total = Math.max(1, Number(props.total) || 1);
    const filled = '●'.repeat(current - 1) + '●';
    const empty = '○'.repeat(total - current);
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${filled}${empty} `),
      h(Text, { dimColor: true }, `Step ${current}/${total}: ${label}`),
    );
  }

  if (kind === 'count') {
    const current = Number(props.current) || 0;
    const total = Number(props.total) || 0;
    const ratio = total > 0 ? current / total : 0;
    const percent = Math.round(ratio * 100);
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, renderBar(ratio)),
      h(Text, { color }, ` ${current}/${total}`),
      h(Text, { dimColor: true }, ` ${label} (${percent}%)`),
    );
  }

  if (kind === 'time') {
    const elapsed = Number(props.elapsed) || 0;
    const detail = props.detail ? ` · ${props.detail}` : '';
    return h(
      Box,
      { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
      h(Text, { color }, `${defaults.icon} `),
      h(Text, { color }, `${formatTime(elapsed)}`),
      h(Text, { dimColor: true }, ` ${label}${detail}`),
    );
  }

  // kind === 'pulse' (indeterminate)
  const frameIdx = Math.floor(Date.now() / 100) % PULSE_FRAMES.length;
  return h(
    Box,
    { flexDirection: 'row', marginTop: 1, marginBottom: 1 },
    h(Text, { color }, `${defaults.icon} `),
    h(Text, { color }, PULSE_FRAMES[frameIdx]),
    h(Text, { dimColor: true }, ` ${label}`),
  );
}

module.exports = ProgressBar;
