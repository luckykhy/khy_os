'use strict';

/**
 * sessionPersistence — optional structured turn artifacts
 * (_timeline/_toolCalls/_turnStats) on the JSONL transcript + JSON snapshot.
 *
 * 覆盖四条红线：
 *   ① 向后兼容：不带新字段的 appendMessage 写出的 JSONL 行键集合与旧格式一致；
 *   ② present-only：空数组 / 空对象不落盘（缺省时行字节不变的键级证据）；
 *   ③ 带新字段正确写入并可读回（appendMessage 直写 + persistSession 透传，
 *      含 JSON 快照的原始消息透传）；
 *   ④ 旧 reader（buildConversationChain / restoreSession）读带新字段的行不崩溃，
 *      restore 白名单照旧剥离新字段。
 *
 * 隔离：在 require 持久化模块**之前**把 KHY_PROJECT_DATA_HOME 钉到临时目录
 * （dataHome 首次解析即缓存）。数据家目录放在临时根的 .khy 子目录下，让
 * dataHome 的 khy-Trajectory 可见别名也落在临时根内，after 整树清理零残留。
 *
 * 运行: node --test tests/services/sessionPersistence.turnArtifacts.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sess-artifacts-'));
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP_ROOT, '.khy');

const sp = require('../../src/services/sessionPersistence');

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Read the raw JSONL lines for a session as parsed objects.
function readJsonlEntries(sessionId) {
  const file = sp.jsonlPathFor(sessionId);
  const raw = fs.readFileSync(file, 'utf-8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const SAMPLE_TIMELINE = [
  { type: 'text', text: '先看一下文件' },
  { type: 'tools', tools: [{ name: 'Read', paramsSummary: '{"file_path":"a.js"}', status: 'done' }] },
  { type: 'text', text: '看完了' },
];
const SAMPLE_TOOL_CALLS = [
  { seq: 1, name: 'Read', paramsSummary: '{"file_path":"a.js"}', durationMs: 42, status: 'done' },
];
const SAMPLE_TURN_STATS = { elapsedMs: 1234, tokens: 567, toolCount: 1 };

test('appendMessage 无新字段时行键集合与旧格式一致（向后兼容红线）', () => {
  const sid = 'art-legacy-keys';
  sp.appendMessage(sid, { role: 'user', content: 'hi' });
  // Empty array / empty object artifacts must also leave the line untouched.
  sp.appendMessage(sid, {
    role: 'assistant', content: 'hello',
    _timeline: [], _toolCalls: [], _turnStats: {},
  });
  const [plain, withEmpty] = readJsonlEntries(sid);

  for (const entry of [plain, withEmpty]) {
    for (const k of ['_timeline', '_toolCalls', '_turnStats']) {
      assert.equal(k in entry, false, `${k} 不应出现在无/空 artifacts 的行里`);
    }
  }
  // Key SETS of the two lines are identical — attaching empty artifacts
  // produces the same shape as never attaching them (present-only).
  assert.deepEqual(Object.keys(withEmpty).sort(), Object.keys(plain).sort());
  // Legacy core keys are all still there.
  for (const k of ['uuid', 'parentUuid', 'role', 'content', 'timestamp', 'isMeta', 'isCompactSummary']) {
    assert.equal(k in plain, true, `旧格式核心键 ${k} 缺失`);
  }
});

test('appendMessage 带新字段正确写入并读回', () => {
  const sid = 'art-write-read';
  sp.appendMessage(sid, { role: 'user', content: 'q' });
  sp.appendMessage(sid, {
    role: 'assistant', content: 'a',
    _timeline: SAMPLE_TIMELINE,
    _toolCalls: SAMPLE_TOOL_CALLS,
    _turnStats: SAMPLE_TURN_STATS,
  });
  const entries = readJsonlEntries(sid);
  const assistant = entries[1];
  assert.deepEqual(assistant._timeline, SAMPLE_TIMELINE);
  assert.deepEqual(assistant._toolCalls, SAMPLE_TOOL_CALLS);
  assert.deepEqual(assistant._turnStats, SAMPLE_TURN_STATS);
  // The plain user line stays artifact-free.
  assert.equal('_timeline' in entries[0], false);
});

test('persistSession 透传消息级 artifacts 到 JSONL 与 JSON 快照', () => {
  const sid = 'art-persist-passthrough';
  sp.persistSession(sid, {
    title: 'artifacts',
    messages: [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant', content: 'done',
        _timeline: SAMPLE_TIMELINE,
        _toolCalls: SAMPLE_TOOL_CALLS,
        _turnStats: SAMPLE_TURN_STATS,
      },
    ],
    metadata: { cwd: process.cwd() },
  });

  // JSONL append path carries the fields.
  const entries = readJsonlEntries(sid);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1]._turnStats, SAMPLE_TURN_STATS);
  assert.deepEqual(entries[1]._toolCalls, SAMPLE_TOOL_CALLS);

  // JSON snapshot keeps the raw messages (live-TUI turns rely on this path).
  const snapPath = sp.jsonlPathFor(sid).replace(/\.jsonl$/, '.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
  assert.deepEqual(snap.messages[1]._timeline, SAMPLE_TIMELINE);
  assert.deepEqual(snap.messages[1]._turnStats, SAMPLE_TURN_STATS);
});

test('旧 reader 读带新字段的行不崩溃：buildConversationChain / restoreSession', () => {
  const sid = 'art-old-readers';
  sp.persistSession(sid, {
    title: 'readers',
    messages: [
      { role: 'user', content: 'ping' },
      {
        role: 'assistant', content: 'pong',
        _timeline: SAMPLE_TIMELINE,
        _toolCalls: SAMPLE_TOOL_CALLS,
        _turnStats: SAMPLE_TURN_STATS,
      },
    ],
    metadata: { cwd: process.cwd() },
  });

  const chain = sp.buildConversationChain(sid);
  assert.equal(chain.length, 2);
  assert.equal(chain[1].content, 'pong');

  const restored = sp.restoreSession(sid);
  assert.ok(restored);
  assert.equal(restored._source, 'jsonl');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].content, 'pong');
  // The restore read-side whitelist strips the artifact fields (documented
  // behavior — `session export --detailed` re-attaches them from the snapshot).
  assert.equal('_timeline' in restored.messages[1], false);
  assert.equal('_toolCalls' in restored.messages[1], false);
  assert.equal('_turnStats' in restored.messages[1], false);
});

test('present-only：非数组 / 非对象的 artifacts 输入被忽略，不污染行', () => {
  const sid = 'art-bad-shapes';
  sp.appendMessage(sid, {
    role: 'assistant', content: 'x',
    _timeline: 'not-an-array',
    _toolCalls: { not: 'array' },
    _turnStats: 'nope',
  });
  const [entry] = readJsonlEntries(sid);
  assert.equal('_timeline' in entry, false);
  assert.equal('_toolCalls' in entry, false);
  assert.equal('_turnStats' in entry, false);
  assert.equal(entry.content, 'x');
});
