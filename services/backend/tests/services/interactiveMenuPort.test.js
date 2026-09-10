'use strict';

const {
  registerMenuPrompter,
  getMenuPrompter,
  _resetForTest,
} = require('../../src/services/interactiveMenuPort');

describe('interactiveMenuPort', () => {
  beforeEach(() => {
    _resetForTest();
  });

  afterAll(() => {
    _resetForTest();
  });

  describe('registerMenuPrompter', () => {
    test('registers a function prompter', () => {
      const mockPrompter = jest.fn();
      registerMenuPrompter(mockPrompter);
      expect(getMenuPrompter()).toBe(mockPrompter);
    });

    test('replaces existing prompter', () => {
      const first = jest.fn();
      const second = jest.fn();
      registerMenuPrompter(first);
      registerMenuPrompter(second);
      expect(getMenuPrompter()).toBe(second);
    });

    test('sets null when registering non-function', () => {
      registerMenuPrompter('not a function');
      expect(getMenuPrompter()).toBeNull();
    });

    test('sets null when registering null', () => {
      registerMenuPrompter(null);
      expect(getMenuPrompter()).toBeNull();
    });

    test('sets null when registering undefined', () => {
      registerMenuPrompter(undefined);
      expect(getMenuPrompter()).toBeNull();
    });

    test('sets null when registering object', () => {
      registerMenuPrompter({});
      expect(getMenuPrompter()).toBeNull();
    });

    test('sets null when registering number', () => {
      registerMenuPrompter(42);
      expect(getMenuPrompter()).toBeNull();
    });

    test('sets null when registering boolean', () => {
      registerMenuPrompter(true);
      expect(getMenuPrompter()).toBeNull();
    });
  });

  describe('getMenuPrompter', () => {
    test('returns null when no prompter registered', () => {
      expect(getMenuPrompter()).toBeNull();
    });

    test('returns the registered prompter', () => {
      const mockPrompter = jest.fn().mockResolvedValue('choice1');
      registerMenuPrompter(mockPrompter);
      expect(getMenuPrompter()).toBe(mockPrompter);
    });

    test('returns null after reset', () => {
      registerMenuPrompter(jest.fn());
      _resetForTest();
      expect(getMenuPrompter()).toBeNull();
    });
  });

  describe('_resetForTest', () => {
    test('clears the registered prompter', () => {
      registerMenuPrompter(jest.fn());
      _resetForTest();
      expect(getMenuPrompter()).toBeNull();
    });

    test('is idempotent', () => {
      _resetForTest();
      _resetForTest();
      expect(getMenuPrompter()).toBeNull();
    });
  });
});
