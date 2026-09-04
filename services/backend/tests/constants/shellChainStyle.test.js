'use strict';

const {
  isEnabled,
  resolveFamily,
  targetsPowerShell,
  parseExecOverride,
  windowsRuleLines,
  multiCommandLines,
  LEGACY_WINDOWS_RULE_LINES,
  POWERSHELL_WINDOWS_RULE_LINES,
  LEGACY_MULTI_COMMAND_LINES,
  POWERSHELL_MULTI_COMMAND_LINES,
} = require('../../src/constants/shellChainStyle');

describe('shellChainStyle', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: '1' })).toBe(true);
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: '0' })).toBe(false);
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'false' })).toBe(false);
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'off' })).toBe(false);
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'FALSE' })).toBe(false);
    });
  });

  describe('resolveFamily', () => {
    test('returns powershell for KHY_SHELL powershell', () => {
      expect(resolveFamily({ KHY_SHELL: 'powershell' })).toBe('powershell');
      expect(resolveFamily({ KHY_SHELL: 'PowerShell' })).toBe('powershell');
      expect(resolveFamily({ KHY_SHELL: 'ps' })).toBe('powershell');
    });

    test('returns pwsh for KHY_SHELL pwsh', () => {
      expect(resolveFamily({ KHY_SHELL: 'pwsh' })).toBe('pwsh');
      expect(resolveFamily({ KHY_SHELL: 'pwsh7' })).toBe('pwsh');
    });

    test('returns cmd for KHY_SHELL cmd', () => {
      expect(resolveFamily({ KHY_SHELL: 'cmd' })).toBe('cmd');
      expect(resolveFamily({ KHY_SHELL: 'cmd.exe' })).toBe('cmd');
    });

    test('returns null for bash/sh', () => {
      expect(resolveFamily({ KHY_SHELL: 'bash' })).toBeNull();
      expect(resolveFamily({ KHY_SHELL: 'sh' })).toBeNull();
    });

    test('returns powershell for COMSPEC powershell.exe', () => {
      expect(resolveFamily({ COMSPEC: 'C:\\Windows\\System32\\powershell.exe' })).toBe('powershell');
    });

    test('returns pwsh for COMSPEC pwsh.exe', () => {
      expect(resolveFamily({ COMSPEC: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toBe('pwsh');
    });

    test('returns cmd for COMSPEC cmd.exe', () => {
      expect(resolveFamily({ COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })).toBe('cmd');
    });

    test('returns null for unknown', () => {
      expect(resolveFamily({})).toBeNull();
    });
  });

  describe('targetsPowerShell', () => {
    test('returns true for powershell family when enabled', () => {
      expect(targetsPowerShell({ KHY_SHELL: 'powershell' })).toBe(true);
      expect(targetsPowerShell({ KHY_SHELL: 'pwsh' })).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(targetsPowerShell({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: '0' })).toBe(false);
    });

    test('returns false for non-powershell', () => {
      expect(targetsPowerShell({ KHY_SHELL: 'cmd' })).toBe(false);
      expect(targetsPowerShell({ KHY_SHELL: 'bash' })).toBe(false);
    });
  });

  describe('parseExecOverride', () => {
    test('returns null when disabled', () => {
      expect(parseExecOverride({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: '0' })).toBeNull();
    });

    test('returns normalized shell when enabled', () => {
      expect(parseExecOverride({ KHY_SHELL: 'powershell' })).toBe('powershell');
      expect(parseExecOverride({ KHY_SHELL: 'pwsh' })).toBe('pwsh');
      expect(parseExecOverride({ KHY_SHELL: 'cmd' })).toBe('cmd');
      expect(parseExecOverride({ KHY_SHELL: 'bash' })).toBe('bash');
      expect(parseExecOverride({ KHY_SHELL: 'sh' })).toBe('sh');
    });

    test('returns null for unknown shell', () => {
      expect(parseExecOverride({ KHY_SHELL: 'unknown' })).toBeNull();
    });
  });

  describe('windowsRuleLines', () => {
    test('returns legacy lines for non-powershell', () => {
      const result = windowsRuleLines({ KHY_SHELL: 'cmd' });
      expect(result).toEqual(LEGACY_WINDOWS_RULE_LINES);
    });

    test('returns powershell lines for powershell', () => {
      const result = windowsRuleLines({ KHY_SHELL: 'powershell' });
      expect(result).toEqual(POWERSHELL_WINDOWS_RULE_LINES);
    });

    test('returns legacy lines when disabled', () => {
      const result = windowsRuleLines({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: '0' });
      expect(result).toEqual(LEGACY_WINDOWS_RULE_LINES);
    });
  });

  describe('multiCommandLines', () => {
    test('returns legacy lines for non-powershell', () => {
      const result = multiCommandLines({ KHY_SHELL: 'cmd' });
      expect(result).toEqual(LEGACY_MULTI_COMMAND_LINES);
    });

    test('returns powershell lines for powershell', () => {
      const result = multiCommandLines({ KHY_SHELL: 'powershell' });
      expect(result).toEqual(POWERSHELL_MULTI_COMMAND_LINES);
    });

    test('returns legacy lines when disabled', () => {
      const result = multiCommandLines({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: '0' });
      expect(result).toEqual(LEGACY_MULTI_COMMAND_LINES);
    });
  });
});
