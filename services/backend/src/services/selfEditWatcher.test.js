'use strict';

/**
 * selfEditWatcher — 监视器壳集成测试(真临时目录 + 真 fs.watch)。
 *
 * 验证:门控关不启动、非 khy 根不启动、外部改动源文件 → onAdvisory 触发、§4 去重
 * (recordToolEdit 后写 → 被跳过)、非镜像文件不触发、stop 幂等。
 * fs.watch 有平台时延,用轮询等待 + 宽松超时,避免偶发。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const watcher = require('./selfEditWatcher');
const svc = require('./selfEditAdvisoryService');

function mkFakeRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-watch-')));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "khy-os"\n');
  for (const b of ['platform/khy_os/bundled', 'packaging/npm/bundled']) {
    fs.mkdirSync(path.join(root, b), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'services/backend/src/services'), { recursive: true });
  return root;
}

function waitFor(pred, timeoutMs = 4000, stepMs = 50) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

beforeEach(() => {
  svc._resetCachesForTest();
  delete process.env.KHY_SELF_EDIT_ADVISORY;
  delete process.env.KHY_SELF_EDIT_WATCH;
});
afterEach(() => {
  watcher.stop();
});

describe('start 门控 / 根校验', () => {
  test('门控关(子闸)→ 不启动', () => {
    const root = mkFakeRoot();
    process.env.KHY_SELF_EDIT_WATCH = '0';
    assert.equal(watcher.start({ root, onAdvisory: () => {} }), false);
    assert.equal(watcher.isRunning(), false);
  });
  test('门控关(总闸)→ 不启动', () => {
    const root = mkFakeRoot();
    process.env.KHY_SELF_EDIT_ADVISORY = 'off';
    assert.equal(watcher.start({ root, onAdvisory: () => {} }), false);
  });
  test('无 root → 不启动', () => {
    assert.equal(watcher.start({ root: null, onAdvisory: () => {} }), false);
  });
  test('齐备 → 启动', () => {
    const root = mkFakeRoot();
    assert.equal(watcher.start({ root, onAdvisory: () => {} }), true);
    assert.equal(watcher.isRunning(), true);
  });
});

describe('外部改动触发 onAdvisory', () => {
  test('写镜像源文件 → onAdvisory 收到 {humanLine,aiNote}', async () => {
    const root = mkFakeRoot();
    const got = [];
    assert.equal(watcher.start({ root, onAdvisory: (a) => got.push(a) }), true);
    const abs = path.join(root, 'services/backend/src/services/ext.js');
    fs.writeFileSync(abs, 'module.exports = 1;\n');
    const ok = await waitFor(() => got.length > 0);
    assert.equal(ok, true, 'onAdvisory should fire for external edit');
    assert.match(got[0].humanLine, /khy 自维护/);
    assert.match(got[0].aiNote, /bundled/);
  });

  test('§4:recordToolEdit 后写 → 被跳过(不双重提示)', async () => {
    const root = mkFakeRoot();
    const got = [];
    assert.equal(watcher.start({ root, onAdvisory: (a) => got.push(a) }), true);
    const abs = path.join(root, 'services/backend/src/services/tool.js');
    svc.recordToolEdit(abs); // 标记为工具刚写过
    fs.writeFileSync(abs, 'module.exports = 2;\n');
    // 给足时间:即便 fs.watch 触发,_handleChange 也应因 wasRecentlyToolEdited 跳过。
    const fired = await waitFor(() => got.length > 0, 2500);
    assert.equal(fired, false, 'tool-edited file must be skipped by watcher');
  });

  test('非镜像文件(scripts/…)→ 不触发', async () => {
    const root = mkFakeRoot();
    const got = [];
    watcher.start({ root, onAdvisory: (a) => got.push(a) });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/x.js'), 'x');
    const fired = await waitFor(() => got.length > 0, 2000);
    assert.equal(fired, false);
  });
});

describe('stop 幂等', () => {
  test('未启动 stop 不抛;启动后 stop 清干净', () => {
    assert.doesNotThrow(() => watcher.stop());
    const root = mkFakeRoot();
    watcher.start({ root, onAdvisory: () => {} });
    watcher.stop();
    assert.equal(watcher.isRunning(), false);
    assert.doesNotThrow(() => watcher.stop());
  });
});
