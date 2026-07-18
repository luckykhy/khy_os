'use strict';

/**
 * Tests for serviceRegistry.js — lazy-loaded service discovery.
 *
 * Loads a fresh module each time to avoid cross-test pollution from
 * auto-registered services.
 */

function loadFreshRegistry() {
  const modPath = require.resolve('../../src/services/serviceRegistry');
  delete require.cache[modPath];
  return require('../../src/services/serviceRegistry');
}

describe('serviceRegistry', () => {
  let registry;

  beforeEach(() => {
    jest.resetModules();
    registry = loadFreshRegistry();
  });

  test('register and get a service', () => {
    const service = { greet: () => 'hello' };
    registry.register('testService', () => service, {
      category: 'test',
      description: 'A test service',
    });
    expect(registry.has('testService')).toBe(true);
    expect(registry.get('testService')).toBe(service);
  });

  test('get throws for unregistered service', () => {
    expect(() => registry.get('nonexistent')).toThrow('Service not registered');
  });

  test('register throws for invalid name', () => {
    expect(() => registry.register('', () => {})).toThrow('non-empty string');
  });

  test('register throws for non-function factory', () => {
    expect(() => registry.register('bad', 'not-a-function')).toThrow('factory must be a function');
  });

  test('lazy loading: factory is not called until get()', () => {
    const factory = jest.fn(() => ({ value: 42 }));
    registry.register('lazy', factory);
    expect(factory).not.toHaveBeenCalled();
    const instance = registry.get('lazy');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(instance.value).toBe(42);
    // Second get returns cached instance
    registry.get('lazy');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('list returns all registered services with metadata', () => {
    registry.register('svcA', () => ({}), { category: 'core', description: 'Service A' });
    const listed = registry.list();
    const svcA = listed.find(s => s.name === 'svcA');
    expect(svcA).toBeTruthy();
    expect(svcA.category).toBe('core');
    expect(svcA.loaded).toBe(false);
  });

  test('stats reports correct counts', () => {
    registry.register('s1', () => ({}));
    registry.register('s2', () => { throw new Error('boom'); });
    registry.get('s1');
    try { registry.get('s2'); } catch { /* expected */ }
    const s = registry.stats();
    expect(s.loaded).toBeGreaterThanOrEqual(1);
    expect(s.errored).toBeGreaterThanOrEqual(1);
  });

  test('getByCategory filters services', () => {
    registry.register('gw1', () => ({}), { category: 'gateway' });
    registry.register('core1', () => ({}), { category: 'core' });
    const gw = registry.getByCategory('gateway');
    expect(gw.has('gw1')).toBe(true);
    expect(gw.has('core1')).toBe(false);
  });
});
