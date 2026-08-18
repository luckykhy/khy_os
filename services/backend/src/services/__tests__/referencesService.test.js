'use strict';

/**
 * referencesService.test.js — unit tests for the References cross-directory
 * resource registry: config merge, alias mention resolution, boundary
 * enforcement, and unsafe-repository refusal.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../referencesService');

describe('referencesService', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-test-'));
    svc._clearCache();
  });
  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    svc._clearCache();
  });

  function writeConfig(rel, obj) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(obj, null, 2), 'utf-8');
    return abs;
  }

  const mkRefs = (files) => {
    // files: { 'user/references.json': {...}, 'proj/.khy/references.json': {...} }
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const user = path.join(tmp, 'user-home');
    fs.mkdirSync(user, { recursive: true });
    const paths = [];
    if (files['user/references.json']) {
      const p = writeConfig('user/references.json', files['user/references.json']);
      paths.push(p);
    }
    if (files['proj/.khy/references.json']) {
      const p = writeConfig('proj/.khy/references.json', files['proj/.khy/references.json']);
      paths.push(p);
    }
    return { cwd, paths };
  };

  describe('loadReferences', () => {
    it('returns empty map when no config files exist', () => {
      const { cwd, paths } = mkRefs({});
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(refs.size).toBe(0);
    });

    it('loads user-level path references', () => {
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs', description: 'product docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(refs.size).toBe(1);
      const entry = refs.get('docs');
      expect(entry.type).toBe('path');
      expect(entry.target).toBe(path.resolve(tmp, 'docs'));
      expect(entry.description).toBe('product docs');
      expect(entry.hidden).toBe(false);
    });

    it('project config overrides user config on the same alias', () => {
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../a', description: 'user docs' } },
        'proj/.khy/references.json': { docs: { path: '../b', description: 'project docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(refs.size).toBe(1);
      // Project config lives at <tmp>/proj/.khy/references.json → '../b' = <tmp>/proj/b
      expect(refs.get('docs').target).toBe(path.resolve(tmp, 'proj', 'b'));
      expect(refs.get('docs').description).toBe('project docs');
    });

    it('honours hidden flag', () => {
      const { cwd, paths } = mkRefs({
        'user/references.json': {
          visible: { path: '../a' },
          secret: { path: '../b', hidden: true },
        },
      });
      const ctx = svc.buildReferencesContext(cwd, { _configPaths: paths });
      expect(ctx).toContain('@visible');
      expect(ctx).not.toContain('@secret');
    });

    it('refuses unsafe repository formats (URL injection)', () => {
      const { cwd, paths } = mkRefs({
        'user/references.json': {
          ok: { repository: 'owner/repo' },
          badUrl: { repository: 'https://github.com/evil/repo' },
          badPath: { repository: 'a/b/c' },
        },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(refs.get('ok').error).toBeUndefined();
      expect(refs.get('badUrl').error).toBe('unsafe_repo');
      expect(refs.get('badPath').error).toBe('unsafe_repo');
    });

    it('gate KHY_REFERENCES=off disables everything', () => {
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths, env: { KHY_REFERENCES: 'off' } });
      expect(refs.size).toBe(0);
    });
  });

  describe('resolveMentionAbs', () => {
    it('resolves @alias to the reference root', () => {
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      const out = svc.resolveMentionAbs('docs', cwd, { _refs: refs });
      expect(out).toBe(path.resolve(tmp, 'docs'));
    });

    it('resolves @alias/sub/path inside the reference root', () => {
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(path.join(docsDir, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'a', 'b', 'readme.md'), 'x', 'utf-8');
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      const out = svc.resolveMentionAbs('docs/a/b/readme.md', cwd, { _refs: refs });
      expect(out).toBe(path.resolve(tmp, 'docs', 'a', 'b', 'readme.md'));
    });

    it('rejects paths escaping the reference root (../)', () => {
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      const out = svc.resolveMentionAbs('docs/../secret.txt', cwd, { _refs: refs });
      expect(out).toBeNull();
    });

    it('returns null for unknown alias', () => {
      const { cwd, paths } = mkRefs({});
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(svc.resolveMentionAbs('nope/x', cwd, { _refs: refs })).toBeNull();
    });
  });

  describe('isWithinBoundary', () => {
    it('allows paths under cwd', () => {
      const { cwd } = mkRefs({});
      const inside = path.join(cwd, 'src', 'a.js');
      expect(svc.isWithinBoundary(inside, cwd)).toBe(true);
    });

    it('allows paths under a declared reference root', () => {
      const docsDir = path.join(tmp, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const { cwd, paths } = mkRefs({
        'user/references.json': { docs: { path: '../docs' } },
      });
      const refs = svc.loadReferences(cwd, { _configPaths: paths });
      expect(svc.isWithinBoundary(path.join(docsDir, 'x.md'), cwd, { _refs: refs })).toBe(true);
    });

    it('rejects paths outside cwd and outside all references', () => {
      const outside = path.join(tmp, 'unrelated', 'secret.txt');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      const { cwd } = mkRefs({});
      // tmp dir is under os.tmpdir() which is not a trusted user root by default
      expect(
        svc.isWithinBoundary(outside, cwd, { _isUnderTrustedRoot: () => false })
      ).toBe(false);
    });
  });

  describe('buildReferencesContext', () => {
    it('returns null when nothing is configured', () => {
      const { cwd, paths } = mkRefs({});
      expect(svc.buildReferencesContext(cwd, { _configPaths: paths })).toBeNull();
    });

    it('builds an injection block listing aliases', () => {
      const { cwd, paths } = mkRefs({
        'user/references.json': {
          docs: { path: '../docs', description: 'product docs' },
        },
      });
      const ctx = svc.buildReferencesContext(cwd, { _configPaths: paths });
      expect(ctx).toContain('# References');
      expect(ctx).toContain('@docs');
      expect(ctx).toContain('product docs');
    });
  });
});
