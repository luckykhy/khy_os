'use strict';

const {
  TIER,
  FILE_TOOLS,
  SHELL_TOOLS,
  NETWORK_AI_TOOLS,
  normalize,
  classify,
  effectiveTier,
} = require('../../src/services/domain/trajectory/trajectoryReplay/tierRegistry');

describe('tierRegistry', () => {
  describe('normalize', () => {
    test('lowercases and strips separators', () => {
      expect(normalize('Write_File')).toBe('writefile');
      expect(normalize('shell-command')).toBe('shellcommand');
      expect(normalize('  web search  ')).toBe('websearch');
    });

    test('handles null/undefined', () => {
      expect(normalize(null)).toBe('');
      expect(normalize(undefined)).toBe('');
      expect(normalize('')).toBe('');
    });
  });

  describe('classify', () => {
    test('classifies file tools', () => {
      expect(classify('write')).toBe('FILE');
      expect(classify('Write_File')).toBe('FILE');
      expect(classify('multiedit')).toBe('FILE');
    });

    test('classifies shell tools', () => {
      expect(classify('shell')).toBe('SHELL');
      expect(classify('bash')).toBe('SHELL');
      expect(classify('execute-command')).toBe('SHELL');
    });

    test('classifies network AI tools', () => {
      expect(classify('websearch')).toBe('NETWORK_AI');
      expect(classify('webfetch')).toBe('NETWORK_AI');
      expect(classify('agent')).toBe('NETWORK_AI');
    });

    test('returns UNKNOWN for unknown tools', () => {
      expect(classify('unknownTool')).toBe('UNKNOWN');
      expect(classify('')).toBe('UNKNOWN');
      expect(classify(null)).toBe('UNKNOWN');
    });
  });

  describe('effectiveTier', () => {
    test('collapses UNKNOWN to SHELL', () => {
      expect(effectiveTier('unknown')).toBe('SHELL');
    });

    test('preserves known tiers', () => {
      expect(effectiveTier('write')).toBe('FILE');
      expect(effectiveTier('bash')).toBe('SHELL');
      expect(effectiveTier('websearch')).toBe('NETWORK_AI');
    });
  });

  describe('FILE_TOOLS', () => {
    test('contains write', () => {
      expect(FILE_TOOLS.has('write')).toBe(true);
    });

    test('contains edit', () => {
      expect(FILE_TOOLS.has('edit')).toBe(true);
    });
  });

  describe('SHELL_TOOLS', () => {
    test('contains bash', () => {
      expect(SHELL_TOOLS.has('bash')).toBe(true);
    });

    test('contains shell', () => {
      expect(SHELL_TOOLS.has('shell')).toBe(true);
    });
  });

  describe('NETWORK_AI_TOOLS', () => {
    test('contains websearch', () => {
      expect(NETWORK_AI_TOOLS.has('websearch')).toBe(true);
    });

    test('contains agent', () => {
      expect(NETWORK_AI_TOOLS.has('agent')).toBe(true);
    });
  });

  describe('TIER', () => {
    test('is frozen', () => {
      expect(Object.isFrozen(TIER)).toBe(true);
    });

    test('has correct values', () => {
      expect(TIER.FILE).toBe('FILE');
      expect(TIER.SHELL).toBe('SHELL');
      expect(TIER.NETWORK_AI).toBe('NETWORK_AI');
    });
  });
});
