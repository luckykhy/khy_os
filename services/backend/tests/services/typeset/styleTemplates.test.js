/**
 * styleTemplates.test.js — template loader / resolver.
 *
 * Confirms built-ins load, that non-default templates inherit the full default
 * baseline (every font key present even if the template file omits it), and that
 * overrides deep-merge on top without restating the baseline.
 */
'use strict';

const {
  DEFAULT_TEMPLATE,
  listTemplates,
  resolveTemplate,
  _deepMerge,
} = require('../../../src/services/typeset/styleTemplates');

describe('styleTemplates — discovery', () => {
  test('lists the three built-in templates', () => {
    const names = listTemplates().map((t) => t.name).sort();
    expect(names).toEqual(['default', 'gbt7714', 'ieee']);
  });

  test('each listed template has a human label', () => {
    for (const t of listTemplates()) expect(typeof t.label).toBe('string');
  });
});

describe('styleTemplates — resolution', () => {
  test('no spec resolves to the default baseline', () => {
    const { template, source, error } = resolveTemplate();
    expect(error).toBeUndefined();
    expect(source).toBe(`builtin:${DEFAULT_TEMPLATE}`);
    expect(template.page.size).toBe('A4');
  });

  test('gbt7714 carries its 国标 signatures', () => {
    const { template, source } = resolveTemplate('gbt7714');
    expect(source).toBe('builtin:gbt7714');
    expect(template.fonts.heading1.eastAsia).toBe('黑体');
    expect(template.fonts.heading1.size).toBe(16); // 三号
    expect(template.fonts.heading1.align).toBe('center');
    expect(template.fonts.heading1.pageBreakBefore).toBe(true);
    expect(template.fonts.default.eastAsia).toBe('宋体');
    expect(template.paragraph.lineSpacing).toBe(1.5);
    expect(template.pagination.pageBreakBeforeHeading1).toBe(true);
  });

  test('unknown template name returns an error listing built-ins', () => {
    const { template, error } = resolveTemplate('does-not-exist');
    expect(template).toBeNull();
    expect(error).toMatch(/Unknown style template/);
    expect(error).toMatch(/gbt7714/);
  });

  test('inline partial template inherits the full default baseline', () => {
    const { template } = resolveTemplate({ name: 'mini', fonts: { default: { size: 14 } } });
    // overridden key
    expect(template.fonts.default.size).toBe(14);
    // inherited keys from the default baseline survive
    expect(template.fonts.heading1).toBeDefined();
    expect(template.page.size).toBe('A4');
  });

  test('overrides deep-merge on top without restating the baseline', () => {
    const { template } = resolveTemplate('gbt7714', { paragraph: { lineSpacing: 2 } });
    expect(template.paragraph.lineSpacing).toBe(2);
    // other paragraph keys untouched
    expect(template.paragraph.firstLineIndentChars).toBe(2);
    // gbt7714 font signature still intact
    expect(template.fonts.heading1.size).toBe(16);
  });
});

describe('styleTemplates — _deepMerge', () => {
  test('objects merge, scalars and arrays replace', () => {
    expect(_deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({ a: { x: 1, y: 3 } });
    expect(_deepMerge({ a: [1, 2] }, { a: [9] })).toEqual({ a: [9] });
    expect(_deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('null override returns the base unchanged', () => {
    expect(_deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
