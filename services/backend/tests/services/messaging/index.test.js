'use strict';

describe('services/messaging/index', () => {
  it('should export ilinkAccountStore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkAccountStore).toBeDefined();
  });

  it('should export ilinkApi', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkApi).toBeDefined();
  });

  it('should export ilinkBindingStore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkBindingStore).toBeDefined();
  });

  it('should export ilinkCore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkCore).toBeDefined();
  });

  it('should export ilinkCrypto', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkCrypto).toBeDefined();
  });

  it('should export ilinkLogin', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkLogin).toBeDefined();
  });

  it('should export ilinkMedia', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.ilinkMedia).toBeDefined();
  });

  it('should export msgChannelCore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.msgChannelCore).toBeDefined();
  });

  it('should export msgConfigStore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.msgConfigStore).toBeDefined();
  });

  it('should export msgInboundCore', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.msgInboundCore).toBeDefined();
  });

  it('should export msgReplyBridge', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.msgReplyBridge).toBeDefined();
  });

  it('should export msgSender', () => {
    const mod = require('../../../src/services/messaging');
    expect(mod.msgSender).toBeDefined();
  });
});
