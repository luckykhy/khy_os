'use strict';

/**
 * promptComposerService.test.js — /prompt 撰写 IO 编排层(node:test)。
 *
 * 用注入的 fake fs/os/runEditor 测编排,无需真拉起编辑器:撰写成功 / 空正文 / 编辑器失败 /
 * 门控关字节回退 / 临时文件清理 / 编辑器解析(VISUAL→EDITOR→平台默认)/ wiring grep。确定性。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../../src/services/promptComposerService');
const { SENTINEL, buildComposerSeed } = require('../../src/services/promptComposer');

const BACKEND_ROOT = path.resolve(__dirname, '../..');

function makeFakeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    mkdtempSync: (prefix) => `${prefix}ABC123`,
    writeFileSync: (f, c) => { store.set(f, String(c)); },
    readFileSync: (f) => {
      if (!store.has(f)) throw new Error(`ENOENT ${f}`);
      return store.get(f);
    },
    unlinkSync: (f) => { store.delete(f); },
    rmdirSync: () => {},
  };
}
const fakeOs = { tmpdir: () => '/tmp' };

test('isPromptComposeEnabled:默认开;显式 falsy 关', () => {
  assert.equal(svc.isPromptComposeEnabled({}), true);
  assert.equal(svc.isPromptComposeEnabled({ KHY_PROMPT_COMPOSE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(svc.isPromptComposeEnabled({ KHY_PROMPT_COMPOSE: v }), false, v);
  }
});

test('composeInEditor:用户写下正文 → ok + 剥离指引后的正文', () => {
  const fakeFs = makeFakeFs();
  // 模拟用户在种子基础上续写正文
  const runEditor = (cmd, file) => {
    fakeFs.store.set(file, `${fakeFs.store.get(file)}\n帮我写一封正式的道歉邮件`);
    return { status: 0 };
  };
  const r = svc.composeInEditor({ initialText: '', env: {}, fs: fakeFs, os: fakeOs, runEditor });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'composed');
  assert.equal(r.text, '帮我写一封正式的道歉邮件', '#! 指引行被剥掉,只留正文');
});

test('composeInEditor:种子含 #! 指引行(写入的是 buildComposerSeed)', () => {
  const fakeFs = makeFakeFs();
  let seenSeed = null;
  const runEditor = (cmd, file) => { seenSeed = fakeFs.store.get(file); return { status: 0 }; };
  svc.composeInEditor({ initialText: '起始文字', env: {}, fs: fakeFs, os: fakeOs, runEditor });
  assert.ok(seenSeed.includes(SENTINEL), '临时文件先写入哨兵指引');
  assert.ok(seenSeed.includes('起始文字'), '初始正文进入种子');
  assert.equal(seenSeed, buildComposerSeed('起始文字'));
});

test('composeInEditor:空正文(用户没写)→ reason empty,不发送', () => {
  const fakeFs = makeFakeFs();
  const runEditor = () => ({ status: 0 }); // 不改文件,只剩种子指引行
  const r = svc.composeInEditor({ initialText: '', env: {}, fs: fakeFs, os: fakeOs, runEditor });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
  assert.equal(r.text, '');
});

test('composeInEditor:编辑器失败 → reason editor-failed', () => {
  const fakeFs = makeFakeFs();
  const runEditor = () => ({ error: 'spawn nano ENOENT' });
  const r = svc.composeInEditor({ initialText: '', env: {}, fs: fakeFs, os: fakeOs, runEditor });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'editor-failed');
  assert.ok(r.detail.includes('ENOENT'));
});

test('composeInEditor:门控关 → reason disabled,字节回退(不碰 fs / 不起编辑器)', () => {
  let touched = false;
  const guardFs = new Proxy({}, { get() { touched = true; throw new Error('fs 不应被触碰'); } });
  let editorCalled = false;
  const runEditor = () => { editorCalled = true; return { status: 0 }; };
  const r = svc.composeInEditor({ env: { KHY_PROMPT_COMPOSE: '0' }, fs: guardFs, os: fakeOs, runEditor });
  assert.equal(r.reason, 'disabled');
  assert.equal(r.ok, false);
  assert.equal(touched, false, '门关不触碰 fs');
  assert.equal(editorCalled, false, '门关不起编辑器');
});

test('composeInEditor:临时文件用后即删(unlink 被调用)', () => {
  const fakeFs = makeFakeFs();
  const runEditor = (cmd, file) => { fakeFs.store.set(file, `${fakeFs.store.get(file)}\n正文`); return { status: 0 }; };
  svc.composeInEditor({ initialText: '', env: {}, fs: fakeFs, os: fakeOs, runEditor });
  // 撰写结束后临时文件不应残留
  const tmp = path.join('/tmp/khy-prompt-ABC123', 'prompt.md');
  assert.equal(fakeFs.store.has(tmp), false, '临时文件已删除');
});

test('composeInEditor:绝不抛(fs 异常也返回结构化 error)', () => {
  const boomFs = {
    mkdtempSync: () => { throw new Error('boom'); },
  };
  let r;
  assert.doesNotThrow(() => {
    r = svc.composeInEditor({ env: {}, fs: boomFs, os: fakeOs, runEditor: () => ({ status: 0 }) });
  });
  assert.equal(r.reason, 'error');
  assert.ok(r.detail.includes('boom'));
});

test('_resolveEditor:VISUAL > EDITOR > 平台默认', () => {
  assert.equal(svc._resolveEditor({ VISUAL: 'code --wait', EDITOR: 'vim' }), 'code --wait');
  assert.equal(svc._resolveEditor({ EDITOR: 'vim' }), 'vim');
  assert.equal(svc._resolveEditor({}, 'win32'), 'notepad');
  assert.equal(svc._resolveEditor({}, 'linux'), 'nano');
});

// ── wiring grep ─────────────────────────────────────────────────────────
test('wiring:CLI dispatch + schema + flag 已接线', () => {
  const ops = fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli/routerDispatchOps.js'), 'utf8');
  assert.ok(ops.includes('promptComposerService'), 'dispatch require 服务');
  assert.ok(ops.includes('composeInEditor'), 'dispatch 调用 composeInEditor');
  assert.ok(ops.includes("subCommand === 'compose'"), 'compose 分支');

  const schema = fs.readFileSync(path.join(BACKEND_ROOT, 'src/constants/commandSchema.js'), 'utf8');
  assert.ok(/prompt:\s*\[[^\]]*'compose'/.test(schema), "prompt 子命令含 'compose'");

  const reg = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/flagRegistry.js'), 'utf8');
  assert.ok(reg.includes('KHY_PROMPT_COMPOSE'), 'flag 注册');
});
