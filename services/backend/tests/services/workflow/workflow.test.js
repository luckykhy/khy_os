'use strict';

const workflow = require('../../src/services/workflow/index');

describe('workflow index', () => {
  test('module is defined', () => {
    expect(workflow).toBeDefined();
  });

  test('exports contractChecker', () => {
    expect(workflow.contractChecker).toBeDefined();
  });

  test('exports flowRegistry', () => {
    expect(workflow.flowRegistry).toBeDefined();
  });

  test('exports flowStats', () => {
    expect(workflow.flowStats).toBeDefined();
  });

  test('exports retryPrimitives', () => {
    expect(workflow.retryPrimitives).toBeDefined();
  });

  test('exports workflowCliCore', () => {
    expect(workflow.workflowCliCore).toBeDefined();
  });

  test('exports workflowExecutor', () => {
    expect(workflow.workflowExecutor).toBeDefined();
  });

  test('exports workflowRunWorker', () => {
    expect(workflow.workflowRunWorker).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof workflow.contractChecker).toBe('object');
    expect(typeof workflow.flowRegistry).toBe('object');
    expect(typeof workflow.flowStats).toBe('object');
    expect(typeof workflow.retryPrimitives).toBe('object');
    expect(typeof workflow.workflowCliCore).toBe('object');
    expect(typeof workflow.workflowExecutor).toBe('object');
    expect(typeof workflow.workflowRunWorker).toBe('object');
  });
});

