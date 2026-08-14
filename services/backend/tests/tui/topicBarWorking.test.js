'use strict';

/**
 * topicBarWorking.test.js — 接线契约:topicBar 把窗口标题(OSC 0)在空闲时前缀静态 ✱,
 * 在 setWorking(true) 时改用左右弹跳的小点并随定时器推进帧;setWorking(false) 回落静态 ✱。
 * 门控关(KHY_TOPIC_BAR_WORKING_DOT=0)→ 标题恒 `✱ ${topic}`(逐字节回退)。
 *
 * 手法:用假 TTY stdout 捕获写入的 OSC 序列(零真实终端),直接调 enable/setTitle/setWorking。
 * 定时器用 unref 的真实 setInterval,故用轮询等一帧;避免依赖 Date/随机。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BAR = path.join(__dirname, '../../src/cli/tui/runtime/topicBar');

function freshTopicBar() {
  // Reset module state between cases by clearing the require cache.
  delete require.cache[require.resolve(BAR)];
  return require(BAR);
}

function fakeStdout() {
  const writes = [];
  return {
    isTTY: true,
    write(s) { writes.push(String(s)); return true; },
    _writes: writes,
    last() { return writes.length ? writes[writes.length - 1] : ''; },
    joined() { return writes.join(''); },
  };
}

// Parse the topic text out of the last OSC-0 write: `\x1b]0;<TITLE>\x07`.
function lastTitle(out) {
  const m = /\x1b\]0;([\s\S]*?)\x07/g;
  let title = '';
  let r;
  const s = out.joined();
  while ((r = m.exec(s)) !== null) title = r[1];
  return title;
}

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('idle: title is prefixed with the static ✱ sun', () => {
  withEnv('KHY_NO_TOPIC_BAR', undefined, () => {
    const bar = freshTopicBar();
    const out = fakeStdout();
    assert.equal(bar.enable(out), true);
    bar.setTitle('陷入死循环');
    assert.equal(lastTitle(out), '✱ 陷入死循环');
    bar.disable();
  });
});

test('working ON: title glyph switches to the bouncing dot (no longer ✱)', () => {
  withEnv('KHY_NO_TOPIC_BAR', undefined, () => {
    const bar = freshTopicBar();
    const out = fakeStdout();
    bar.enable(out);
    bar.setTitle('修复中');
    bar.setWorking(true);
    const t = lastTitle(out);
    assert.ok(t.endsWith('修复中'), `title keeps the topic, got: ${JSON.stringify(t)}`);
    assert.ok(!t.startsWith('✱'), `working title must not start with the sun, got: ${JSON.stringify(t)}`);
    assert.ok(/·/.test(t), `working title contains the moving dot, got: ${JSON.stringify(t)}`);
    bar.setWorking(false);
    // Back to static sun once idle.
    assert.equal(lastTitle(out), '✱ 修复中');
    bar.disable();
  });
});

test('working animation advances the frame over time (timer drives repaint)', async () => {
  await withEnv('KHY_NO_TOPIC_BAR', undefined, async () => {
    const bar = freshTopicBar();
    const out = fakeStdout();
    bar.enable(out);
    bar.setTitle('工作');
    bar.setWorking(true);
    const first = lastTitle(out);
    // Wait past a couple of animation ticks (cadence ~180ms).
    await sleep(420);
    const seen = new Set();
    const re = /\x1b\]0;([\s\S]*?)\x07/g;
    let r;
    const s = out.joined();
    while ((r = re.exec(s)) !== null) seen.add(r[1]);
    bar.setWorking(false);
    bar.disable();
    // More than one distinct frame emitted → the dot actually moved.
    assert.ok(seen.size >= 2, `expected multiple animation frames, saw ${seen.size}`);
    assert.ok(first.endsWith('工作'));
  });
});

test('gate OFF (KHY_TOPIC_BAR_WORKING_DOT=0): working stays byte-identical static ✱', async () => {
  await withEnv('KHY_NO_TOPIC_BAR', undefined, async () => {
    await withEnv('KHY_TOPIC_BAR_WORKING_DOT', '0', async () => {
      const bar = freshTopicBar();
      const out = fakeStdout();
      bar.enable(out);
      bar.setTitle('无动画');
      bar.setWorking(true);
      assert.equal(lastTitle(out), '✱ 无动画');
      // No timer should have started → no new frames after a wait.
      const countBefore = out._writes.length;
      await sleep(300);
      assert.equal(out._writes.length, countBefore, 'gate off → no animation writes');
      bar.setWorking(false);
      assert.equal(lastTitle(out), '✱ 无动画');
      bar.disable();
    });
  });
});

test('disable() stops the animation timer (no writes after teardown)', async () => {
  await withEnv('KHY_NO_TOPIC_BAR', undefined, async () => {
    const bar = freshTopicBar();
    const out = fakeStdout();
    bar.enable(out);
    bar.setTitle('t');
    bar.setWorking(true);
    bar.disable();
    const countAfterDisable = out._writes.length;
    await sleep(300);
    assert.equal(out._writes.length, countAfterDisable, 'disabled → timer stopped, no further writes');
  });
});
