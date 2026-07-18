/**
 * Startup Profiler — nanosecond-precision timing checkpoints.
 *
 * Measures each startup phase so bottlenecks are visible.
 * Enabled in development by default; in production only when STARTUP_PROFILE=1.
 *
 * Usage:
 *   const { checkpoint } = require('./startupProfiler');
 *   checkpoint('entry');
 *   // ... work ...
 *   checkpoint('init:done');
 *   printSummary(); // prints delta table to stderr
 */

const enabled = process.env.STARTUP_PROFILE === '1';

const _origin = process.hrtime.bigint();
const _checkpoints = []; // [{ label, ns }]

/**
 * Record a named timing checkpoint.
 * No-op when profiling is disabled (zero overhead in production).
 */
function checkpoint(label) {
  if (!enabled) return;
  _checkpoints.push({ label, ns: process.hrtime.bigint() });
}

/**
 * Get all checkpoints as { label, ms } relative to process start.
 */
function getTimeline() {
  return _checkpoints.map((cp) => ({
    label: cp.label,
    ms: Number(cp.ns - _origin) / 1e6,
  }));
}

/**
 * Print a human-readable startup timeline table to stderr.
 * Shows each checkpoint, elapsed time from start, and delta from previous.
 */
function printSummary() {
  if (_checkpoints.length === 0) return;

  const lines = getTimeline();
  const header = '  Startup Profile';
  const sep = '  ' + '─'.repeat(52);

  process.stderr.write('\n' + header + '\n' + sep + '\n');

  for (let i = 0; i < lines.length; i++) {
    const { label, ms } = lines[i];
    const delta = i === 0 ? ms : ms - lines[i - 1].ms;
    const elapsed = ms.toFixed(1).padStart(8);
    const deltaStr = ('+' + delta.toFixed(1)).padStart(8);
    process.stderr.write(
      `  ${elapsed}ms ${deltaStr}ms  ${label}\n`
    );
  }

  process.stderr.write(sep + '\n\n');
}

/**
 * Clear all recorded checkpoints.
 */
function reset() {
  _checkpoints.length = 0;
}

module.exports = { checkpoint, getTimeline, printSummary, reset };
