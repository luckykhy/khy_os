'use strict';

const {
  transparencyEnabled,
  selectResultBody,
  shouldRenderTransparentBody,
} = require('./toolResultTransparency');

describe('toolResultTransparency', () => {
  describe('transparencyEnabled', () => {
    it('returns true when env var is unset', () => {
      expect(transparencyEnabled({}).toBe(true);
      expect(transparencyEnabled(undefined).toBe(true);
    });

    it('returns false for off values', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: v }).toBe(false);
      }
    });

    it('returns true for other values', () => {
      expect(transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: '1' }).toBe(true);
    });
  });

  describe('selectResultBody', () => {
    it('returns text field first', () => {
      expect(selectResultBody({ text: 'hello', content: 'world' }).toBe('hello');
    });

    it('returns content field if text is empty', () => {
      expect(selectResultBody({ text: '', content: 'world' }).toBe('world');
    });

    it('returns output field if text and content are empty', () => {
      expect(selectResultBody({ text: '', content: '', output: 'result' }).toBe('result');
    });

    it('returns empty string when all fields empty', () => {
      expect(selectResultBody({ text: '', content: '', output: '' }).toBe('');
    });

    it('returns empty string for null/undefined', () => {
      expect(selectResultBody(null).toBe('');
      expect(selectResultBody(undefined).toBe('');
    });

    it('returns empty string for falsy values', () => {
      expect(selectResultBody(0).toBe('');
      expect(selectResultBody(false).toBe('');
    });

    it('serializes non-string body to JSON', () => {
      const result = { text: { nested: 'value' } };
      expect(selectResultBody(result).toBe('{"nested":"value"}');
    });

    it('trims whitespace-only strings', () => {
      expect(selectResultBody({ text: '   ' }).toBe('');
      expect(selectResultBody({ text: '\n\t  ' }).toBe('');
    });

    it('returns non-empty string with content', () => {
      expect(selectResultBody({ text: '  hello  ' }).toBe('  hello  ');
    });
  });

  describe('shouldRenderTransparentBody', () => {
    it('returns true when gate is on and body exists', () => {
      expect(shouldRenderTransparentBody({ text: 'hello' }, {}).toBe(true);
    });

    it('returns false when gate is off', () => {
      expect(shouldRenderTransparentBody({ text: 'hello' }, { KHY_TOOL_RESULT_TRANSPARENT: '0' }).toBe(false);
    });

    it('returns false when body is empty', () => {
      expect(shouldRenderTransparentBody({ text: '' }, {}).toBe(false);
    });

    it('returns false when result is null', () => {
      expect(shouldRenderTransparentBody(null, {}).toBe(false);
    });
  });
});

