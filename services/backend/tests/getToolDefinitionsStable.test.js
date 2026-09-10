'use strict';
const toolCalling = require('../src/services/toolCalling');

describe('Get Tool Definitions Stable', () => {
  test('getToolDefinitions is sorted by name under KHY_STABLE_PREFIX=1', () => {
      const prev = process.env.KHY_STABLE_PREFIX;
      process.env.KHY_STABLE_PREFIX = '1';
      try {
        const defs = toolCalling.getToolDefinitions();
        expect(Array.isArray(defs) && defs.length > 1).toBeTruthy();
        const names = defs.map((d) => String(d.name || ''));
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names).toEqual(sorted, 'names are in stable sorted order');
      } finally {
        if (prev === undefined) delete process.env.KHY_STABLE_PREFIX;
        else process.env.KHY_STABLE_PREFIX = prev;
      }
  });

  test('sorted order is identical across repeated calls (byte-stable tool block)', () => {
      const prev = process.env.KHY_STABLE_PREFIX;
      process.env.KHY_STABLE_PREFIX = '1';
      try {
        const a = toolCalling.getToolDefinitions().map((d) => d.name);
        const b = toolCalling.getToolDefinitions().map((d) => d.name);
        expect(a).toEqual(b, 'two calls yield identical order');
        // The "last tool" Anthropic cache breakpoint is deterministic.
        expect(a[a.length - 1]).toBe(b[b.length - 1]);
      } finally {
        if (prev === undefined) delete process.env.KHY_STABLE_PREFIX;
        else process.env.KHY_STABLE_PREFIX = prev;
      }
  });

  test('default (flag off) preserves dedup and returns a non-empty set', () => {
      const prev = process.env.KHY_STABLE_PREFIX;
      delete process.env.KHY_STABLE_PREFIX;
      try {
        const defs = toolCalling.getToolDefinitions();
        expect(Array.isArray(defs).toBeTruthy() && defs.length > 0);
        const names = defs.map((d) => String(d.name || ''));
        const uniq = new Set(names.map((n) => n.toLowerCase().replace(/_/g, '')));
        expect(uniq.size).toBe(names.length, 'no normalized duplicates');
      } finally {
        if (prev === undefined) delete process.env.KHY_STABLE_PREFIX;
        else process.env.KHY_STABLE_PREFIX = prev;
      }
  });

});

