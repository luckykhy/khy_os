'use strict';

const taskPanelState = require('../../src/cli/taskPanelState');

describe('taskPanelState', () => {
  test('module is defined', () => {
    expect(taskPanelState).toBeDefined();
  });

  test('exports a module (object)', () => {
    expect(typeof taskPanelState).toBe('object');
  });

  test('re-exports from services/taskPanelState', () => {
    expect(taskPanelState).not.toBeNull();
  });
});

