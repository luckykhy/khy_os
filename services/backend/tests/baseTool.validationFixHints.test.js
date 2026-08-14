'use strict';

/**
 * Fix-hint suggestions for tool input validation failures.
 *
 * validateParams() now emits an optional, additive `suggestions: string[]`
 * field (the `errors` array stays byte-identical — legacy path untouched):
 *   - enum failure  → fuzzy match (Levenshtein <= 2 or prefix) → `Did you mean "x"?`,
 *                     otherwise list the valid values;
 *   - type failure  → JSON preview of the received value (truncated ~80 chars);
 *   - range failure → the actual provided value.
 *
 * formatValidationError() renders them as trailing `Suggestion: …` lines,
 * gated by KHY_TOOL_FIX_HINT (default ON; =0/false/off/no → byte-identical
 * to the pre-hint output). toFunctionDef() additionally appends an optional
 * schema `example` field as ` Example: <value>` to the parameter description
 * sent to the model (no new JSON Schema fields emitted).
 */

const { validateParams, defineTool } = require('../src/tools/_baseTool');
const {
  formatValidationError,
  isValidationErrorMessage,
  levenshteinDistance,
  fixHintEnabled,
} = require('../src/tools/ccValidationError');

describe('levenshteinDistance (pure leaf)', () => {
  test('basic distances', () => {
    expect(levenshteinDistance('', '')).toBe(0);
    expect(levenshteinDistance('abc', 'abc')).toBe(0);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('', 'ab')).toBe(2);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('fast', 'fst')).toBe(1);
  });

  test('never throws on non-string input', () => {
    expect(levenshteinDistance(null, 'a')).toBe(1);
    expect(levenshteinDistance(undefined, undefined)).toBe(0);
    expect(levenshteinDistance(42, '42')).toBe(0);
  });
});

describe('validateParams suggestions (additive; errors byte-identical)', () => {
  const enumSchema = { mode: { type: 'string', enum: ['fast', 'slow', 'auto'] } };

  test('enum fuzzy hit (typo, Levenshtein <= 2) → Did you mean', () => {
    const v = validateParams(enumSchema, { mode: 'fst' });
    expect(v.valid).toBe(false);
    // errors array stays byte-identical to the legacy message
    expect(v.errors).toEqual(['mode must be one of: fast, slow, auto']);
    expect(v.suggestions).toEqual(['Did you mean "fast" for `mode`?']);
  });

  test('enum fuzzy hit (prefix match) → Did you mean', () => {
    const v = validateParams(enumSchema, { mode: 'au' });
    expect(v.suggestions).toEqual(['Did you mean "auto" for `mode`?']);
  });

  test('enum miss (no close option) → lists valid values', () => {
    const v = validateParams(enumSchema, { mode: 'zzzzzzzz' });
    expect(v.errors).toEqual(['mode must be one of: fast, slow, auto']);
    expect(v.suggestions).toEqual(['Set `mode` to one of the valid values: fast, slow, auto']);
  });

  test('type failure → suggestion carries a JSON preview of the received value', () => {
    const v = validateParams({ count: { type: 'number' } }, { count: 'abc' });
    expect(v.errors).toEqual(['count must be of type number, got string']);
    expect(v.suggestions).toEqual(['Provide `count` as number — received "abc"']);
  });

  test('type failure preview is truncated for large values (~80 chars)', () => {
    const big = { blob: 'x'.repeat(300) };
    const v = validateParams({ opts: { type: 'string' } }, { opts: big });
    expect(v.suggestions).toHaveLength(1);
    const preview = v.suggestions[0].split('received ')[1];
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith('...')).toBe(true);
  });

  test('number range failure → suggestion carries the actual provided value', () => {
    const schema = { n: { type: 'number', min: 1, max: 10 } };
    const low = validateParams(schema, { n: 0 });
    expect(low.errors).toEqual(['n must be >= 1']);
    expect(low.suggestions).toEqual(['`n` received 0, but the minimum allowed is 1']);
    const high = validateParams(schema, { n: 99 });
    expect(high.errors).toEqual(['n must be <= 10']);
    expect(high.suggestions).toEqual(['`n` received 99, but the maximum allowed is 10']);
  });

  test('no suggestions field when validation passes or only required is missing', () => {
    expect(validateParams(enumSchema, { mode: 'fast' }).suggestions).toBeUndefined();
    const v = validateParams({ x: { type: 'string', required: true } }, {});
    expect(v.valid).toBe(false);
    expect(v.suggestions).toBeUndefined();
  });
});

