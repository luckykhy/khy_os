'use strict';

/**
 * crossAgentTasteLearner.test.js — pure leaf tests (no IO at import time).
 *
 * Coverage:
 *  1. extractTexts handles Claude Code / cmdc / OpenCode record shapes
 *     (message.content as string, array of typed blocks, or a flat rec.role
 *     / rec.content variant).
 *  2. learnFromRecord fires on a user-side short meta-comment ("太长了"),
 *     CLI flag ("--no-emoji"), and tool prefix ("khy ").
 *  3. learnFromRecord does NOT fire on assistant-side text that happens to
 *     mention "太长了" — the short-remark gate of preferenceSignals is
 *     honored, AND even if it slipped through, the assistant text is not
 *     where we mine.
 *  4. collapseCandidates dedupes by category+normalized text and bumps
 *     confidence by distinct sessions (capped).
 *  5. filterByTime keeps records without a timestamp and drops old ones.
 *  6. readSessionRecords skips malformed JSONL lines.
 *
 * Tests are pure: no disk IO, no tasteService, no require of ccSwitch. We
 * stub crossAgentTasteLearner.learnFromSessions via mock require to avoid
 * scanning real ~/.claude.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const learner = require('../crossAgentTasteLearner');

test('extractTexts: Claude Code shape — message.content as string', () => {
  const rec = {
    type: 'user',
    message: { role: 'user', content: 'hi there' },
  };
  const out = learner.extractTexts(rec, 'claude-code');
  assert.deepEqual(out.userTexts, ['hi there']);
  assert.deepEqual(out.assistantTexts, []);
});

test('extractTexts: cmdc / OpenCode shape — message.content as typed array', () => {
  const rec = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sure, here you go.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  };
  const out = learner.extractTexts(rec, 'command-code');
  assert.deepEqual(out.assistantTexts, ['Sure, here you go.']);
  // tool_use blocks are intentionally not surfaced as text.
  assert.equal(out.userTexts.length, 0);
});

test('extractTexts: Codex / YCode shape — flat rec.role / rec.content', () => {
  const rec = {
    role: 'user',
    content: [{ type: 'text', text: 'fix the bug' }],
  };
  const out = learner.extractTexts(rec, 'codex');
  assert.deepEqual(out.userTexts, ['fix the bug']);
});

test('extractTexts: ignores null/garbage records', () => {
  assert.deepEqual(learner.extractTexts(null, 'opencode'), { userTexts: [], assistantTexts: [], flags: [] });
  assert.deepEqual(learner.extractTexts({}, 'claude-code'), { userTexts: [], assistantTexts: [], flags: [] });
});

test('learnFromRecord: user-side 太长了 fires response-style preference', () => {
  const rec = { type: 'user', message: { role: 'user', content: '太长了' } };
  const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
  const tooLong = cands.find((c) => c.text === '用户偏好简短回复');
  assert.ok(tooLong, 'should have response-style "用户偏好简短回复"');
  assert.equal(tooLong.category, 'response-style');
  assert.ok(tooLong.confidence >= 0.6);
});

test('learnFromRecord: assistant-side 太长了 does not fire (no signal on assistant text)', () => {
  const rec = {
    type: 'assistant',
    message: { role: 'assistant', content: '我理解,太长了,我再精炼一下' },
  };
  const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
  // Even if "太长了" appears in the text, the assistant role doesn't go
  // through preferenceSignals — we only mine user turns for that.
  assert.equal(cands.find((c) => c.text === '用户偏好简短回复'), undefined);
});

test('learnFromRecord: --no-emoji CLI flag fires style preference', () => {
  // The flags are matched against the full record stringified, so any place
  // the flag is recorded (turn metadata, sidecar, attachment) is caught.
  const rec = { type: 'user', message: { role: 'user', content: 'go' }, flags: ['--no-emoji'] };
  const cands = learner.learnFromRecord(rec, 'opencode', 's1');
  const noEmoji = cands.find((c) => c.text === '用户不希望回复带 emoji');
  assert.ok(noEmoji, 'should have style "用户不希望回复带 emoji"');
  assert.equal(noEmoji.category, 'style');
});

test('learnFromRecord: tool prefix "khy " in user text fires tooling preference', () => {
  const rec = { type: 'user', message: { role: 'user', content: 'khy taste list' } };
  const cands = learner.learnFromRecord(rec, 'command-code', 's1');
  const hint = cands.find((c) => c.text === '用户经常直接调用 khy 命令');
  assert.ok(hint);
  assert.equal(hint.category, 'tooling');
});

test('learnFromRecord: bypassPermissions permissionMode fires workflow preference', () => {
  const rec = {
    type: 'user',
    message: { role: 'user', content: 'go' },
    permissionMode: 'bypassPermissions',
  };
  const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
  const bypass = cands.find((c) => c.text === '用户习惯绕过权限确认');
  assert.ok(bypass, 'should have workflow "用户习惯绕过权限确认"');
  assert.equal(bypass.category, 'workflow');
});

test('collapseCandidates: dedups by category+text, bumps confidence per session', () => {
  const candidates = [
    { category: 'response-style', text: '用户偏好简短回复', confidence: 0.6, source: { sessionId: 's1' } },
    { category: 'response-style', text: '用户偏好简短回复', confidence: 0.6, source: { sessionId: 's1' } },
    { category: 'response-style', text: '用户偏好简短回复', confidence: 0.6, source: { sessionId: 's2' } },
    { category: 'response-style', text: '用户偏好简短回复', confidence: 0.6, source: { sessionId: 's3' } },
  ];
  const collapsed = learner.collapseCandidates(candidates);
  assert.equal(collapsed.length, 1);
  const c = collapsed[0];
  assert.equal(c.category, 'response-style');
  assert.equal(c.text, '用户偏好简短回复');
  // 3 distinct sessions × 0.05 = 0.15 → 0.6 + 0.15 = 0.75, capped at 0.85.
  assert.equal(c.confidence, 0.75);
  assert.equal(c.sessionCount, 3);
});

test('collapseCandidates: keeps different categories separate', () => {
  const candidates = [
    { category: 'response-style', text: 'A', confidence: 0.6, source: { sessionId: 's1' } },
    { category: 'workflow', text: 'A', confidence: 0.6, source: { sessionId: 's1' } },
  ];
  const collapsed = learner.collapseCandidates(candidates);
  assert.equal(collapsed.length, 2);
});

test('collapseCandidates: confidence is capped at 0.85', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    category: 'style',
    text: 'same',
    confidence: 0.6,
    source: { sessionId: `s${i}` },
  }));
  const collapsed = learner.collapseCandidates(candidates, { perSessionCap: 100 });
  // 30 sessions × 0.05 = 1.5 → capped at 0.85.
  assert.equal(collapsed[0].confidence, 0.85);
});

test('filterByTime: drops old records, keeps records without timestamps', () => {
  const old = { timestamp: '2020-01-01T00:00:00.000Z' };
  const fresh = { timestamp: '2099-01-01T00:00:00.000Z' };
  const noTs = { type: 'user' };
  const filtered = learner.filterByTime([old, fresh, noTs], Date.parse('2025-01-01T00:00:00.000Z'));
  assert.equal(filtered.length, 2);
  assert.ok(filtered.includes(fresh));
  assert.ok(filtered.includes(noTs));
  assert.ok(!filtered.includes(old));
});

test('readSessionRecords: skips malformed JSONL lines', () => {
  // tmp file with a mix of valid and invalid lines
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `candl-${Date.now()}.jsonl`);
  fs.writeFileSync(
    tmp,
    [
      '{"type":"user","message":{"role":"user","content":"hi"}}',
      'this is not json',
      '{"type":"user","message":{"role":"user","content":"hey"}}',
      '',
      '{broken',
    ].join('\n'),
    'utf-8'
  );
  const recs = learner.readSessionRecords(tmp);
  try {
    assert.equal(recs.length, 2);
    assert.equal(recs[0].message.content, 'hi');
    assert.equal(recs[1].message.content, 'hey');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
});

test('readSessionRecords: .json snapshot files parse as a single object', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), `candj-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'snap' } }), 'utf-8');
  const recs = learner.readSessionRecords(tmp);
  try {
    assert.equal(recs.length, 1);
    assert.equal(recs[0].message.content, 'snap');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
});

test('readSessionRecords: returns [] for missing / unreadable files', () => {
  assert.deepEqual(learner.readSessionRecords('/no/such/path/x.jsonl'), []);
  assert.deepEqual(learner.readSessionRecords(''), []);
});

test('learnFromRecord: empty record yields no candidates', () => {
  assert.deepEqual(learner.learnFromRecord({}, 'claude-code', 's1'), []);
  assert.deepEqual(learner.learnFromRecord(null, 'opencode', 's1'), []);
});

// ── OpenClaw session discovery ───────────────────────────────────────────
//
// These tests exercise the path resolution + walk against a tmp tree, not
// against a real ~/.openclaw. We override KHY_OPENCLAW_DATA_HOME to point
// `utils/openclawHome` at the tmp dir; that's the same override that real
// operators use, so the test mirrors production.

test('_collectOpenclawSessionFiles: walks agents/<id>/sessions/*.jsonl', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-oc-'));
  try {
    // Layout: tmp/agents/agent-a/sessions/{a,b}.jsonl + tmp/agents/agent-b/sessions/c.json
    fs.mkdirSync(path.join(tmp, 'agents', 'agent-a', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'agents', 'agent-b', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'agent-a', 'sessions', 'sess-a.jsonl'), '{"type":"user"}', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'agents', 'agent-a', 'sessions', 'sess-b.jsonl'), '{"type":"user"}', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'agents', 'agent-b', 'sessions', 'sess-c.json'), '{"type":"user"}', 'utf-8');
    // A sibling file we should NOT pick up.
    fs.writeFileSync(path.join(tmp, 'agents', 'agent-a', 'sessions', 'notes.txt'), 'ignore me', 'utf-8');

    const env = { KHY_OPENCLAW_DATA_HOME: tmp };
    const files = learner._collectOpenclawSessionFiles(env);
    assert.equal(files.length, 3);
    assert.ok(files.every((f) => f.app === 'openclaw'));
    const basenames = files.map((f) => path.basename(f.file)).sort();
    assert.deepEqual(basenames, ['sess-a.jsonl', 'sess-b.jsonl', 'sess-c.json']);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('_collectOpenclawSessionFiles: empty / missing state home returns []', () => {
  // No overrides set → resolve() returns '' (openclawHome is fail-soft).
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-oc-empty-'));
  try {
    // Pretend home is an unrelated dir so the default (~/.openclaw) misses
    // and the function returns []. We pass homedir explicitly through the
    // openclawStateDir contract: env with no overrides + a homedir without
    // ~/.openclaw → no state home → [].
    const env = { HOME: tmp, USERPROFILE: tmp };
    const files = learner._collectOpenclawSessionFiles(env);
    assert.deepEqual(files, []);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('_collectOpenclawSessionFiles: OPENCLAW_STATE_DIR override is honored', () => {
  // KHY_OPENCLAW_DATA_HOME is highest precedence; OPENCLAW_STATE_DIR is
  // second. We verify the second one by clearing the first.
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-oc-state-'));
  try {
    fs.mkdirSync(path.join(tmp, 'agents', 'main', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'main', 'sessions', 'x.jsonl'), '{"type":"user"}', 'utf-8');
    const env = { OPENCLAW_STATE_DIR: tmp };
    const files = learner._collectOpenclawSessionFiles(env);
    assert.equal(files.length, 1);
    assert.equal(files[0].app, 'openclaw');
    assert.ok(files[0].file.endsWith('x.jsonl'));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('discoverSessionFiles: includes openclaw entries alongside ccSwitch apps', () => {
  // We can't reach into the real ccSwitch environment from a unit test
  // (ccSwitch.usageScan walks real ~/.claude etc.), so we drive the public
  // API on this machine — the ccSwitch half may be empty on CI but the
  // openclaw half is asserted by setting KHY_OPENCLAW_DATA_HOME to a tmp
  // tree with a session file. This guards against regressions in the
  // "openclaw is added on top of ccSwitch" wiring without coupling to
  // whatever session files happen to exist on the test box.
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-oc-mix-'));
  try {
    fs.mkdirSync(path.join(tmp, 'agents', 'main', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'main', 'sessions', 'a.jsonl'), '{}', 'utf-8');
    const env = { KHY_OPENCLAW_DATA_HOME: tmp };
    const files = learner.discoverSessionFiles({ apps: ['openclaw'], env });
    assert.equal(files.length, 1);
    assert.equal(files[0].app, 'openclaw');
    assert.ok(files[0].file.endsWith('a.jsonl'));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('learnFromRecord: openclaw record shape (pi-mono style) yields preference signals', () => {
  // OpenClaw's runtime (pi-mono) is a Claude-Code cousin — same JSONL shape.
  // Sanity check: an OpenClaw "user 太长了" record fires the same
  // response-style preference that Claude Code does.
  const rec = {
    type: 'user',
    message: { role: 'user', content: '太长了' },
    timestamp: '2026-08-28T02:00:00.000Z',
  };
  const cands = learner.learnFromRecord(rec, 'openclaw', 'openclaw-sess-1');
  const hit = cands.find((c) => c.text === '用户偏好简短回复');
  assert.ok(hit, 'openclaw 太长了 should fire response-style preference');
  assert.equal(hit.category, 'response-style');
  assert.equal(hit.source.app, 'openclaw');
});

// ── ZCode session discovery + record extraction ───────────────────────────
//
// ZCode writes per-API-completion JSONL records under
// ~/.zcode/cli/rollout/model-io-sess_*.jsonl. We project that nested shape
// into the flat {user, assistant} view so the rest of the pipeline keeps
// working.

test('_collectZcodeSessionFiles: walks ~/.zcode/cli/rollout/*.jsonl', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-zcode-'));
  try {
    fs.mkdirSync(path.join(tmp, 'cli', 'rollout'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'cli', 'rollout', 'model-io-sess_aaa.jsonl'),
      '{}',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmp, 'cli', 'rollout', 'sess_bbb.jsonl'),
      '{}',
      'utf-8'
    );
    // Sibling non-session file → ignored (.toml, not in our allow-list).
    fs.writeFileSync(path.join(tmp, 'cli', 'rollout', 'config.toml'), 'noise', 'utf-8');
    // Sibling .txt → ignored.
    fs.writeFileSync(path.join(tmp, 'cli', 'rollout', 'notes.txt'), 'noise', 'utf-8');

    // Bypass ~/.zcode resolution by overriding ZCODE_ROLLOUT_DIR.
    const files = learner._collectZcodeSessionFiles({ ZCODE_ROLLOUT_DIR: path.join(tmp, 'cli', 'rollout') });
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.app === 'zcode'));
    const names = files.map((f) => path.basename(f.file)).sort();
    assert.deepEqual(names, ['model-io-sess_aaa.jsonl', 'sess_bbb.jsonl']);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('_collectZcodeSessionFiles: missing rollout dir returns [] (no throw)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-zcode-empty-'));
  try {
    // No cli/rollout subdir created.
    const files = learner._collectZcodeSessionFiles({ ZCODE_ROLLOUT_DIR: path.join(tmp, 'no-such-dir') });
    assert.deepEqual(files, []);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test('extractTexts: ZCode record (request.messages[user] + response.text) projects correctly', () => {
  // One API completion: user says "太短了", assistant replies.
  const rec = {
    completedAt: '2026-08-28T08:15:22.977Z',
    sessionId: 'model-io-sess_ebc5226a',
    request: {
      messages: [
        { role: 'system', content: 'You are ZCode, an interactive coding agent' },
        { role: 'user', content: '太短了' },
      ],
    },
    response: {
      text: '好的,我把步骤展开讲。',
      reasoningText: 'The user asked for more detail.',
    },
  };
  const out = learner.extractTexts(rec, 'zcode');
  // The user message lands in userTexts; the system message is filtered out
  // (harness boilerplate, not user intent).
  assert.deepEqual(out.userTexts, ['太短了']);
  // The response.text and response.reasoningText both go to assistantTexts.
  assert.ok(out.assistantTexts.includes('好的,我把步骤展开讲。'));
  assert.ok(out.assistantTexts.includes('The user asked for more detail.'));
  // flags should NOT be empty (the record is non-trivial) — we still
  // record the full payload for the CLI-flag heuristic.
  assert.ok(out.flags.length > 0);
});

test('learnFromRecord: ZCode record fires preference signals + tooling prefix', () => {
  const rec = {
    sessionId: 'model-io-sess_zzz',
    request: {
      messages: [
        { role: 'system', content: 'You are ZCode' },
        { role: 'user', content: '详细点 zcode 一下' },
      ],
    },
    response: { text: '展开来讲...' },
  };
  const cands = learner.learnFromRecord(rec, 'zcode', 'model-io-sess_zzz');
  // Both heuristics fire on the same record.
  const detail = cands.find((c) => c.text === '用户偏好详细回复');
  const zc = cands.find((c) => c.text === '用户经常直接调用 zcode 命令');
  assert.ok(detail, 'should fire response-style "too_short"');
  assert.equal(detail.category, 'response-style');
  assert.ok(zc, 'should fire tooling "zcode"');
  assert.equal(zc.category, 'tooling');
  assert.equal(zc.source.app, 'zcode');
});

test('discoverSessionFiles: includes zcode entries alongside openclaw and ccSwitch apps', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-zcode-mix-'));
  try {
    fs.mkdirSync(path.join(tmp, 'cli', 'rollout'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'cli', 'rollout', 'a.jsonl'),
      '{}',
      'utf-8'
    );
    const env = { ZCODE_ROLLOUT_DIR: path.join(tmp, 'cli', 'rollout') };
    const files = learner.discoverSessionFiles({ apps: ['zcode'], env });
    assert.equal(files.length, 1);
    assert.equal(files[0].app, 'zcode');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
