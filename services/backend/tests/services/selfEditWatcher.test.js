'use strict';
/**
 * selfEditWatcher �?监视器壳集成测试(真临时目�?+ �?fs.watch)�? *
 * 验证:门控关不启动、非 khy 根不启动、外部改动源文件 �?onAdvisory 触发、�? 去重
 * (recordToolEdit 后写 �?被跳�?、非镜像文件不触发、stop 幂等�? * fs.watch 有平台时�?用轮询等�?+ 宽松超时,避免偶发�? */
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./selfEditAdvisoryService');
const watcher = require('./selfEditWatcher');
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
      if (pred()) {
        return resolve(true);
      }
      if (Date.now() - t0 > timeoutMs) {
        return resolve(false);
      }
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
describe('start 门控 / 根校�?, () => {
});
describe('外部改动触发 onAdvisory', () => {
});
describe('stop 幂等', () => {
});

describe('Self Edit Watcher', () => {
  test('门控�?子闸)�?不启�?, async () => {
        const root = mkFakeRoot();
        process.env.KHY_SELF_EDIT_WATCH = '0';
        expect(watcher.start({ root, onAdvisory: () => {} })).toBe(false);
        expect(watcher.isRunning()).toBe(false);
  });

  test('门控�?总闸)�?不启�?, async () => {
        const root = mkFakeRoot();
        process.env.KHY_SELF_EDIT_ADVISORY = 'off';
        expect(watcher.start({ root, onAdvisory: () => {} })).toBe(false);
  });

  test('�?root �?不启�?, async () => {
        expect(watcher.start({ root: null, onAdvisory: () => {} })).toBe(false);
  });

  test('齐备 �?启动', async () => {
        const root = mkFakeRoot();
        expect(watcher.start({ root, onAdvisory: () => {} })).toBe(true);
        expect(watcher.isRunning()).toBe(true);
  });

  test('写镜像源文件 �?onAdvisory 收到 {humanLine,aiNote}', async () => {
        const root = mkFakeRoot();
        const got = [];
        expect(watcher.start({ root, onAdvisory: (a) => got.push(a) })).toBe(true);
        const abs = path.join(root, 'services/backend/src/services/ext.js');
        fs.writeFileSync(abs, 'module.exports = 1;\n');
        const ok = await waitFor(() => got.length > 0);
        expect(ok).toBe(true);
        expect(got[0].humanLine).toMatch(/khy 自维�?);
        expect(got[0].aiNote).toMatch(/bundled/);
  });

  test('§4:recordToolEdit 后写 �?被跳�?不双重提�?', async () => {
        const root = mkFakeRoot();
        const got = [];
        expect(watcher.start({ root, onAdvisory: (a) => got.push(a) })).toBe(true);
        const abs = path.join(root, 'services/backend/src/services/tool.js');
        svc.recordToolEdit(abs); // 标记为工具刚写过
        fs.writeFileSync(abs, 'module.exports = 2;\n');
        // 给足时间:即便 fs.watch 触发,_handleChange 也应�?wasRecentlyToolEdited 跳过�?        const fired = await waitFor(() => got.length > 0, 2500);
        expect(fired).toBe(false);
  });

  test('非镜像文�?scripts/�?�?不触�?, async () => {
        const root = mkFakeRoot();
        const got = [];
        watcher.start({ root, onAdvisory: (a) => got.push(a) });
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(root, 'scripts/x.js'), 'x');
        const fired = await waitFor(() => got.length > 0, 2000);
        expect(fired).toBe(false);
  });

  test('未启�?stop 不抛;启动�?stop 清干净', async () => {
        expect(() => watcher.stop().not.toThrow());
        const root = mkFakeRoot();
        watcher.start({ root, onAdvisory: () => {} });
        watcher.stop();
        expect(watcher.isRunning()).toBe(false);
        expect(() => watcher.stop().not.toThrow());
  });

});

