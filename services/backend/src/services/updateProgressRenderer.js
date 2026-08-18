'use strict';

function createProgressRenderer(options = {}) {
  const isTTY = options.isTTY !== undefined ? !!options.isTTY : !!process.stdout.isTTY;
  const streamWidth = Math.max(40, Number(options.streamWidth) || Number(process.stdout.columns) || 80);
  const output = options.output || process.stdout;
  const clock = options.clock || (() => Date.now());
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  let lastLine = '';
  let lastPhase = '';
  let lastAt = 0;

  function text(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
  }

  function render(event = {}) {
    const action = text(event.action || '更新');
    const target = text(event.target || 'KhyOS');
    const phase = text(event.phase || '处理中');
    const completed = Number(event.completed);
    const total = Number(event.total);
    const determinate = Number.isFinite(completed) && Number.isFinite(total) && total > 0;
    const percent = determinate ? Math.min(100, Math.max(0, Math.round(completed * 100 / total))) : 0;
    const barWidth = Math.max(8, Math.min(20, Math.floor(streamWidth / 5)));
    const filled = determinate ? Math.round(barWidth * percent / 100) : 0;
    const quantified = determinate
      ? `${isTTY ? `[${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}] ` : ''}${Math.max(0, completed)}/${total} ${percent}%`
      : text(event.progress || '进行中');
    const rate = Number.isFinite(Number(event.rate)) && Number(event.rate) > 0
      ? ` ${Math.round(Number(event.rate) / 1024)}KiB/s`
      : '';
    const line = `${action} · ${target} · ${phase} · ${quantified}${rate}`;
    const now = Number(clock());
    if (!isTTY && phase === lastPhase && minIntervalMs > 0 && now - lastAt < minIntervalMs &&
        !(Number.isFinite(completed) && Number.isFinite(total) && completed >= total)) return line;
    lastPhase = phase;
    lastAt = now;
    const clipped = line.length > streamWidth - 1 ? `${line.slice(0, streamWidth - 2)}…` : line;
    if (isTTY) {
      output.write(`\r${clipped.padEnd(Math.max(0, streamWidth - 1), ' ')}`);
    } else {
      output.write(`${clipped}\n`);
    }
    lastLine = clipped;
    return clipped;
  }

  function finish(event = {}) {
    const status = text(event.status || '完成');
    const message = text(event.message || '更新流程结束');
    const line = `${status} · ${message}`;
    if (isTTY) output.write(`\r${line.slice(0, streamWidth - 1).padEnd(Math.max(0, streamWidth - 1), ' ')}\n`);
    else output.write(`${line}\n`);
    lastLine = line;
    return line;
  }

  return { render, finish, getLastLine: () => lastLine };
}

module.exports = { createProgressRenderer };
