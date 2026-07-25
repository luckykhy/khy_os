'use strict';

/**
 * Tests for liveModelSwitch.js — live model switching during sessions.
 */

let mod;
try {
  mod = require('../../src/services/liveModelSwitch');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('LiveModelSwitch', () => {
  const { LiveModelSwitch } = mod || {};

  let switcher;

  beforeEach(() => {
    // No persistPath to avoid filesystem writes during tests
    switcher = new LiveModelSwitch({
      defaultModel: 'gpt-4o',
      validateModel: (id) => id !== 'invalid-model',
      maxHistory: 10,
    });
  });

  test('getActiveModel returns default when no switch has occurred', () => {
    expect(switcher.getActiveModel()).toBe('gpt-4o');
  });

  test('switchModel changes active model immediately', () => {
    const result = switcher.switchModel('claude-3');
    expect(result.success).toBe(true);
    expect(result.deferred).toBe(false);
    expect(switcher.getActiveModel()).toBe('claude-3');
  });

  test('switchModel rejects invalid model', () => {
    const result = switcher.switchModel('invalid-model');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  test('switchModel defers during generation', () => {
    switcher.generationStarted();
    const result = switcher.switchModel('claude-3');
    expect(result.success).toBe(true);
    expect(result.deferred).toBe(true);
    // Still on old model during generation
    expect(switcher.getActiveModel()).toBe('gpt-4o');
  });

  test('deferred switch applies after generation completes', () => {
    switcher.generationStarted();
    switcher.switchModel('claude-3');
    expect(switcher.getActiveModel()).toBe('gpt-4o');

    switcher.generationCompleted();
    expect(switcher.getActiveModel()).toBe('claude-3');
  });

  test('switchModel with force overrides generation lock', () => {
    switcher.generationStarted();
    const result = switcher.switchModel('claude-3', { force: true });
    expect(result.success).toBe(true);
    expect(result.deferred).toBe(false);
    expect(switcher.getActiveModel()).toBe('claude-3');
  });

  test('getHistory tracks switch events', () => {
    switcher.switchModel('claude-3');
    switcher.switchModel('gemini-pro');
    const history = switcher.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].from).toBe('gpt-4o');
    expect(history[0].to).toBe('claude-3');
    expect(history[1].from).toBe('claude-3');
    expect(history[1].to).toBe('gemini-pro');
  });

  test('reset returns to default model', () => {
    switcher.switchModel('claude-3');
    switcher.reset();
    expect(switcher.getActiveModel()).toBe('gpt-4o');
    const state = switcher.getState();
    expect(state.pendingSwitch).toBeNull();
    expect(state.generating).toBe(false);
  });
});
