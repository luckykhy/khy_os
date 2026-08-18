'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressRenderer } = require('../src/services/updateProgressRenderer');

function capture() {
  let value = '';
  return {
    output: { write(chunk) { value += String(chunk); } },
    read: () => value,
  };
}

test('non-TTY progress includes action, target, phase and quantified progress', () => {
  const sink = capture();
  const renderer = createProgressRenderer({ isTTY: false, output: sink.output, clock: () => 1000 });
  renderer.render({ action: '更新', target: 'KhyOS', phase: '下载', completed: 50, total: 100, rate: 2048 });
  assert.equal(sink.read(), '更新 · KhyOS · 下载 · 50/100 50% 2KiB/s\n');
});

test('TTY progress redraws one line with a determinate bar and finish terminates it', () => {
  const sink = capture();
  const renderer = createProgressRenderer({ isTTY: true, streamWidth: 80, output: sink.output });
  renderer.render({ action: '更新', target: 'KhyOS', phase: '下载', completed: 50, total: 100 });
  renderer.finish({ status: '完成', message: '更新已安装 3/3' });
  assert.match(sink.read(), /^\r更新 · KhyOS · 下载 · \[#{8}-{8}\] 50\/100 50%/);
  assert.match(sink.read(), /\r完成 · 更新已安装 3\/3.*\n$/);
});

test('unknown totals remain visibly in progress', () => {
  const sink = capture();
  const renderer = createProgressRenderer({ isTTY: false, output: sink.output });
  renderer.render({ action: '更新', target: 'GitHub Releases', phase: '连接' });
  assert.match(sink.read(), /连接 · 进行中/);
});
