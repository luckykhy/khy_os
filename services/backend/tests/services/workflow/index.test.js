'use strict';

describe('services/workflow/index', () => {
  it('should export contractChecker', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.contractChecker).toBeDefined();
  });

  it('should export flowRegistry', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.flowRegistry).toBeDefined();
  });

  it('should export flowStats', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.flowStats).toBeDefined();
  });

  it('should export retryPrimitives', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.retryPrimitives).toBeDefined();
  });

  it('should export workflowCliCore', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.workflowCliCore).toBeDefined();
  });

  it('should export workflowExecutor', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.workflowExecutor).toBeDefined();
  });

  it('should export workflowRunWorker', () => {
    const mod = require('../../../src/services/workflow');
    expect(mod.workflowRunWorker).toBeDefined();
  });
});
