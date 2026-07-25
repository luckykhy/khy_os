'use strict';

/**
 * Tests for intentGate loop limit boosting and tool_choice forcing.
 */

const intentGate = require('../../src/services/intentGate');

describe('intentGate — getLoopLimitBoost', () => {
  test('returns outerBoost=18, innerBoost=8 for coding mode', () => {
    expect(intentGate.getLoopLimitBoost(['coding'])).toEqual({ outerBoost: 18, innerBoost: 8 });
  });

  test('returns outerBoost=12, innerBoost=6 for ultrawork mode', () => {
    expect(intentGate.getLoopLimitBoost(['ultrawork'])).toEqual({ outerBoost: 12, innerBoost: 6 });
  });

  test('returns outerBoost=6, innerBoost=4 for analyze mode', () => {
    expect(intentGate.getLoopLimitBoost(['analyze'])).toEqual({ outerBoost: 6, innerBoost: 4 });
  });

  test('returns zero boosts for empty modes array', () => {
    expect(intentGate.getLoopLimitBoost([])).toEqual({ outerBoost: 0, innerBoost: 0 });
  });

  test('returns zero boosts for null/undefined', () => {
    expect(intentGate.getLoopLimitBoost(null)).toEqual({ outerBoost: 0, innerBoost: 0 });
    expect(intentGate.getLoopLimitBoost(undefined)).toEqual({ outerBoost: 0, innerBoost: 0 });
  });

  test('coding takes priority when combined with ultrawork', () => {
    // coding is checked first in the function
    expect(intentGate.getLoopLimitBoost(['coding', 'ultrawork'])).toEqual({ outerBoost: 18, innerBoost: 8 });
    expect(intentGate.getLoopLimitBoost(['ultrawork', 'coding'])).toEqual({ outerBoost: 18, innerBoost: 8 });
  });

  test('ultrawork takes priority over analyze', () => {
    expect(intentGate.getLoopLimitBoost(['ultrawork', 'analyze'])).toEqual({ outerBoost: 12, innerBoost: 6 });
  });
});

describe('intentGate — tool_choice forcing in chatOptsPatch', () => {
  const _origEnv = {};

  beforeEach(() => {
    _origEnv.KHY_CODING_FORCE_TOOL_CHOICE = process.env.KHY_CODING_FORCE_TOOL_CHOICE;
    _origEnv.KHY_ULTRAWORK_FORCE_TOOL_CHOICE = process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE;
    delete process.env.KHY_CODING_FORCE_TOOL_CHOICE;
    delete process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE;
  });

  afterEach(() => {
    if (_origEnv.KHY_CODING_FORCE_TOOL_CHOICE !== undefined) {
      process.env.KHY_CODING_FORCE_TOOL_CHOICE = _origEnv.KHY_CODING_FORCE_TOOL_CHOICE;
    } else {
      delete process.env.KHY_CODING_FORCE_TOOL_CHOICE;
    }
    if (_origEnv.KHY_ULTRAWORK_FORCE_TOOL_CHOICE !== undefined) {
      process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE = _origEnv.KHY_ULTRAWORK_FORCE_TOOL_CHOICE;
    } else {
      delete process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE;
    }
  });

  test('coding mode returns _intentToolChoice=required by default', () => {
    const result = intentGate.applyIntentGate('create a React project with TypeScript');
    expect(result.activatedModes).toContain('coding');
    expect(result.chatOptsPatch._intentToolChoice).toBe('required');
  });

  test('ultrawork mode returns _intentToolChoice=required by default', () => {
    const result = intentGate.applyIntentGate('ultrawork fix the login bug');
    expect(result.activatedModes).toContain('ultrawork');
    expect(result.chatOptsPatch._intentToolChoice).toBe('required');
  });

  test('KHY_CODING_FORCE_TOOL_CHOICE=false disables _intentToolChoice for coding', () => {
    process.env.KHY_CODING_FORCE_TOOL_CHOICE = 'false';
    const result = intentGate.applyIntentGate('create a Django project');
    expect(result.activatedModes).toContain('coding');
    expect(result.chatOptsPatch._intentToolChoice).toBeUndefined();
  });

  test('KHY_ULTRAWORK_FORCE_TOOL_CHOICE=false disables _intentToolChoice for ultrawork', () => {
    process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE = 'false';
    const result = intentGate.applyIntentGate('ultrawork deploy the service');
    expect(result.activatedModes).toContain('ultrawork');
    expect(result.chatOptsPatch._intentToolChoice).toBeUndefined();
  });

  test('analyze mode does NOT set _intentToolChoice', () => {
    const result = intentGate.applyIntentGate('深度分析一下这个项目的架构');
    expect(result.activatedModes).toContain('analyze');
    expect(result.chatOptsPatch._intentToolChoice).toBeUndefined();
  });

  test('non-intent message does NOT set _intentToolChoice', () => {
    const result = intentGate.applyIntentGate('hello, how are you?');
    expect(result.chatOptsPatch._intentToolChoice).toBeUndefined();
  });
});
