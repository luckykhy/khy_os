'use strict';

// capacityFlow diagnostics overlay — proves the blind spot is closed:
// preRequestCheckpoint used to decide purely on token ratio (overflow only).
// Now a poisoned/distracted context at a HEALTHY token ratio escalates,
// while existing ratio-only behavior stays byte-identical and zero-regression.

const cf = require('../../src/services/capacityFlow');

const DIAG_ENV = ['KHY_CONTEXT_DIAGNOSTICS'];
afterEach(() => { for (const k of DIAG_ENV) delete process.env[k]; });

function asstMsg(t) { return { role: 'assistant', content: t }; }
function userMsg(t) { return { role: 'user', content: t }; }
function toolMsg(t) { return { role: 'tool', content: t }; }

// A low-token-ratio but self-poisoned context (assistant echo ×3).
function poisonedMessages() {
  const echo = 'The root cause is a missing await; I will add it and retry the build now.';
  return [
    userMsg('build is failing'),
    asstMsg(echo), toolMsg('build failed'),
    asstMsg(echo), toolMsg('build failed'),
    asstMsg(echo),
  ];
}

function healthyMessages() {
  return [
    userMsg('rename the variable foo to userId across the module'),
    asstMsg('I will locate all references to foo first.'),
    toolMsg('found 3 references in user.js'),
    asstMsg('Renaming each reference to userId now.'),
  ];
}

describe('capacityFlow diagnostics overlay', () => {
  test('no messages → identical to legacy ratio-only behavior', () => {
    const r = cf.preRequestCheckpoint({ usedTokens: 1000, contextWindow: 128000 });
    expect(r.decision).toBe(cf.CapacityDecision.None);
    expect(r.details.diagnostics).toBeUndefined();
  });

  test('healthy context at low ratio → None, but diagnostics attached for observability', () => {
    const r = cf.preRequestCheckpoint({
      usedTokens: 2000, contextWindow: 128000, messages: healthyMessages(),
    });
    expect(r.decision).toBe(cf.CapacityDecision.None);
    expect(r.details.diagnostics).toBeDefined();
    expect(r.details.diagnostics.health).toBeGreaterThanOrEqual(80);
  });

  test('poisoned context at HEALTHY token ratio escalates to TargetedRefresh', () => {
    const r = cf.preRequestCheckpoint({
      usedTokens: 3000, contextWindow: 128000, messages: poisonedMessages(),
    });
    expect(r.decision).toBe(cf.CapacityDecision.TargetedRefresh);
    expect(r.details.triggeredBy).toBe('diagnostics');
    expect(['poisoning', 'distraction', 'confusion']).toContain(r.details.failureMode);
  });

  test('observe mode attaches diagnostics but never changes the decision', () => {
    process.env.KHY_CONTEXT_DIAGNOSTICS = 'observe';
    const r = cf.preRequestCheckpoint({
      usedTokens: 3000, contextWindow: 128000, messages: poisonedMessages(),
    });
    expect(r.decision).toBe(cf.CapacityDecision.None); // not escalated
    expect(r.details.diagnostics).toBeDefined();
  });

  test('off mode disables diagnostics entirely', () => {
    process.env.KHY_CONTEXT_DIAGNOSTICS = 'off';
    const r = cf.preRequestCheckpoint({
      usedTokens: 3000, contextWindow: 128000, messages: poisonedMessages(),
    });
    expect(r.decision).toBe(cf.CapacityDecision.None);
    expect(r.details.diagnostics).toBeUndefined();
  });

  test('overlay only escalates, never downgrades an existing decision', () => {
    // Critical ratio → legacy returns TargetedRefresh/Critical. Even on a poisoned
    // context the overlay must not weaken it; diagnostics is attached for observability.
    const r = cf.preRequestCheckpoint({
      usedTokens: 120000, contextWindow: 128000, messages: poisonedMessages(),
    });
    expect(r.decision).toBe(cf.CapacityDecision.TargetedRefresh);
    expect(r.risk).toBe(cf.RiskLevel.Critical);
    expect(r.details.diagnostics).toBeDefined();
  });

  test('_ratioDecision stays pure ratio logic (no diagnostics)', () => {
    const r = cf._ratioDecision({ usedTokens: 3000, contextWindow: 128000, messages: poisonedMessages() });
    expect(r.decision).toBe(cf.CapacityDecision.None);
    expect(r.details.diagnostics).toBeUndefined();
  });
});
