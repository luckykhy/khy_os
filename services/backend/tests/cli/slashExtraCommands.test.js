'use strict';

const { SLASH_EXTRA_COMMANDS, mergeExtraCommands } = require('./slashExtraCommands');

describe('slashExtraCommands', () => {
  describe('SLASH_EXTRA_COMMANDS', () => {
    it('should be a frozen array', () => {
      expect(Array.isArray(SLASH_EXTRA_COMMANDS).toBe(true);
      expect(Object.isFrozen(SLASH_EXTRA_COMMANDS).toBe(true);
    });

    it('should contain expected commands', () => {
      const cmds = SLASH_EXTRA_COMMANDS.map((c) => c.cmd);
      expect(cmds).toContain('/study');
      expect(cmds).toContain('/role');
      expect(cmds).toContain('/hud');
      expect(cmds).toContain('/mind');
      expect(cmds).toContain('/intent');
      expect(cmds).toContain('/new');
      expect(cmds).toContain('/reset');
      expect(cmds).toContain('/folded');
      expect(cmds).toContain('/think');
      expect(cmds).toContain('/trace');
      expect(cmds).toContain('/pool');
      expect(cmds).toContain('/push');
      expect(cmds).toContain('/optimize');
    });

    it('each entry should have cmd, label, desc', () => {
      SLASH_EXTRA_COMMANDS.forEach((entry) => {
        expect(entry).toHaveProperty('cmd');
        expect(entry).toHaveProperty('label');
        expect(entry).toHaveProperty('desc');
        expect(typeof entry.cmd).toBe('string');
        expect(entry.cmd.startsWith('/').toBe(true);
      });
    });

    it('entries are frozen', () => {
      SLASH_EXTRA_COMMANDS.forEach((entry) => {
        expect(Object.isFrozen(entry).toBe(true);
      });
    });
  });

  describe('mergeExtraCommands', () => {
    it('returns new array with extras appended to base', () => {
      const base = [{ cmd: '/help', label: 'Help' }];
      const merged = mergeExtraCommands(base);
      expect(merged.length).toBe(base.length + SLASH_EXTRA_COMMANDS.length);
      expect(merged[0]).toEqual({ cmd: '/help', label: 'Help' });
    });

    it('does not mutate the base array', () => {
      const base = [{ cmd: '/help' }];
      const original = base.slice();
      mergeExtraCommands(base);
      expect(base).toEqual(original);
    });

    it('skips extras that already exist in base', () => {
      const base = [{ cmd: '/study', label: 'Custom Study' }];
      const merged = mergeExtraCommands(base);
      const studyEntries = merged.filter((c) => c.cmd === '/study');
      expect(studyEntries).toHaveLength(1);
      expect(studyEntries[0].label).toBe('Custom Study');
    });

    it('handles null/undefined base', () => {
      const merged = mergeExtraCommands(null);
      expect(merged.length).toBe(SLASH_EXTRA_COMMANDS.length);
      const mergedUndef = mergeExtraCommands(undefined);
      expect(mergedUndef.length).toBe(SLASH_EXTRA_COMMANDS.length);
    });

    it('handles empty base array', () => {
      const merged = mergeExtraCommands([]);
      expect(merged.length).toBe(SLASH_EXTRA_COMMANDS.length);
    });

    it('handles base with entries missing cmd', () => {
      const base = [{ label: 'No cmd' }, { cmd: '/help' }];
      const merged = mergeExtraCommands(base);
      expect(merged.length).toBe(base.length + SLASH_EXTRA_COMMANDS.length);
    });
  });
});

