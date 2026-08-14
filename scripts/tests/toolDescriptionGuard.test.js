'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const guard = require('../lib/toolDescriptionGuard');

// Minimal well-formed tool in the flat defineTool inputSchema shape.
function goodTool(overrides = {}) {
  return {
    name: 'demo_tool',
    description: 'Reads a file. Use for text files, not directories. Max 10 MB.',
    inputSchema: {
      path: { type: 'string', required: true, description: 'Absolute file path. Example: /tmp/a.txt' },
    },
    ...overrides,
  };
}

function rulesOf(result) {
  return result.findings.map((f) => `${f.severity}:${f.rule}`).sort();
}

// ── env gate ────────────────────────────────────────────────────────
test('isEnabled: default on', () => {
  assert.strictEqual(guard.isEnabled({}), true);
});
test('isEnabled: 0/false/off/no disable', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(guard.isEnabled({ KHY_TOOL_DESC_GUARD: v }), false);
  }
});
test('gate off → empty findings even for a broken tool', () => {
  const r = guard.assessTools([{ name: 'x', description: '' }], { KHY_TOOL_DESC_GUARD: '0' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.total, 0);
});

// ── rule 1: desc-missing (error) ────────────────────────────────────
test('desc-missing: empty description → error', () => {
  const r = guard.assessTools([goodTool({ description: '   ' })], {});
  assert.deepStrictEqual(rulesOf(r), ['error:desc-missing']);
  assert.strictEqual(r.errors, 1);
});
test('desc-missing: absent description → error', () => {
  const t = goodTool();
  delete t.description;
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), ['error:desc-missing']);
});
test('desc-missing: non-empty description → no finding', () => {
  const r = guard.assessTools([goodTool()], {});
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.total, 1);
});

// ── rule 2: desc-overlong (warning) ─────────────────────────────────
test('desc-overlong: 601 chars → warning; 600 chars → pass', () => {
  const over = guard.assessTools([goodTool({ description: 'x'.repeat(601) })], {});
  assert.deepStrictEqual(rulesOf(over), ['warning:desc-overlong']);
  assert.strictEqual(over.warnings, 1);
  const atLimit = guard.assessTools([goodTool({ description: 'x'.repeat(600) })], {});
  assert.deepStrictEqual(atLimit.findings, []);
});
test('MAX_DESCRIPTION_LENGTH matches the 600-char guideline', () => {
  assert.strictEqual(guard.MAX_DESCRIPTION_LENGTH, 600);
});

// ── rule 3: param-desc-missing (error) ──────────────────────────────
test('param-desc-missing: required param without description → error', () => {
  const t = goodTool({ inputSchema: { path: { type: 'string', required: true } } });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), ['error:param-desc-missing']);
  assert.match(r.findings[0].message, /'path'/);
});
test('param-desc-missing: optional param without description → no error', () => {
  const t = goodTool({ inputSchema: { limit: { type: 'number' } } });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(r.findings, []);
});
test('param-desc-missing: JSON-Schema shape (BaseTool) is also audited', () => {
  const t = goodTool({
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), ['error:param-desc-missing']);
});
test('JSON-Schema shape: described required param → pass', () => {
  const t = goodTool({
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query. Example: btc price' } },
      required: ['query'],
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(r.findings, []);
});

// ── rule 4: param-naming-mixed (warning) ────────────────────────────
test('param-naming-mixed: snake_case + camelCase in one tool → warning', () => {
  const t = goodTool({
    inputSchema: {
      file_path: { type: 'string', description: 'Path. Example: /a' },
      maxLines: { type: 'number', description: 'Line cap (default: 100). Example: 50' },
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), ['warning:param-naming-mixed']);
  assert.match(r.findings[0].message, /file_path/);
  assert.match(r.findings[0].message, /maxLines/);
});
test('param-naming-mixed: single-word names are style-neutral → no warning', () => {
  const t = goodTool({
    inputSchema: {
      path: { type: 'string', description: 'Path. Example: /a' },
      maxLines: { type: 'number', description: 'Line cap (default: 100). Example: 50' },
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(r.findings, []);
});
test('param-naming-mixed: uniform snake_case → no warning', () => {
  const t = goodTool({
    inputSchema: {
      file_path: { type: 'string', description: 'Path. Example: /a' },
      max_lines: { type: 'number', description: 'Line cap (default: 100). Example: 50' },
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(r.findings, []);
});

// ── rule 5: enum-example-missing (warning) ──────────────────────────
test('enum-example-missing: enum param without example → warning', () => {
  const t = goodTool({
    inputSchema: {
      mode: { type: 'string', enum: ['fast', 'slow'], description: 'Run mode (default: fast).' },
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), ['warning:enum-example-missing']);
  assert.match(r.findings[0].message, /'mode'/);
});
test('enum-example-missing: enum param with example → no warning', () => {
  const t = goodTool({
    inputSchema: {
      mode: { type: 'string', enum: ['fast', 'slow'], description: 'Run mode (default: fast).', example: 'fast' },
    },
  });
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(r.findings, []);
});

// ── robustness: never throws, deterministic shape ───────────────────
test('never throws: null/garbage entries become error findings', () => {
  const r = guard.assessTools([null, 42, 'str', { name: 'ok', description: 'fine', inputSchema: null }], {});
  assert.strictEqual(r.total, 4);
  // The three non-objects each yield one desc-missing error; the last passes.
  assert.strictEqual(r.errors, 3);
  assert.strictEqual(r.warnings, 0);
});
test('never throws: non-array input → empty result', () => {
  const r = guard.assessTools(undefined, {});
  assert.deepStrictEqual(r, { findings: [], errors: 0, warnings: 0, total: 0 });
});
test('multiple rules on one tool accumulate', () => {
  const t = {
    name: 'messy_tool',
    description: 'x'.repeat(700),
    inputSchema: {
      file_path: { type: 'string', required: true },
      outputMode: { type: 'string', enum: ['json', 'text'], description: 'Output format (default: json).' },
    },
  };
  const r = guard.assessTools([t], {});
  assert.deepStrictEqual(rulesOf(r), [
    'error:param-desc-missing',
    'warning:desc-overlong',
    'warning:enum-example-missing',
    'warning:param-naming-mixed',
  ]);
});
test('extractParams: invalid schema → empty list', () => {
  assert.deepStrictEqual(guard.extractParams({ inputSchema: 'nope' }), []);
  assert.deepStrictEqual(guard.extractParams({}), []);
});
