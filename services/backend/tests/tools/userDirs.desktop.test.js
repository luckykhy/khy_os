/**
 * userDirs.desktop.test.js — desktop-semantic normalization (XDG/Windows/macOS).
 *
 * Pure, fully offline & deterministic: the OS-canonical desktop resolver and the
 * home dir are injected, so no `xdg-user-dir` / registry / real filesystem is
 * touched. Proves the 防呆 contract: an alias folder under home (e.g. ~/桌面) is
 * redirected to the OS-canonical desktop, while genuine / non-desktop paths are
 * left untouched.
 */
'use strict';

const path = require('path');
const os = require('os');
const { normalizeDesktopPath, resolveSpecialDir, expandUserPath } = require('../../src/tools/_userDirs');

const HOME = path.sep === '\\' ? 'C:\\Users\\u' : '/home/u';
// Canonical desktop the OS reports (different folder name than the zh alias).
const CANON = path.join(HOME, 'Desktop');
const resolveCanon = () => CANON;
const opts = { _home: HOME, _resolveDesktop: resolveCanon };

const j = (...parts) => path.join(...parts);

describe('normalizeDesktopPath — redirect alias to canonical desktop', () => {
  afterEach(() => { delete process.env.KHY_NO_DESKTOP_NORMALIZE; });

  test('zh alias folder under home maps to OS-canonical desktop', () => {
    expect(normalizeDesktopPath(j(HOME, '桌面', '旅游日记.txt'), opts))
      .toBe(j(CANON, '旅游日记.txt'));
  });

  test('nested path under the alias is preserved', () => {
    expect(normalizeDesktopPath(j(HOME, '桌面', 'a', 'b.txt'), opts))
      .toBe(j(CANON, 'a', 'b.txt'));
  });

  test('alias matching is case-insensitive', () => {
    expect(normalizeDesktopPath(j(HOME, 'DESKTOP', 'x'), { _home: HOME, _resolveDesktop: () => j(HOME, '桌面') }))
      .toBe(j(HOME, '桌面', 'x'));
  });

  test('targeting the alias directory itself maps to the canonical directory', () => {
    expect(normalizeDesktopPath(j(HOME, '桌面'), opts)).toBe(CANON);
  });
});

describe('normalizeDesktopPath — 防呆 no-ops', () => {
  afterEach(() => { delete process.env.KHY_NO_DESKTOP_NORMALIZE; });

  test('already-canonical desktop is never rewritten (OS authority wins)', () => {
    const p = j(CANON, 'note.txt');
    expect(normalizeDesktopPath(p, opts)).toBe(p);
  });

  test('alias NOT the first segment under home is left alone', () => {
    const p = j(HOME, 'projects', '桌面', 'x.txt');
    expect(normalizeDesktopPath(p, opts)).toBe(p);
  });

  test('cwd-relative path is left alone', () => {
    expect(normalizeDesktopPath(j('桌面', 'x.txt'), opts)).toBe(j('桌面', 'x.txt'));
  });

  test('path outside home is left alone', () => {
    const p = path.sep === '\\' ? 'D:\\data\\桌面\\x' : '/srv/桌面/x';
    expect(normalizeDesktopPath(p, opts)).toBe(p);
  });

  test('non-desktop folder under home is left alone', () => {
    const p = j(HOME, 'Documents', 'x.txt');
    expect(normalizeDesktopPath(p, opts)).toBe(p);
  });

  test('KHY_NO_DESKTOP_NORMALIZE disables the whole feature', () => {
    process.env.KHY_NO_DESKTOP_NORMALIZE = '1';
    const p = j(HOME, '桌面', 'x.txt');
    expect(normalizeDesktopPath(p, opts)).toBe(p);
  });

  test('unresolvable canonical desktop → input unchanged', () => {
    const p = j(HOME, '桌面', 'x.txt');
    expect(normalizeDesktopPath(p, { _home: HOME, _resolveDesktop: () => null })).toBe(p);
  });

  test('a throwing resolver never breaks the path', () => {
    const p = j(HOME, '桌面', 'x.txt');
    const boom = () => { throw new Error('resolver failed'); };
    expect(normalizeDesktopPath(p, { _home: HOME, _resolveDesktop: boom })).toBe(p);
  });

  test('non-string / empty input is returned as-is', () => {
    expect(normalizeDesktopPath('', opts)).toBe('');
    expect(normalizeDesktopPath(null, opts)).toBeNull();
    expect(normalizeDesktopPath(undefined, opts)).toBeUndefined();
  });
});

describe('resolveSpecialDir — Linux uses xdg-user-dir authority', () => {
  test('xdg-user-dir DESKTOP answer is honored over convention', () => {
    if (process.platform !== 'linux') return; // platform-specific branch
    const run = (cmd, args) => {
      expect(cmd).toBe('xdg-user-dir');
      expect(args).toEqual(['DESKTOP']);
      return '/home/u/Desktop\n';
    };
    expect(resolveSpecialDir('desktop', { _home: '/home/u', _run: run })).toBe('/home/u/Desktop');
  });

  test('xdg-user-dir returning $HOME (unset) falls back to ~/Desktop', () => {
    if (process.platform !== 'linux') return;
    const run = () => '/home/u\n'; // unset → returns HOME, not a desktop
    delete process.env.XDG_DESKTOP_DIR;
    expect(resolveSpecialDir('desktop', { _home: '/home/u', _run: run })).toBe('/home/u/Desktop');
  });

  test('unknown kind returns null', () => {
    expect(resolveSpecialDir('music', opts)).toBeNull();
  });
});

describe('expandUserPath — mirrors the file tools so write-diff snapshots match', () => {
  const CWD = path.sep === '\\' ? 'C:\\proj' : '/proj';

  test('relative path resolves against the given cwd', () => {
    expect(expandUserPath(j('sub', 'a.txt'), CWD)).toBe(j(CWD, 'sub', 'a.txt'));
  });

  test('env-var path is expanded (not left literal under cwd)', () => {
    const key = 'KHY_EXPAND_TEST_DIR';
    const val = path.sep === '\\' ? 'D:\\data' : '/data';
    process.env[key] = val;
    try {
      const raw = path.sep === '\\' ? `%${key}%\\a.txt` : `$${key}/a.txt`;
      expect(expandUserPath(raw, CWD)).toBe(j(val, 'a.txt'));
    } finally {
      delete process.env[key];
    }
  });

  test('~ expands to the real home dir (no phantom <cwd>/~ segment)', () => {
    const out = expandUserPath(j('~', 'someplain', 'a.txt'), CWD);
    expect(out).toBe(j(os.homedir(), 'someplain', 'a.txt'));
    expect(out).not.toMatch(/[\\/]~[\\/]/); // no literal ~ segment
  });

  test('always returns an absolute path', () => {
    expect(path.isAbsolute(expandUserPath('a.txt', CWD))).toBe(true);
    expect(path.isAbsolute(expandUserPath('', CWD))).toBe(true);
  });
});