describe('formatValidationError Suggestion lines (KHY_TOOL_FIX_HINT gate)', () => {
  const validation = validateParams(
    { mode: { type: 'string', enum: ['fast', 'slow', 'auto'] } },
    { mode: 'fst' }
  );

  test('gate default ON → grouped message plus trailing Suggestion line(s)', () => {
    const msg = formatValidationError('my_tool', validation, {});
    expect(msg).toBe(
      'my_tool failed due to the following issue:\n' +
      'mode must be one of: fast, slow, auto\n' +
      'Suggestion: Did you mean "fast" for `mode`?'
    );
  });

  test('KHY_TOOL_FIX_HINT=off → byte-identical to pre-hint grouped output', () => {
    const off = formatValidationError('my_tool', validation, { KHY_TOOL_FIX_HINT: 'off' });
    expect(off).toBe(
      'my_tool failed due to the following issue:\nmode must be one of: fast, slow, auto'
    );
    // Same result without any suggestions present — proves additivity.
    const noSuggestions = { valid: false, errors: validation.errors, issues: validation.issues };
    expect(off).toBe(formatValidationError('my_tool', noSuggestions, {}));
    for (const flag of ['0', 'false', 'no']) {
      expect(fixHintEnabled({ KHY_TOOL_FIX_HINT: flag })).toBe(false);
    }
    expect(fixHintEnabled({})).toBe(true);
  });

  test('KHY_CC_VALIDATION_ERROR=off → legacy string untouched by suggestions', () => {
    const msg = formatValidationError('my_tool', validation, { KHY_CC_VALIDATION_ERROR: 'off' });
    expect(msg).toBe('Validation failed: mode must be one of: fast, slow, auto');
  });

  test('envelope path (errors without issues) also gets Suggestion lines', () => {
    const custom = { valid: false, errors: ['bad input'], suggestions: ['try again with a path'] };
    const msg = formatValidationError('t', custom, {});
    expect(msg).toBe('t failed due to the following issue:\nbad input\nSuggestion: try again with a path');
  });

  test('isValidationErrorMessage still recognizes messages with Suggestion lines', () => {
    const msg = formatValidationError('my_tool', validation, {});
    expect(isValidationErrorMessage(msg)).toBe(true);
    expect(isValidationErrorMessage('Validation failed: x is required')).toBe(true);
    expect(isValidationErrorMessage('some other error')).toBe(false);
  });
});

describe('toFunctionDef example injection', () => {
  const makeTool = (inputSchema) => defineTool({
    name: 'example_probe',
    description: 'probe',
    inputSchema,
    execute: async () => ({ success: true }),
  });

  test('appends " Example: <value>" to the description sent to the model', () => {
    const tool = makeTool({
      path: { type: 'string', required: true, description: 'File path.', example: '/tmp/a.txt' },
    });
    const def = tool.toFunctionDef();
    expect(def.parameters.properties.path.description).toBe('File path. Example: /tmp/a.txt');
    // JSON Schema structure unchanged — no `example` key is emitted.
    expect('example' in def.parameters.properties.path).toBe(false);
  });

  test('example without description → description becomes "Example: <value>"', () => {
    const tool = makeTool({ limit: { type: 'number', example: 50 } });
    const def = tool.toFunctionDef();
    expect(def.parameters.properties.limit.description).toBe('Example: 50');
  });

  test('non-string example values are JSON-stringified', () => {
    const tool = makeTool({
      tags: { type: 'array', description: 'Tag list.', example: ['a', 'b'] },
    });
    const def = tool.toFunctionDef();
    expect(def.parameters.properties.tags.description).toBe('Tag list. Example: ["a","b"]');
  });

  test('params without example are unchanged', () => {
    const tool = makeTool({ q: { type: 'string', description: 'Query.' } });
    const def = tool.toFunctionDef();
    expect(def.parameters.properties.q.description).toBe('Query.');
  });

  test('compatible with toFunctionDef memoization (same frozen tool → same def)', () => {
    const tool = makeTool({ p: { type: 'string', example: 'v' } });
    const first = tool.toFunctionDef();
    const second = tool.toFunctionDef();
    expect(second).toEqual(first);
    expect(second.parameters.properties.p.description).toBe('Example: v');
  });
});
