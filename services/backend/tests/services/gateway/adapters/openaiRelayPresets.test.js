'use strict';

const {
  RELAY_PRESETS,
  listRelayPresetNames,
  listRelayPresets,
  getRelayPreset,
} = require('./openaiRelayPresets');

describe('openaiRelayPresets', () => {
  describe('RELAY_PRESETS', () => {
    it('should be a frozen object', () => {
      expect(Object.isFrozen(RELAY_PRESETS)).toBe(true);
    });

    it('should be empty by default', () => {
      expect(Object.keys(RELAY_PRESETS)).toHaveLength(0);
    });
  });

  describe('listRelayPresetNames', () => {
    it('returns empty array when no presets', () => {
      expect(listRelayPresetNames()).toEqual([]);
    });
  });

  describe('listRelayPresets', () => {
    it('returns empty array when no presets', () => {
      expect(listRelayPresets()).toEqual([]);
    });
  });

  describe('getRelayPreset', () => {
    it('returns null for any name when empty', () => {
      expect(getRelayPreset('any')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getRelayPreset('')).toBeNull();
      expect(getRelayPreset(null)).toBeNull();
      expect(getRelayPreset(undefined)).toBeNull();
    });

    it('returns null for unknown preset', () => {
      expect(getRelayPreset('nonexistent')).toBeNull();
    });
  });
});
