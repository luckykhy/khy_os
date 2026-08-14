'use strict';

const riskGate = require('../../src/services/riskGate');

describe('riskGate.assess — step type derivation', () => {
  test('read-only tool → hardened', () => {
    const r = riskGate.assess('read_file', { file_path: '/tmp/a.txt' }, {
      resolvedName: 'read_file',
      tool: { risk: 'low' },
    });
    expect(r.stepType).toBe(riskGate.STEP_TYPES.HARDENED);
    expect(r.source).toBe('tool');
  });

  test('safe static risk → hardened', () => {
    const r = riskGate.assess('ask_user_question', {}, {
      resolvedName: 'ask_user_question',
      tool: { risk: 'safe' },
    });
    expect(r.stepType).toBe(riskGate.STEP_TYPES.HARDENED);
  });

  test('medium-risk non-destructive tool → flexible', () => {
    const r = riskGate.assess('open_app', { name: 'docker' }, {
      resolvedName: 'open_app',
      tool: { risk: 'medium' },
    });
    expect(r.stepType).toBe(riskGate.STEP_TYPES.FLEXIBLE);
  });

  test('high static risk → human-gate', () => {
    const r = riskGate.assess('publish', {}, {
      resolvedName: 'publish',
      tool: { risk: 'high' },
    });
    expect(r.stepType).toBe(riskGate.STEP_TYPES.HUMAN_GATE);
    expect(riskGate.requiresHumanGate(r.stepType)).toBe(true);
  });

  test('shell tool is routed to the command classifier', () => {
    const r = riskGate.assess('bash', { command: 'ls -la' });
    expect(r.source).toBe('shell');
    expect(['hardened', 'flexible', 'human-gate']).toContain(r.stepType);
  });

  test('destructive shell command → human-gate', () => {
    const r = riskGate.assess('bash', { command: 'rm -rf /tmp/some-dir' });
    expect(r.source).toBe('shell');
    expect(r.stepType).toBe(riskGate.STEP_TYPES.HUMAN_GATE);
  });

  test('deriveStepType prioritizes destructive over low risk', () => {
    const st = riskGate.deriveStepType({ risk: 'low', isReadOnly: false, isDestructive: true });
    expect(st).toBe(riskGate.STEP_TYPES.HUMAN_GATE);
  });
});

describe('riskGate.isUnbypassableGate — the bypass backstop predicate', () => {
  test('critical human-gate is unbypassable', () => {
    expect(riskGate.isUnbypassableGate({
      stepType: 'human-gate', riskLevel: 'critical', isDestructive: false,
    })).toBe(true);
  });

  test('destructive human-gate is unbypassable EVEN when only high-risk (the closed gap)', () => {
    // e.g. `rm notes.txt`: destructive + high, NOT critical. Previously slipped
    // through bypass auto-approve; must now be unbypassable.
    expect(riskGate.isUnbypassableGate({
      stepType: 'human-gate', riskLevel: 'high', isDestructive: true,
    })).toBe(true);
  });

  test('ordinary high-risk but REVERSIBLE human-gate stays bypassable (Goal Mode autonomy)', () => {
    expect(riskGate.isUnbypassableGate({
      stepType: 'human-gate', riskLevel: 'high', isDestructive: false,
    })).toBe(false);
  });

  test('non-human-gate steps are never unbypassable', () => {
    expect(riskGate.isUnbypassableGate({
      stepType: 'flexible', riskLevel: 'critical', isDestructive: true,
    })).toBe(false);
    expect(riskGate.isUnbypassableGate({
      stepType: 'hardened', riskLevel: 'low', isDestructive: false,
    })).toBe(false);
  });

  test('null / malformed assessment → false (fail to "not a gate", caller defaults safe elsewhere)', () => {
    expect(riskGate.isUnbypassableGate(null)).toBe(false);
    expect(riskGate.isUnbypassableGate(undefined)).toBe(false);
    expect(riskGate.isUnbypassableGate({})).toBe(false);
  });

  test('end-to-end: a destructive non-critical shell command assesses as unbypassable', () => {
    const a = riskGate.assess('shell_command', { command: 'rm notes.txt' });
    expect(a.isDestructive).toBe(true);
    expect(a.riskLevel).not.toBe('critical'); // high, not critical
    expect(riskGate.isUnbypassableGate(a)).toBe(true);
  });
});
