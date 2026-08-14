'use strict';

/**
 * issue.test.js — `/issue` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false;参数无效 → 友好用法提示;有 remote + gh 可用 → 调 gh issue create;
 * 有 remote + 无 gh → 浏览器 URL 降级;无 remote → 本地草稿。经 require.cache 桩
 * formatters/sessionPersistence/dataHome/prCreateService;桩 child_process 拦截 git/gh spawn。
 *
 * **诚实边界验证**:无 gh/无 remote 绝不假装已创建,只给 URL/草稿。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/issue');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const SESSION_PATH = require.resolve('../../../src/services/sessionPersistence');
const DATAHOME_PATH = require.resolve('../../../src/utils/dataHome');
const PRCREATE_PATH = require.resolve('../../../src/services/prCreateService');
const CP_PATH = require.resolve('child_process');

let calls;
let tmpDir;
let ghAvailable;
let remoteUrl;
let spawnCapture;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function installStubs() {
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
  });
  cacheStub(SESSION_PATH, {
    listPersistedSessions: () => [{ sessionId: 'sess-1' }],
    jsonlPathFor: () => path.join(tmpDir, 'transcript.jsonl'),
  });
  cacheStub(DATAHOME_PATH, {
    getDataDir: (...seg) => {
      const d = path.join(tmpDir, ...seg);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  });
  cacheStub(PRCREATE_PATH, {
    detectPlatform: () => (ghAvailable ? 'github' : null),
  });
  // 桩 child_process:execSync('git remote get-url origin') / spawnSync('gh', ...)
  const realCp = require('child_process');
  cacheStub(CP_PATH, {
    ...realCp,
    execSync: (cmd) => {
      if (/git remote get-url/.test(cmd)) {
        if (!remoteUrl) throw new Error('no remote');
        return remoteUrl;
      }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawnSync: (bin, args) => {
      spawnCapture.push({ bin, args });
      if (bin === 'gh') return { status: 0, stdout: 'https://github.com/acme/widgets/issues/42\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/issue');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  spawnCapture = [];
  ghAvailable = false;
  remoteUrl = 'git@github.com:acme/widgets.git';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-issue-'));
  fs.writeFileSync(path.join(tmpDir, 'transcript.jsonl'), [
    JSON.stringify({ role: 'user', content: '帮我修复登录' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '好的' }] }),
  ].join('\n'), 'utf-8');
  installStubs();
});

afterEach(() => {
  for (const p of [HANDLER_PATH, FORMATTERS_PATH, SESSION_PATH, DATAHOME_PATH, PRCREATE_PATH, CP_PATH]) {
    delete require.cache[p];
  }
  delete process.env.KHY_ISSUE;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('门控关 → 不接管', () => {
  test('KHY_ISSUE=0 → printInfo + 返回 false', async () => {
    process.env.KHY_ISSUE = '0';
    const { handleIssue } = freshHandler();
    const r = await handleIssue('修复登录', []);
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /KHY_ISSUE|关闭/.test(m)));
    assert.equal(spawnCapture.length, 0);
  });
});

describe('参数无效 → 用法提示', () => {
  test('缺标题 → printWarn + 用法', async () => {
    const { handleIssue } = freshHandler();
    const r = await handleIssue('--label', ['bug']);
    assert.equal(r, true);
    assert.ok(calls.warn.some((m) => /无效|标题/.test(m)));
    assert.ok(calls.info.some((m) => /用法/.test(m)));
    assert.equal(spawnCapture.length, 0); // 不应调 gh
  });
});

describe('gh 可用 + 有 remote → 真创建', () => {
  test('调 gh issue create 并回显 URL', async () => {
    ghAvailable = true;
    const { handleIssue } = freshHandler();
    const r = await handleIssue('修复', ['登录', 'bug', '--label', 'bug']);
    assert.equal(r, true);
    assert.equal(spawnCapture.length, 1);
    assert.equal(spawnCapture[0].bin, 'gh');
    assert.ok(spawnCapture[0].args.includes('issue'));
    assert.ok(spawnCapture[0].args.includes('--repo'));
    assert.ok(spawnCapture[0].args.includes('acme/widgets'));
    assert.ok(spawnCapture[0].args.includes('--label'));
    assert.ok(calls.success.some((m) => /创建/.test(m)));
    assert.ok(calls.info.some((m) => /issues\/42/.test(m)));
  });
});

describe('无 gh + 有 remote → 浏览器 URL 降级(诚实不假装已创建)', () => {
  test('给出 issues/new URL,不调 gh', async () => {
    ghAvailable = false;
    const { handleIssue } = freshHandler();
    const r = await handleIssue('修复登录', []);
    assert.equal(r, true);
    assert.equal(spawnCapture.length, 0);
    assert.ok(calls.info.some((m) => /issues\/new/.test(m)));
    assert.ok(calls.success.length === 0); // 绝不说「已创建」
    assert.ok(calls.info.some((m) => /gh/.test(m))); // 提示安装 gh
  });
});

describe('无 remote → 本地草稿', () => {
  test('落 issue-drafts 草稿', async () => {
    remoteUrl = ''; // git remote get-url 抛错
    const { handleIssue } = freshHandler();
    const r = await handleIssue('修复登录', []);
    assert.equal(r, true);
    assert.equal(spawnCapture.length, 0);
    assert.ok(calls.warn.some((m) => /remote/.test(m)));
    const dir = path.join(tmpDir, 'issue-drafts');
    assert.ok(fs.existsSync(dir));
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^issue-.*\.md$/);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    assert.match(content, /# 修复登录/);
    assert.match(content, /帮我修复登录/); // transcript 汇总进草稿
  });
});
