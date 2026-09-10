'use strict';

const channels = require('../../src/services/channels/index');

describe('channels index', () => {
  test('module is defined', () => {
    expect(channels).toBeDefined();
  });

  test('exports dingtalkChannel', () => {
    expect(channels.dingtalkChannel).toBeDefined();
  });

  test('exports feishuChannel', () => {
    expect(channels.feishuChannel).toBeDefined();
  });

  test('exports ilinkChannel', () => {
    expect(channels.ilinkChannel).toBeDefined();
  });

  test('exports ilinkDispatcher', () => {
    expect(channels.ilinkDispatcher).toBeDefined();
  });

  test('exports ilinkExecutionLock', () => {
    expect(channels.ilinkExecutionLock).toBeDefined();
  });

  test('exports imAdapterChannel', () => {
    expect(channels.imAdapterChannel).toBeDefined();
  });

  test('exports messageRouter', () => {
    expect(channels.messageRouter).toBeDefined();
  });

  test('exports slackChannel', () => {
    expect(channels.slackChannel).toBeDefined();
  });

  test('exports wecomChannel', () => {
    expect(channels.wecomChannel).toBeDefined();
  });

  test('exports _baseChannel', () => {
    expect(channels._baseChannel).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof channels.dingtalkChannel).toBe('object');
    expect(typeof channels.feishuChannel).toBe('object');
    expect(typeof channels.ilinkChannel).toBe('object');
    expect(typeof channels.ilinkDispatcher).toBe('object');
    expect(typeof channels.ilinkExecutionLock).toBe('object');
    expect(typeof channels.imAdapterChannel).toBe('object');
    expect(typeof channels.messageRouter).toBe('object');
    expect(typeof channels.slackChannel).toBe('object');
    expect(typeof channels.wecomChannel).toBe('object');
    expect(typeof channels._baseChannel).toBe('object');
  });
});

