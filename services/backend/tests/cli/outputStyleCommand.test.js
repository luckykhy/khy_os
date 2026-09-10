'use strict';
/**
 * outputStyleCommand.test.js â€?`/output-style` command (Claude Code alignment).
 *
 * Before this command the output-style subsystem (constants/outputStyles.js)
 * was driven only by the KHY_OUTPUT_STYLE env var with no CLI surface to list
 * or switch styles. These tests pin the pieces the command relies on:
 *   1. style resolution + validation (constants/outputStyles.js);
 *   2. durable persistence of the chosen style to the USER settings layer,
 *      read back through the layered resolver (cli/repl/khySettings.js);
 *   3. command registration in the single-source command schema.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const styles = require('../../src/constants/outputStyles');
const schema = require('../../src/constants/commandSchema');
describe('/output-style â€?style resolution and validation', () => {
  let prevEnv;
  beforeEach(() => { prevEnv = process.env.KHY_OUTPUT_STYLE; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.KHY_OUTPUT_STYLE;
    else process.env.KHY_OUTPUT_STYLE = prevEnv;
  });
});
describe('/output-style â€?durable persistence to the user settings layer', () => {
  let tmpHome;
  let prevHome;
  let khySettings;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-style-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Fresh require so _homeDir()/_userSettingsFile() pick up the new HOME.
    delete require.cache[require.resolve('../../src/cli/repl/khySettings')];
    khySettings = require('../../src/cli/repl/khySettings');
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    delete require.cache[require.resolve('../../src/cli/repl/khySettings')];
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
describe('/output-style â€?command registration', () => {
});

describe('Output Style Command', () => {
  test('getActiveOutputStyleName defaults to senior-engineer and reflects env', () => {
        delete process.env.KHY_OUTPUT_STYLE;
        expect(styles.getActiveOutputStyleName()).toBe('senior-engineer');
        process.env.KHY_OUTPUT_STYLE = 'concise';
        expect(styles.getActiveOutputStyleName()).toBe('concise');
  });

  test('isValidStyleName accepts built-ins and off-family, rejects unknowns', () => {
        expect(styles.isValidStyleName('senior-engineer')).toBe(true);
        expect(styles.isValidStyleName('concise')).toBe(true);
        expect(styles.isValidStyleName('off')).toBe(true);
        expect(styles.isValidStyleName('none')).toBe(true);
        expect(styles.isValidStyleName('definitely-not-a-style')).toBe(false);
        expect(styles.isValidStyleName('')).toBe(false);
  });

  test('_persistStringKhySetting writes a string read back by the resolver', () => {
        const ok = khySettings._persistStringKhySetting('outputStyle', 'concise');
        expect(ok).toBe(true);
        const resolved = khySettings.resolveKhySettings();
        expect(resolved.outputStyle).toBe('concise');
  });

  test('_persistStringKhySetting with null removes the key', () => {
        khySettings._persistStringKhySetting('outputStyle', 'verbose');
        expect(khySettings.resolveKhySettings().outputStyle).toBe('verbose');
        khySettings._persistStringKhySetting('outputStyle', null);
        expect(khySettings.resolveKhySettings().outputStyle).toBe(undefined);
  });

  test('output-style is a router command and slash command', () => {
        const names = schema.getRouterCommandNames();
        expect(names).toContain('output-style');
        const slash = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/output-style');
        expect(slash).toBeTruthy();
        expect(slash.route).toBe('output-style');
  });

});

