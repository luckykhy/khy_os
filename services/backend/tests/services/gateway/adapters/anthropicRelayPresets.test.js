'use strict';

const {
  RELAY_PRESETS,
  listRelayPresetNames,
  listRelayPresets,
  getRelayPreset,
} = require('./anthropicRelayPresets');

describe('anthropicRelayPresets', () => {
  describe('RELAY_PRESETS', () => {
    it('should be a frozen object', () => {
      expect(Object.isFrozen(RELAY_PRESETS)).toBe(true);
    });

    it('should contain mindflow preset', () => {
      expect(RELAY_PRESETS.mindflow).toBeDefined();
      expect(RELAY_PRESETS.mindflow.baseUrl).toBe('https://ai.mindflow.com.cn');
      expect(RELAY_PRESETS.mindflow.model).toBe('claude-opus-4-8');
    });
  });

  describe('listRelayPresetNames', () => {
    it('returns array of preset names', () => {
      const names = listRelayPresetNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain('mindflow');
    });
  });

  describe('listRelayPresets', () => {
    it('returns array of preset objects with name', () => {
      const presets = listRelayPresets();
      expect(Array.isArray(presets)).toBe(true);
      presets.forEach((p) => {
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('baseUrl');
        expect(p).toHaveProperty('label');
      });
    });
  });

  describe('getRelayPreset', () => {
    it('returns preset for valid name', () => {
      const preset = getRelayPreset('mindflow');
      expect(preset).not.toBeNull();
      expect(preset.baseUrl).toBe('https://ai.mindflow.com.cn');
      expect(preset.model).toBe('claude-opus-4-8');
      expect(preset.label).toBe('MindFlow 中转');
    });

    it('is case-insensitive', () => {
      expect(getRelayPreset('MindFlow')).not.toBeNull();
      expect(getRelayPreset('MINDFLOW')).not.toBeNull();
    });

    it('trims whitespace', () => {
      expect(getRelayPreset('  mindflow  ')).not.toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getRelayPreset('')).toBeNull();
      expect(getRelayPreset(null)).toBeNull();
      expect(getRelayPreset(undefined)).toBeNull();
    });

    it('returns null for unknown preset', () => {
      expect(getRelayPreset('unknown')).toBeNull();
    });

    it('returns null for model when not set', () => {
      const preset = getRelayPreset('mindflow');
      expect(preset.model).toBe('claude-opus-4-8');
    });
  });
});

