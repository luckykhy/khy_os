'use strict';

/**
 * perfIssue.test.js — `/perf-issue` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → printInfo 提示 + 返回 false;默认 md 生成报告并落盘到注入的临时数据目录;
 * --format=json/csv 切换;显式 sessionId 优先;fail-soft(用量/transcript 读失败不抛);
 * 报告**绝不含未记录的伪造字段**。经 require.cache 桩 formatters/tokenUsageService/
 * sessionPersistence/dataHome 隔离一切真实 IO。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/perfIssue');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const TOKEN_PATH = require.resolve('../../../src/services/tokenUsageService');
const SESSION_PATH = require.resolve('../../../src/services/sessionPersistence');
const DATAHOME_PATH = require.resolve('../../../src/utils/dataHome');

let calls;
let tmpDir;
let stubUsage;
let stubSessions;
let stubTranscriptFile;

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
  cacheStub(TOKEN_PATH, {
    getSessionUsage: () => stubUsage,
  });
  cacheStub(SESSION_PATH, {
    listPersistedSessions: () => stubSessions,
    jsonlPathFor: (sid) => stubTranscriptFile, // eslint-disable-line no-unused-vars
  });
  cacheStub(DATAHOME_PATH, {
    getDataDir: (...seg) => {
      const d = path.join(tmpDir, ...seg);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/perfIssue');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perf-'));
  stubUsage = {
    inputTokens: 200, outputTokens: 100, totalTokens: 300, requests: 2, costUSD: 0.01,
    records: [
      { provider: 'Anthropic', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, total: 150, costUSD: 0.006, timestamp: 1000 },
      { provider: 'Anthropic', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 50, total: 150, costUSD: 0.004, timestamp: 2000 },
    ],
  };
  stubSessions = [{ sessionId: 'sess-recent' }];
  // 写一个临时 transcript JSONL。
  stubTranscriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(stubTranscriptFile, [
    JSON.stringify({ role: 'user', timestamp: 1000 }),
    JSON.stringify({ role: 'assistant', timestamp: 3000 }),
    'not-json-bad-line',
    '',
  ].join('\n'), 'utf-8');
  installStubs();
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[TOKEN_PATH];
  delete require.cache[SESSION_PATH];
  delete require.cache[DATAHOME_PATH];
  delete process.env.KHY_PERF_ISSUE;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('门控关 → 不接管', () => {
  test('KHY_PERF_ISSUE=0 → printInfo + 返回 false,不落盘', async () => {
    process.env.KHY_PERF_ISSUE = '0';
    const { handlePerfIssue } = freshHandler();
    const r = await handlePerfIssue('', []);
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /KHY_PERF_ISSUE|关闭/.test(m)));
    // perf-reports 目录不应被创建。
    assert.equal(fs.existsSync(path.join(tmpDir, 'perf-reports')), false);
  });
});

describe('默认 md 报告 + 落盘', () => {
  test('打印报告含概览,落盘 .md 到注入数据目录', async () => {
    const { handlePerfIssue } = freshHandler();
    const r = await handlePerfIssue('', []);
    assert.equal(r, true);
    const all = calls.info.join('\n');
    assert.match(all, /会话性能报告/);
    assert.match(all, /claude-opus-4-8/);
    assert.match(all, /回合.*用户 1.*助手 1/s); // transcript 派生回合数
    // 落盘文件存在且为 .md。
    const dir = path.join(tmpDir, 'perf-reports');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.md$/);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    assert.match(content, /# 会话性能报告/);
    // 诚实边界:绝不编造每工具耗时。
    assert.match(content, /不记录每工具耗时/);
  });
});

describe('--format 切换', () => {
  test('--format=json → 落盘 .json 且可解析', async () => {
    const { handlePerfIssue } = freshHandler();
    const r = await handlePerfIssue('--format=json', []);
    assert.equal(r, true);
    const dir = path.join(tmpDir, 'perf-reports');
    const files = fs.readdirSync(dir);
    assert.match(files[0], /\.json$/);
    const obj = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    assert.equal(obj.requests, 2);
    assert.equal(obj.sessionId, 'sess-recent');
  });

  test('--format=csv → 落盘 .csv 且含 TOTAL', async () => {
    const { handlePerfIssue } = freshHandler();
    await handlePerfIssue('--format=csv', []);
    const dir = path.join(tmpDir, 'perf-reports');
    const files = fs.readdirSync(dir);
    assert.match(files[0], /\.csv$/);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    assert.match(content, /TOTAL,/);
  });
});

describe('显式 sessionId / fail-soft', () => {
  test('显式 sessionId 优先(不查 listPersistedSessions)', async () => {
    let listed = false;
    cacheStub(SESSION_PATH, {
      listPersistedSessions: () => { listed = true; return []; },
      jsonlPathFor: () => stubTranscriptFile,
    });
    const { handlePerfIssue } = freshHandler();
    await handlePerfIssue('sess-explicit', []);
    assert.equal(listed, false);
    const dir = path.join(tmpDir, 'perf-reports');
    const files = fs.readdirSync(dir);
    assert.match(files[0], /sess-explici/);
  });

  test('getSessionUsage 抛错 → fail-soft 仍出报告', async () => {
    cacheStub(TOKEN_PATH, { getSessionUsage: () => { throw new Error('boom'); } });
    const { handlePerfIssue } = freshHandler();
    const r = await handlePerfIssue('', []);
    assert.equal(r, true);
    assert.ok(calls.warn.some((m) => /用量/.test(m)));
  });
});
