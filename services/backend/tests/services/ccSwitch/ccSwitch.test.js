'use strict';

const ccSwitch = require('../../src/services/ccSwitch/index');

describe('ccSwitch index', () => {
  test('module is defined', () => {
    expect(ccSwitch).toBeDefined();
  });

  test('exports apiHandlers', () => {
    expect(ccSwitch.apiHandlers).toBeDefined();
  });

  test('exports appWriters', () => {
    expect(ccSwitch.appWriters).toBeDefined();
  });

  test('exports codexWriter', () => {
    expect(ccSwitch.codexWriter).toBeDefined();
  });

  test('exports connectivity', () => {
    expect(ccSwitch.connectivity).toBeDefined();
  });

  test('exports constants', () => {
    expect(ccSwitch.constants).toBeDefined();
  });

  test('exports opencodeGoQuota', () => {
    expect(ccSwitch.opencodeGoQuota).toBeDefined();
  });

  test('exports promptGuard', () => {
    expect(ccSwitch.promptGuard).toBeDefined();
  });

  test('exports routeResolver', () => {
    expect(ccSwitch.routeResolver).toBeDefined();
  });

  test('exports store', () => {
    expect(ccSwitch.store).toBeDefined();
  });

  test('exports usageScan', () => {
    expect(ccSwitch.usageScan).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof ccSwitch.apiHandlers).toBe('object');
    expect(typeof ccSwitch.appWriters).toBe('object');
    expect(typeof ccSwitch.codexWriter).toBe('object');
    expect(typeof ccSwitch.connectivity).toBe('object');
    expect(typeof ccSwitch.constants).toBe('object');
    expect(typeof ccSwitch.opencodeGoQuota).toBe('object');
    expect(typeof ccSwitch.promptGuard).toBe('object');
    expect(typeof ccSwitch.routeResolver).toBe('object');
    expect(typeof ccSwitch.store).toBe('object');
    expect(typeof ccSwitch.usageScan).toBe('object');
  });
});

