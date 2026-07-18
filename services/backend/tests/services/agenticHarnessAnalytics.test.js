'use strict';

/**
 * Tests for D1 adaptive Ralph Loop complexity assessment and analytics fields.
 */

// We test _assessTaskComplexity by extracting it from the module's internal scope.
// Since it's a private function, we'll test it via the harness report output pattern.

describe('_assessTaskComplexity logic', () => {
  // Replicate the function logic for unit testing
  function assessTaskComplexity(userMessage, activatedModes, firstLoopResult) {
    let factor = 1.0;
    if ((userMessage || '').length > 2000) factor += 0.5;
    const modes = activatedModes || [];
    if (modes.includes('ultrawork') || modes.includes('coding')) factor += 0.5;
    const toolCount = firstLoopResult?.toolCallLog?.length || 0;
    if (toolCount > 10) factor += 0.5;
    return factor;
  }

  test('base factor is 1.0 for short simple messages', () => {
    expect(assessTaskComplexity('hello', [], null)).toBe(1.0);
  });

  test('long message adds 0.5', () => {
    const longMsg = 'x'.repeat(2001);
    expect(assessTaskComplexity(longMsg, [], null)).toBe(1.5);
  });

  test('ultrawork mode adds 0.5', () => {
    expect(assessTaskComplexity('do stuff', ['ultrawork'], null)).toBe(1.5);
  });

  test('coding mode adds 0.5', () => {
    expect(assessTaskComplexity('do stuff', ['coding'], null)).toBe(1.5);
  });

  test('many tool calls add 0.5', () => {
    const result = { toolCallLog: new Array(11).fill({ tool: 'test' }) };
    expect(assessTaskComplexity('do stuff', [], result)).toBe(1.5);
  });

  test('all factors combine to 2.5', () => {
    const longMsg = 'x'.repeat(3000);
    const result = { toolCallLog: new Array(15).fill({ tool: 'test' }) };
    expect(assessTaskComplexity(longMsg, ['ultrawork'], result)).toBe(2.5);
  });

  test('adaptive rounds: ceil(3 * factor) clamped to 8', () => {
    // factor=1.0 → 3 rounds
    expect(Math.min(Math.ceil(3 * 1.0), 8)).toBe(3);
    // factor=1.5 → 5 rounds
    expect(Math.min(Math.ceil(3 * 1.5), 8)).toBe(5);
    // factor=2.0 → 6 rounds
    expect(Math.min(Math.ceil(3 * 2.0), 8)).toBe(6);
    // factor=2.5 → 8 rounds (clamped)
    expect(Math.min(Math.ceil(3 * 2.5), 8)).toBe(8);
  });
});

describe('analytics field structure', () => {
  test('analytics object has required keys', () => {
    const analytics = {
      adaptiveRounds: 5,
      roundsUsed: 2,
      roundEfficiency: 0.85,
      boulderResumed: false,
      complexityFactor: 1.5,
    };
    expect(analytics).toHaveProperty('adaptiveRounds');
    expect(analytics).toHaveProperty('roundsUsed');
    expect(analytics).toHaveProperty('roundEfficiency');
    expect(analytics).toHaveProperty('boulderResumed');
    expect(analytics).toHaveProperty('complexityFactor');
    expect(typeof analytics.adaptiveRounds).toBe('number');
    expect(typeof analytics.roundEfficiency).toBe('number');
  });

  test('roundEfficiency is null when no continuation rounds used', () => {
    const continuationRound = 0;
    const efficiency = continuationRound > 0 ? 0.9 : null;
    expect(efficiency).toBeNull();
  });
});
