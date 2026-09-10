'use strict';

const stateMachine = require('../../src/services/stateMachine/index');

describe('stateMachine index', () => {
  test('module is defined', () => {
    expect(stateMachine).toBeDefined();
  });

  test('exports agentLifecycle', () => {
    expect(stateMachine.agentLifecycle).toBeDefined();
  });

  test('exports debugLog', () => {
    expect(stateMachine.debugLog).toBeDefined();
  });

  test('exports fsm', () => {
    expect(stateMachine.fsm).toBeDefined();
  });

  test('exports replPhases', () => {
    expect(stateMachine.replPhases).toBeDefined();
  });

  test('exports startupPhases', () => {
    expect(stateMachine.startupPhases).toBeDefined();
  });

  test('exports toolLoopPhases', () => {
    expect(stateMachine.toolLoopPhases).toBeDefined();
  });

  test('exports turnPhaseTracker', () => {
    expect(stateMachine.turnPhaseTracker).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof stateMachine.agentLifecycle).toBe('object');
    expect(typeof stateMachine.debugLog).toBe('object');
    expect(typeof stateMachine.fsm).toBe('object');
    expect(typeof stateMachine.replPhases).toBe('object');
    expect(typeof stateMachine.startupPhases).toBe('object');
    expect(typeof stateMachine.toolLoopPhases).toBe('object');
    expect(typeof stateMachine.turnPhaseTracker).toBe('object');
  });
});

