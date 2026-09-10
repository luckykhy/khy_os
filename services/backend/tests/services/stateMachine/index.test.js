'use strict';

describe('services/stateMachine/index', () => {
  it('should export agentLifecycle', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.agentLifecycle).toBeDefined();
  });

  it('should export debugLog', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.debugLog).toBeDefined();
  });

  it('should export fsm', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.fsm).toBeDefined();
  });

  it('should export replPhases', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.replPhases).toBeDefined();
  });

  it('should export startupPhases', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.startupPhases).toBeDefined();
  });

  it('should export toolLoopPhases', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.toolLoopPhases).toBeDefined();
  });

  it('should export turnPhaseTracker', () => {
    const mod = require('../../../src/services/stateMachine');
    expect(mod.turnPhaseTracker).toBeDefined();
  });
});
