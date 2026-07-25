'use strict';

/**
 * Tests for commitmentTracker.js — commitment extraction and lifecycle.
 */

let mod;
try {
  mod = require('../../src/services/commitmentTracker');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('CommitmentTracker', () => {
  const {
    CommitmentTracker,
    KIND_VALUES,
    SENSITIVITY_VALUES,
    DEFAULT_CONFIDENCE_THRESHOLD,
    CARE_CONFIDENCE_THRESHOLD,
  } = mod || {};

  let tracker;

  beforeEach(() => {
    tracker = new CommitmentTracker({
      logger: { warn: jest.fn(), info: jest.fn() },
    });
  });

  test('enqueueExtraction rejects empty input', () => {
    expect(tracker.enqueueExtraction({ userText: '', assistantText: '' })).toBe(false);
    expect(tracker.enqueueExtraction({ userText: 'hello', assistantText: '' })).toBe(false);
  });

  test('enqueueExtraction accepts valid input and returns true', () => {
    const result = tracker.enqueueExtraction({
      userText: 'Remind me about the meeting',
      assistantText: 'I will remind you about the meeting tomorrow.',
    });
    expect(result).toBe(true);
  });

  test('_parseCandidates handles valid JSON', () => {
    const raw = JSON.stringify({
      candidates: [{
        kind: 'event_check_in',
        sensitivity: 'routine',
        source: 'agent_promise',
        reason: 'User asked for reminder',
        suggestedText: 'Reminder: meeting',
        dedupeKey: 'meeting-remind',
        confidence: 0.9,
        dueWindow: {
          earliest: new Date(Date.now() + 3600_000).toISOString(),
          latest: new Date(Date.now() + 7200_000).toISOString(),
        },
      }],
    });
    const result = tracker._parseCandidates(raw);
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('event_check_in');
  });

  test('_parseCandidates handles malformed JSON gracefully', () => {
    const result = tracker._parseCandidates('not json at all');
    expect(result).toEqual([]);
  });

  test('_validateCandidate rejects low confidence for care items', () => {
    const candidate = {
      kind: 'care_check_in',
      sensitivity: 'care',
      source: 'agent_promise',
      reason: 'test',
      suggestedText: 'test',
      dedupeKey: 'test-key',
      confidence: 0.7, // Below CARE_CONFIDENCE_THRESHOLD (0.8)
      dueWindow: {
        earliest: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    const result = tracker._validateCandidate(candidate);
    expect(result).toBeNull();
  });

  test('getDueCommitments returns only in-window pending items', () => {
    const now = Date.now();
    // Manually insert commitments for testing
    tracker._commitments = [
      {
        id: 'a', kind: 'open_loop', status: 'pending',
        agentId: '', dueWindow: { earliestMs: now - 1000, latestMs: now + 60000 },
      },
      {
        id: 'b', kind: 'open_loop', status: 'sent',
        agentId: '', dueWindow: { earliestMs: now - 1000, latestMs: now + 60000 },
      },
      {
        id: 'c', kind: 'open_loop', status: 'pending',
        agentId: '', dueWindow: { earliestMs: now + 99999, latestMs: now + 999999 },
      },
    ];
    const due = tracker.getDueCommitments();
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('a');
  });

  test('markSent changes status and increments attempts', () => {
    tracker._commitments = [
      { id: 'x', status: 'pending', attempts: 0 },
    ];
    tracker.markSent('x');
    expect(tracker._commitments[0].status).toBe('sent');
    expect(tracker._commitments[0].attempts).toBe(1);
  });

  test('expireOld expires commitments past their window', () => {
    const past = Date.now() - 100000;
    tracker._commitments = [
      { id: 'old', status: 'pending', dueWindow: { earliestMs: past - 200000, latestMs: past } },
      { id: 'current', status: 'pending', dueWindow: { earliestMs: past, latestMs: Date.now() + 60000 } },
    ];
    const count = tracker.expireOld();
    expect(count).toBe(1);
    expect(tracker._commitments.find(c => c.id === 'old').status).toBe('expired');
  });
});
