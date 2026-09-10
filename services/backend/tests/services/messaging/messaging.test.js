'use strict';

const messaging = require('../../src/services/messaging/index');

describe('messaging index', () => {
  test('module is defined', () => {
    expect(messaging).toBeDefined();
  });

  test('exports ilinkAccountStore', () => {
    expect(messaging.ilinkAccountStore).toBeDefined();
  });

  test('exports ilinkApi', () => {
    expect(messaging.ilinkApi).toBeDefined();
  });

  test('exports ilinkBindingStore', () => {
    expect(messaging.ilinkBindingStore).toBeDefined();
  });

  test('exports ilinkCore', () => {
    expect(messaging.ilinkCore).toBeDefined();
  });

  test('exports ilinkCrypto', () => {
    expect(messaging.ilinkCrypto).toBeDefined();
  });

  test('exports ilinkLogin', () => {
    expect(messaging.ilinkLogin).toBeDefined();
  });

  test('exports ilinkMedia', () => {
    expect(messaging.ilinkMedia).toBeDefined();
  });

  test('exports msgChannelCore', () => {
    expect(messaging.msgChannelCore).toBeDefined();
  });

  test('exports msgConfigStore', () => {
    expect(messaging.msgConfigStore).toBeDefined();
  });

  test('exports msgInboundCore', () => {
    expect(messaging.msgInboundCore).toBeDefined();
  });

  test('exports msgReplyBridge', () => {
    expect(messaging.msgReplyBridge).toBeDefined();
  });

  test('exports msgSender', () => {
    expect(messaging.msgSender).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof messaging.ilinkAccountStore).toBe('object');
    expect(typeof messaging.ilinkApi).toBe('object');
    expect(typeof messaging.ilinkBindingStore).toBe('object');
    expect(typeof messaging.ilinkCore).toBe('object');
    expect(typeof messaging.ilinkCrypto).toBe('object');
    expect(typeof messaging.ilinkLogin).toBe('object');
    expect(typeof messaging.ilinkMedia).toBe('object');
    expect(typeof messaging.msgChannelCore).toBe('object');
    expect(typeof messaging.msgConfigStore).toBe('object');
    expect(typeof messaging.msgInboundCore).toBe('object');
    expect(typeof messaging.msgReplyBridge).toBe('object');
    expect(typeof messaging.msgSender).toBe('object');
  });
});

