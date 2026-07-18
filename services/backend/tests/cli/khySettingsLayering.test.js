'use strict';

/**
 * khySettingsLayering.test.js — layered settings resolution (Claude Code aligned).
 *
 * Precedence LOWEST→HIGHEST: user → project-shared → project-local → managed.
 * Managed is highest by design: an enterprise policy is not overridable by user
 * or project files. Writes target the user layer only and must never flatten
 * another layer's keys into the user file.
 *
 * The user layer is fixed at ~/.khy/settings.json, so we redirect HOME to a temp
 * dir; project layers come from an injected cwd; the managed layer is pointed via
 * KHY_MANAGED_SETTINGS.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule() {
  delete require.cache[require.resolve('../../src/cli/repl/khySettings')];
  return require('../../src/cli/repl/khySettings');
}

describe('khySettings — layered resolution', () => {
  let tmp;
  let prevHome;
  let prevManaged;
  let projectCwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-settings-'));
    prevHome = process.env.HOME;
    prevManaged = process.env.KHY_MANAGED_SETTINGS;
    process.env.HOME = path.join(tmp, 'home');
    fs.mkdirSync(path.join(tmp, 'home', '.khy'), { recursive: true });
    projectCwd = path.join(tmp, 'project');
    fs.mkdirSync(path.join(projectCwd, '.khy'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevManaged === undefined) delete process.env.KHY_MANAGED_SETTINGS; else process.env.KHY_MANAGED_SETTINGS = prevManaged;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const writeUser = (obj) => fs.writeFileSync(path.join(tmp, 'home', '.khy', 'settings.json'), JSON.stringify(obj));
  const writeShared = (obj) => fs.writeFileSync(path.join(projectCwd, '.khy', 'settings.json'), JSON.stringify(obj));
  const writeLocal = (obj) => fs.writeFileSync(path.join(projectCwd, '.khy', 'settings.local.json'), JSON.stringify(obj));
  const writeManaged = (obj) => {
    const p = path.join(tmp, 'managed.json');
    process.env.KHY_MANAGED_SETTINGS = p;
    fs.writeFileSync(p, JSON.stringify(obj));
  };

  test('user-only is byte-equivalent to the legacy single-file read', () => {
    const k = freshModule();
    writeUser({ theme: 'dark', verbose: true });
    assert.deepEqual(k.resolveKhySettings({ cwd: projectCwd }), { theme: 'dark', verbose: true });
  });

  test('project-shared overrides user; project-local overrides shared', () => {
    const k = freshModule();
    writeUser({ theme: 'dark', model: 'opus' });
    writeShared({ theme: 'light' });
    writeLocal({ model: 'sonnet' });
    const merged = k.resolveKhySettings({ cwd: projectCwd });
    assert.equal(merged.theme, 'light', 'shared overrides user');
    assert.equal(merged.model, 'sonnet', 'local overrides shared');
  });

  test('managed layer is highest precedence — not overridable by user/project', () => {
    const k = freshModule();
    writeUser({ telemetry: true });
    writeShared({ telemetry: true });
    writeLocal({ telemetry: true });
    writeManaged({ telemetry: false });
    assert.equal(k.resolveKhySettings({ cwd: projectCwd }).telemetry, false);
  });

  test('nested objects deep-merge across layers', () => {
    const k = freshModule();
    writeUser({ tools: { read: true, write: true } });
    writeShared({ tools: { write: false, exec: true } });
    const merged = k.resolveKhySettings({ cwd: projectCwd });
    assert.deepEqual(merged.tools, { read: true, write: false, exec: true });
  });

  test('arrays replace wholesale (override authoritative, not concatenated)', () => {
    const k = freshModule();
    writeUser({ allow: ['a', 'b'] });
    writeShared({ allow: ['c'] });
    assert.deepEqual(k.resolveKhySettings({ cwd: projectCwd }).allow, ['c']);
  });

  test('provenance reports the winning layer per top-level key', () => {
    const k = freshModule();
    writeUser({ a: 1, b: 1 });
    writeShared({ b: 2, c: 2 });
    writeManaged({ c: 3 });
    const { value, sources } = k.resolveKhySettingsWithProvenance({ cwd: projectCwd });
    assert.deepEqual(value, { a: 1, b: 2, c: 3 });
    assert.equal(sources.a, 'user');
    assert.equal(sources.b, 'project-shared');
    assert.equal(sources.c, 'managed');
  });

  test('writes persist only the user layer and never flatten other layers into it', () => {
    const k = freshModule();
    writeUser({ existing: 1 });
    writeShared({ sharedKey: 'fromProject' });
    // Persist a boolean via the user-layer writer while a project layer exists.
    k._persistBooleanKhySetting('flag', true);
    const userFileRaw = JSON.parse(fs.readFileSync(path.join(tmp, 'home', '.khy', 'settings.json'), 'utf-8'));
    assert.deepEqual(userFileRaw, { existing: 1, flag: true }, 'user file keeps only its own keys');
    assert.equal('sharedKey' in userFileRaw, false, 'project key was not flattened into the user file');
  });

  test('managed path is platform-resolved and env-overridable', () => {
    const k = freshModule();
    process.env.KHY_MANAGED_SETTINGS = '/custom/managed.json';
    assert.equal(k._managedSettingsPath(), '/custom/managed.json');
  });
});
