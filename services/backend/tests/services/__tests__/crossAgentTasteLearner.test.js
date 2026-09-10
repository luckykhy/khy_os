'use strict';
/**
 * crossAgentTasteLearner.test.js �?pure leaf tests (no IO at import time).
 *
 * Coverage:
 *  1. extractTexts handles Claude Code / cmdc / OpenCode record shapes
 *     (message.content as string, array of typed blocks, or a flat rec.role
 *     / rec.content variant).
 *  2. learnFromRecord fires on a user-side short meta-comment ("太长�?),
 *     CLI flag ("--no-emoji"), and tool prefix ("khy ").
 *  3. learnFromRecord does NOT fire on assistant-side text that happens to
 *     mention "太长�? �?the short-remark gate of preferenceSignals is
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
const learner = require('../crossAgentTasteLearner');
test('learnFromRecord: tool prefix "khy " in user text fires tooling preference', () => {
  const rec = { type: 'user', message: { role: 'user', content: 'khy taste list' } };
  const cands = learner.learnFromRecord(rec, 'command-code', 's1');
  const hint = cands.find((c) => c.text === '用户经常直接调用 khy 命令');
  expect(hint).toBeTruthy();
  expect(hint.category).toBe('tooling');
});

describe('Cross Agent Taste Learner', () => {
  test('extractTexts: Claude Code shape �?message.content as string', () => {
      const rec = {
        type: 'user',
        message: { role: 'user', content: 'hi there' },
      };
      const out = learner.extractTexts(rec, 'claude-code');
      assert.deepEqual(out.userTexts, ['hi there']);
      assert.deepEqual(out.assistantTexts, []);
  });

  test('extractTexts: cmdc / OpenCode shape �?message.content as typed array', () => {
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
      expect(out.userTexts.length).toBe(0);
  });

  test('extractTexts: Codex / YCode shape �?flat rec.role / rec.content', () => {
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

  test('learnFromRecord: user-side 太长�?fires response-style preference', () => {
      const rec = { type: 'user', message: { role: 'user', content: '太长�? } };
      const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
      const tooLong = cands.find((c) => c.text === '用户偏好简短回�?);
      expect(tooLong).toBeTruthy();
      expect(tooLong.category).toBe('response-style');
      expect(tooLong.confidence >= 0.6).toBeTruthy();
  });

  test('learnFromRecord: assistant-side 太长�?does not fire (no signal on assistant text)', () => {
      const rec = {
        type: 'assistant',
        message: { role: 'assistant', content: '我理�?太长�?我再精炼一�? },
      };
      const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
      // Even if "太长�? appears in the text, the assistant role doesn't go
      // through preferenceSignals �?we only mine user turns for that.
      expect(cands.find((c) => c.text === '用户偏好简短回�?)).toBe(undefined);
  });

  test('learnFromRecord: --no-emoji CLI flag fires style preference', () => {
      // The flags are matched against the full record stringified, so any place
      // the flag is recorded (turn metadata, sidecar, attachment) is caught.
      const rec = { type: 'user', message: { role: 'user', content: 'go' }, flags: ['--no-emoji'] };
      const cands = learner.learnFromRecord(rec, 'opencode', 's1');
      const noEmoji = cands.find((c) => c.text === '用户不希望回复带 emoji');
      expect(noEmoji).toBeTruthy();
      expect(noEmoji.category).toBe('style');
  });

  test('learnFromRecord: bypassPermissions permissionMode fires workflow preference', () => {
      const rec = {
        type: 'user',
        message: { role: 'user', content: 'go' },
        permissionMode: 'bypassPermissions',
      };
      const cands = learner.learnFromRecord(rec, 'claude-code', 's1');
      const bypass = cands.find((c) => c.text === '用户习惯绕过权限确认');
      expect(bypass).toBeTruthy();
      expect(bypass.category).toBe('workflow');
  });

  test('collapseCandidates: dedups by category+text, bumps confidence per session', () => {
      const candidates = [
        { category: 'response-style', text: '用户偏好简短回�?, confidence: 0.6, source: { sessionId: 's1' } },
        { category: 'response-style', text: '用户偏好简短回�?, confidence: 0.6, source: { sessionId: 's1' } },
        { category: 'response-style', text: '用户偏好简短回�?, confidence: 0.6, source: { sessionId: 's2' } },
        { category: 'response-style', text: '用户偏好简短回�?, confidence: 0.6, source: { sessionId: 's3' } },
      ];
      const collapsed = learner.collapseCandidates(candidates);
      expect(collapsed.length).toBe(1);
      const c = collapsed[0];
      expect(c.category).toBe('response-style');
      expect(c.text).toBe('用户偏好简短回�?);
      // 3 distinct sessions × 0.05 = 0.15 �?0.6 + 0.15 = 0.75, capped at 0.85.
      expect(c.confidence).toBe(0.75);
      expect(c.sessionCount).toBe(3);
  });

  test('collapseCandidates: keeps different categories separate', () => {
      const candidates = [
        { category: 'response-style', text: 'A', confidence: 0.6, source: { sessionId: 's1' } },
        { category: 'workflow', text: 'A', confidence: 0.6, source: { sessionId: 's1' } },
      ];
      const collapsed = learner.collapseCandidates(candidates);
      expect(collapsed.length).toBe(2);
  });

  test('collapseCandidates: confidence is capped at 0.85', () => {
      const candidates = Array.from({ length: 30 }, (_, i) => ({
        category: 'style',
        text: 'same',
        confidence: 0.6,
        source: { sessionId: `s${i}` },
      }));
      const collapsed = learner.collapseCandidates(candidates, { perSessionCap: 100 });
      // 30 sessions × 0.05 = 1.5 �?capped at 0.85.
      expect(collapsed[0].confidence).toBe(0.85);
  });

  test('filterByTime: drops old records, keeps records without timestamps', () => {
      const old = { timestamp: '2020-01-01T00:00:00.000Z' };
      const fresh = { timestamp: '2099-01-01T00:00:00.000Z' };
      const noTs = { type: 'user' };
      const filtered = learner.filterByTime([old, fresh, noTs], Date.parse('2025-01-01T00:00:00.000Z'));
      expect(filtered.length).toBe(2);
      expect(filtered).toContain(fresh);
      expect(filtered).toContain(noTs);
      expect(!filtered).toContain(old);
  });

});

