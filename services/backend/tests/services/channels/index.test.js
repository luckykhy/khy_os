'use strict';

describe('services/channels/index', () => {
  it('should export dingtalkChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.dingtalkChannel).toBeDefined();
  });

  it('should export feishuChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.feishuChannel).toBeDefined();
  });

  it('should export ilinkChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.ilinkChannel).toBeDefined();
  });

  it('should export ilinkDispatcher', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.ilinkDispatcher).toBeDefined();
  });

  it('should export ilinkExecutionLock', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.ilinkExecutionLock).toBeDefined();
  });

  it('should export imAdapterChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.imAdapterChannel).toBeDefined();
  });

  it('should export messageRouter', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.messageRouter).toBeDefined();
  });

  it('should export slackChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.slackChannel).toBeDefined();
  });

  it('should export wecomChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod.wecomChannel).toBeDefined();
  });

  it('should export _baseChannel', () => {
    const mod = require('../../../src/services/channels');
    expect(mod._baseChannel).toBeDefined();
  });
});
