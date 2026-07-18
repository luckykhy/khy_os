'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const themeRegistry = require('../src/cli/themeRegistry');

describe('themeRegistry', () => {
  // Save and restore preferences file
  const prefsFile = themeRegistry.PREFS_FILE;
  let prefsBackup = null;

  beforeAll(() => {
    try { prefsBackup = fs.readFileSync(prefsFile, 'utf8'); } catch { /* ok */ }
  });

  afterAll(() => {
    if (prefsBackup !== null) {
      fs.writeFileSync(prefsFile, prefsBackup, 'utf8');
    } else {
      try { fs.unlinkSync(prefsFile); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    themeRegistry._resetForTest();
    // Remove any persisted preference from previous tests
    try { fs.unlinkSync(prefsFile); } catch { /* ok */ }
  });

  // ── init ─────────────────────────────────────────────────────────

  test('init() loads JSON themes from themes/ directory', () => {
    themeRegistry.init();
    const themes = themeRegistry.listThemes();
    expect(themes.length).toBeGreaterThanOrEqual(2);
    const names = themes.map(t => t.name);
    expect(names).toContain('default');
    expect(names).toContain('mono');
  });

  test('init() is idempotent (double call does not duplicate)', () => {
    themeRegistry.init();
    const count1 = themeRegistry.listThemes().length;
    themeRegistry.init();
    const count2 = themeRegistry.listThemes().length;
    expect(count1).toBe(count2);
  });

  // ── getTheme ────────────────────────────────────────────────────

  test('getTheme() returns default theme by default', () => {
    const theme = themeRegistry.getTheme();
    expect(theme.meta.name).toBe('default');
    expect(theme.colors).toBeDefined();
    expect(theme.colors.claude).toBe('#D77757');
    expect(theme.spinnerChars).toBeDefined();
    expect(theme.thinkingVerbs).toBeDefined();
    expect(theme.phaseLabels).toBeDefined();
    expect(theme.toolDisplayNames).toBeDefined();
  });

  test('getTheme() auto-initializes if not yet init()', () => {
    // No explicit init() call
    const theme = themeRegistry.getTheme();
    expect(theme.meta.name).toBe('default');
  });

  // ── setTheme ────────────────────────────────────────────────────

  test('setTheme("mono") switches theme and returns true', () => {
    themeRegistry.init();
    const ok = themeRegistry.setTheme('mono');
    expect(ok).toBe(true);
    expect(themeRegistry.getActiveName()).toBe('mono');
    expect(themeRegistry.getTheme().meta.name).toBe('mono');
  });

  test('setTheme("nonexistent") returns false and keeps current', () => {
    themeRegistry.init();
    const ok = themeRegistry.setTheme('nonexistent');
    expect(ok).toBe(false);
    expect(themeRegistry.getActiveName()).toBe('default');
  });

  test('setTheme persists preference to disk', () => {
    themeRegistry.init();
    themeRegistry.setTheme('mono');

    // Read the prefs file
    const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    expect(prefs.theme).toBe('mono');
  });

  // ── listThemes ──────────────────────────────────────────────────

  test('listThemes() returns array with name, label, active fields', () => {
    themeRegistry.init();
    const themes = themeRegistry.listThemes();
    for (const t of themes) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('active');
    }
    const active = themes.filter(t => t.active);
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('default');
  });

  // ── color ───────────────────────────────────────────────────────

  test('color("claude") returns hex string', () => {
    const val = themeRegistry.color('claude');
    expect(val).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(val).toBe('#D77757');
  });

  test('color("nonexistent") falls back to #FFFFFF', () => {
    const val = themeRegistry.color('nonexistent_key_xyz');
    expect(val).toBe('#FFFFFF');
  });

  test('color() reads from active theme after switch', () => {
    themeRegistry.init();
    themeRegistry.setTheme('mono');
    const val = themeRegistry.color('claude');
    expect(val).toBe('#AAAAAA'); // mono theme's claude color
  });

  // ── Backward-compat: THEME Proxy in aiRenderer ──────────────────

  test('aiRenderer THEME proxy returns colors from registry', () => {
    themeRegistry.init();
    // Access THEME via aiRenderer module
    const { THEME } = require('../src/cli/aiRenderer');
    expect(THEME.claude).toBe('#D77757');
    expect(THEME.success).toBe('#4EBA65');
    expect(THEME.error).toBe('#FF6B80');
  });

  // ── Theme completeness ──────────────────────────────────────────

  test('default theme has all 18 color keys', () => {
    const theme = themeRegistry.getTheme();
    const expectedKeys = [
      'claude', 'success', 'error', 'warning', 'text', 'secondaryText',
      'subtle', 'bashBorder', 'permission', 'link',
      'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed',
      'diffAddedWord', 'diffRemovedWord', 'permissionPurple', 'userMessageBg',
    ];
    for (const key of expectedKeys) {
      expect(theme.colors[key]).toBeDefined();
    }
  });

  test('default theme has 10 thinking verbs', () => {
    const theme = themeRegistry.getTheme();
    expect(theme.thinkingVerbs.length).toBe(10);
    expect(theme.thinkingVerbs[0]).toBe('Thinking');
  });

  test('default theme has 13 phase labels', () => {
    const theme = themeRegistry.getTheme();
    expect(Object.keys(theme.phaseLabels).length).toBe(13);
    expect(theme.phaseLabels.init).toBe('Initializing');
    expect(theme.phaseLabels.done).toBe('Done');
  });

  test('mono theme has distinct colors from default', () => {
    themeRegistry.init();
    const def = themeRegistry.getTheme();
    themeRegistry.setTheme('mono');
    const mono = themeRegistry.getTheme();
    expect(mono.colors.claude).not.toBe(def.colors.claude);
  });
});
