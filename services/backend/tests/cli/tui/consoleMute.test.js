'use strict';

/**
 * consoleMute — 「内部日志别再打在 live 帧上」这条契约（BUG-13，node:test）。
 *
 * 现象（活体 s-29）：`2026-09-19 15:45:35 [warn] [rtkInstaller] no install method
 * succeeded; …` 直接印在状态栏下方，英文、还擦不掉。
 *
 * 病因不是 ink 的 patchConsole（那是第一版的猜测，读了 patch-console 源码后作废）：
 * winston 的 Console transport 写 `console._stdout.write` / `console._stderr.write`
 * （node_modules/winston/lib/winston/transports/console.js），而 patch-console 只替换
 * `console.log/warn/…` 这 18 个**方法**、不碰 `console._stdout` ⇒ 日志字节绕开 ink
 * 注入的 stdout 流**和它的帧高账本**，`eraseLines` 永远擦不到它。
 * 实测存证：.khy/feedback/tui-ux-audit-20260919/T/repro-before.txt（真 stdio 收到
 * 70 字节、注入流增量 0、lastOutputHeight 1→1）。
 *
 * 守的六条：
 *   C1 端到端真通道：静音后 logger.warn 不落终端；恢复后同样的 warn 照落。
 *   C2 只动音量不动记录：静音不碰文件 transport。
 *   C3 逃生阀：KHY_TUI_CONSOLE_LOG=1 逐字节回退旧行为。
 *   C4 能力缺失/门面畸形绝不抛（音量调节不得拖垮启动路径）。
 *   C5 恢复如实回原级别，而不是把 'silent' 留在地上。
 *   C6 接线：app.js 在 mount 前静音、退出时恢复、硬退出有 'exit' 兜底。
 *      （叶子对、接线漏 = 用户侧照错，这是本轮 BUG-26 学到的教训。）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mute = require('../../../src/cli/tui/consoleMute').muteConsoleForSession;

const MARK = 'CONSOLE-MUTE-TEST-MARKER';

test('C1 静音期间 winston 的 warn 不再落到真 stdio；恢复后照落', () => {
  const logger = require('../../../src/utils/logger');
  const streams = ['stdout', 'stderr'];
  const natives = {};
  const captured = { stdout: '', stderr: '' };
  for (const name of streams) {
    natives[name] = process[name].write.bind(process[name]);
    process[name].write = (chunk) => {
      captured[name] += String(chunk);
      return true;
    };
  }
  const unwrap = () => {
    for (const name of streams) process[name].write = natives[name];
  };

  try {
    // 先确认病在：不静音时 warn 会打进终端
    logger.warn(`[probe] ${MARK}`);
    assert.ok(captured.stdout + captured.stderr, 'precondition failed: warn did not reach stdio');

    captured.stdout = '';
    captured.stderr = '';
    const handle = mute(logger, {});
    assert.equal(handle.muted, true, 'console transport should exist under NODE_ENV!=production');
    logger.warn(`[probe] ${MARK}`);
    assert.equal(captured.stdout + captured.stderr, '', 'muted: warn must not reach the terminal');

    captured.stdout = '';
    captured.stderr = '';
    assert.equal(handle.restore(), true, 'restore should find the console transport');
    logger.warn(`[probe] ${MARK}`);
    assert.ok(captured.stdout + captured.stderr, 'after restore: warn reaches the terminal again');
  } finally {
    unwrap();
  }
});

test('C2 只降级控制台：文件 transport 的级别一字不动', () => {
  const logger = require('../../../src/utils/logger');
  const file = logger.transports.find((t) => t && t.name !== 'console');
  assert.ok(file, 'expected a non-console (file) transport to exist');
  const before = file.level;
  const handle = mute(logger, {});
  try {
    assert.equal(file.level, before, 'file transport level must be untouched — logs stay on disk');
  } finally {
    handle.restore();
  }
});

test('C3 逃生阀 KHY_TUI_CONSOLE_LOG=1 → 不静音（逐字节回退旧行为）', () => {
  const calls = [];
  const fake = {
    transports: [{ name: 'console', level: 'warn' }],
    setConsoleLevel: (lvl) => { calls.push(lvl); return true; },
  };
  const handle = mute(fake, { KHY_TUI_CONSOLE_LOG: '1' });
  assert.equal(handle.muted, false);
  assert.deepEqual(calls, [], 'gate on → never touch the transport');
  assert.equal(handle.restore(), false);
});

test('C4 门面缺失/畸形/调不到 → muted:false 且不抛', () => {
  for (const bad of [undefined, null, {}, { setConsoleLevel: () => false, transports: [] }]) {
    assert.doesNotThrow(() => {
      const h = mute(bad, {});
      assert.equal(h.muted, false);
      assert.equal(h.restore(), false);
    });
  }
  // setConsoleLevel 自己抛（transport 结构被别的版本改了）也不能把启动路径带崩
  assert.doesNotThrow(() => {
    const h = mute({ setConsoleLevel: () => { throw new Error('boom'); }, transports: [] }, {});
    assert.equal(h.muted, false);
  });
});

test('C5 恢复回到进入前的级别，不留 silent', () => {
  const calls = [];
  const fake = {
    transports: [{ name: 'console', level: 'warn' }], // CLI 启动时 bin/khy.js 调成了 warn
    setConsoleLevel: (lvl) => { calls.push(lvl); return true; },
  };
  const handle = mute(fake, {});
  assert.deepEqual(calls, ['silent']);
  assert.equal(handle.previous, 'warn');
  assert.equal(handle.restore(), true);
  assert.deepEqual(calls, ['silent', 'warn'], 'must go back to exactly what it was');
});

test('C5b 进入前无级别可记（无 console transport）→ 恢复退回 info 而非 silent', () => {
  const calls = [];
  const fake = {
    transports: [],
    setConsoleLevel: (lvl) => { calls.push(lvl); return true; },
  };
  const handle = mute(fake, {});
  assert.equal(handle.previous, undefined);
  handle.restore();
  assert.equal(calls[1], 'info');
});

test('C6 接线：app.js 挂载前静音、退出后恢复、硬退出有兜底', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/cli/tui/app.js'), 'utf8'
  );
  const mountAt = src.indexOf("require('./consoleMute')");
  const renderAt = src.indexOf('const app = render(');
  const exitAt = src.indexOf('await app.waitUntilExit()');
  assert.ok(mountAt > 0, 'app.js must wire consoleMute in');
  assert.ok(renderAt > 0);
  assert.ok(exitAt > 0);
  assert.ok(mountAt < renderAt, 'mute must happen BEFORE ink mounts');
  assert.ok(src.indexOf('_restoreConsoleLogs()', exitAt) > exitAt, 'restore must run after exit');
  assert.ok(/process\.once\('exit'[^\n]*_restoreConsoleLogs/.test(src),
    'a hard exit must not leave the process log-silent');
});
