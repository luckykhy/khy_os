'use strict';

/**
 * outputStyleCommand.test.js — `/output-style` command (Claude Code alignment).
 *
 * Before this command the output-style subsystem (constants/outputStyles.js)
 * was driven only by the KHY_OUTPUT_STYLE env var with no CLI surface to list
 * or switch styles. These tests pin the pieces the command relies on:
 *   1. style resolution + validation (constants/outputStyles.js);
 *   2. durable persistence of the chosen style to the USER settings layer,
 *      read back through the layered resolver (cli/repl/khySettings.js);
 *   3. command registration in the single-source command schema.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const styles = require('../../src/constants/outputStyles');
const schema = require('../../src/constants/commandSchema');

describe('/output-style — style resolution and validation', () => {
  let prevEnv;

  beforeEach(() => { prevEnv = process.env.KHY_OUTPUT_STYLE; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.KHY_OUTPUT_STYLE;
    else process.env.KHY_OUTPUT_STYLE = prevEnv;
  });

  test('getActiveOutputStyleName defaults to senior-engineer and reflects env', () => {
    delete process.env.KHY_OUTPUT_STYLE;
    assert.equal(styles.getActiveOutputStyleName(), 'senior-engineer');
    process.env.KHY_OUTPUT_STYLE = 'concise';
    assert.equal(styles.getActiveOutputStyleName(), 'concise');
  });

  test('isValidStyleName accepts built-ins and off-family, rejects unknowns', () => {
    assert.equal(styles.isValidStyleName('senior-engineer'), true);
    assert.equal(styles.isValidStyleName('concise'), true);
    assert.equal(styles.isValidStyleName('off'), true);
    assert.equal(styles.isValidStyleName('none'), true);
    assert.equal(styles.isValidStyleName('definitely-not-a-style'), false);
    assert.equal(styles.isValidStyleName(''), false);
  });
});

describe('/output-style — durable persistence to the user settings layer', () => {
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

  test('_persistStringKhySetting writes a string read back by the resolver', () => {
    const ok = khySettings._persistStringKhySetting('outputStyle', 'concise');
    assert.equal(ok, true);
    const resolved = khySettings.resolveKhySettings();
    assert.equal(resolved.outputStyle, 'concise');
  });

  test('_persistStringKhySetting with null removes the key', () => {
    khySettings._persistStringKhySetting('outputStyle', 'verbose');
    assert.equal(khySettings.resolveKhySettings().outputStyle, 'verbose');
    khySettings._persistStringKhySetting('outputStyle', null);
    assert.equal(khySettings.resolveKhySettings().outputStyle, undefined);
  });
});

describe('/output-style — command registration', () => {
  test('output-style is a router command and slash command', () => {
    const names = schema.getRouterCommandNames();
    assert.ok(names.includes('output-style'));
    const slash = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/output-style');
    assert.ok(slash, '/output-style slash command must be registered');
    assert.equal(slash.route, 'output-style');
  });
});
