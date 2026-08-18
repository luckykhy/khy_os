'use strict';

/**
 * Zero-dependency plugin SDK compatibility helpers used by the bundled CLI.
 */
function createRegistry() {
  const registered = [];
  return {
    _registered: registered,
    register(value, maybeValue) {
      const item = typeof value === 'string' ? { name: value, ...(maybeValue || {}) } : value;
      registered.push(item);
      return () => {
        const index = registered.indexOf(item);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
}

function createMockContext(overrides = {}) {
  const values = new Map();
  const listeners = new Map();
  const context = {
    host: { version: '1.0.0', capabilities: [] },
    commands: createRegistry(),
    tools: createRegistry(),
    dataSources: createRegistry(),
    storage: {
      async get(key) {
        return values.get(key);
      },
      async set(key, value) {
        values.set(key, value);
      },
      async delete(key) {
        return values.delete(key);
      },
    },
    events: {
      on(name, listener) {
        const eventListeners = listeners.get(name) || [];
        eventListeners.push(listener);
        listeners.set(name, eventListeners);
        return () => {
          const index = eventListeners.indexOf(listener);
          if (index >= 0) eventListeners.splice(index, 1);
        };
      },
      emit(name, payload) {
        for (const listener of listeners.get(name) || []) listener(payload);
      },
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    ai: {
      async complete() {
        return { content: '' };
      },
    },
  };

  return { ...context, ...overrides };
}

module.exports = { createMockContext };
