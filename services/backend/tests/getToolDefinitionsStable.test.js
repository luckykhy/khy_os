'use strict';

const test = require('node:test');
const assert = require('node:assert');

const toolCalling = require('../src/services/toolCalling');

test('getToolDefinitions is sorted by name under KHY_STABLE_PREFIX=1', () => {
  const prev = process.env.KHY_STABLE_PREFIX;
  process.env.KHY_STABLE_PREFIX = '1';
  try {
    const defs = toolCalling.getToolDefinitions();
    assert.ok(Array.isArray(defs) && defs.length > 1, 'tool definitions available');
    const names = defs.map((d) => String(d.name || ''));
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(names, sorted, 'names are in stable sorted order');
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
    assert.deepStrictEqual(a, b, 'two calls yield identical order');
    // The "last tool" Anthropic cache breakpoint is deterministic.
    assert.strictEqual(a[a.length - 1], b[b.length - 1]);
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
    assert.ok(Array.isArray(defs) && defs.length > 0);
    const names = defs.map((d) => String(d.name || ''));
    const uniq = new Set(names.map((n) => n.toLowerCase().replace(/_/g, '')));
    assert.strictEqual(uniq.size, names.length, 'no normalized duplicates');
  } finally {
    if (prev === undefined) delete process.env.KHY_STABLE_PREFIX;
    else process.env.KHY_STABLE_PREFIX = prev;
  }
});
