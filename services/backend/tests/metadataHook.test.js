'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hookSvc = require('../src/services/metadataHook');

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // Identity so commits (if ever exercised) don't fail in CI.
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
}

describe('metadataHook — deterministic git pre-commit installer', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hook-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('reports not_a_repo outside a git repository', () => {
    const r = hookSvc.installHook(tmp);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'not_a_repo');
  });

  test('installs an executable, marked pre-commit hook', () => {
    gitInit(tmp);
    const r = hookSvc.installHook(tmp);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'installed');
    const body = fs.readFileSync(r.preCommit, 'utf8');
    assert.match(body, new RegExp(hookSvc.HOOK_MARKER));
    assert.match(body, /metadata refresh/);
    // Composes the docs-freshness step (source changes → keep docs/products in sync).
    assert.match(body, /docs check --fix --staged/);
    // Marker carries the bumped version so idempotent upgrades re-write old installs.
    assert.equal(hookSvc.HOOK_VERSION, 'v3');
    assert.match(body, new RegExp(`${hookSvc.HOOK_MARKER} v3`));
    // Executable bit set (best-effort; skip assertion where chmod is a no-op).
    const mode = fs.statSync(r.preCommit).mode & 0o111;
    assert.ok(mode !== 0, 'hook should be executable');
  });

  test('is idempotent: re-install updates in place', () => {
    gitInit(tmp);
    hookSvc.installHook(tmp);
    const again = hookSvc.installHook(tmp);
    assert.equal(again.ok, true);
    assert.equal(again.action, 'updated');
  });

  test('never overwrites a foreign pre-commit hook, returns a snippet', () => {
    gitInit(tmp);
    const preCommit = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(preCommit), { recursive: true });
    const foreign = '#!/bin/sh\necho "my own hook"\n';
    fs.writeFileSync(preCommit, foreign, 'utf8');

    const r = hookSvc.installHook(tmp);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'foreign_hook');
    assert.ok(r.snippet && r.snippet.includes('metadata refresh'));
    // Foreign snippet also carries the docs-freshness step so a manual link-in stays complete.
    assert.ok(r.snippet.includes('docs check --fix --staged'));
    // Foreign hook untouched.
    assert.equal(fs.readFileSync(preCommit, 'utf8'), foreign);
  });

  test('uninstall removes only our own hook', () => {
    gitInit(tmp);
    hookSvc.installHook(tmp);
    const r = hookSvc.uninstallHook(tmp);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'removed');
    assert.ok(!fs.existsSync(r.preCommit));
  });

  test('uninstall refuses to remove a foreign hook', () => {
    gitInit(tmp);
    const preCommit = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(preCommit), { recursive: true });
    fs.writeFileSync(preCommit, '#!/bin/sh\necho foreign\n', 'utf8');
    const r = hookSvc.uninstallHook(tmp);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'not_ours');
    assert.ok(fs.existsSync(preCommit));
  });

  test('status reflects installed/ours/foreign', () => {
    gitInit(tmp);
    let s = hookSvc.hookStatus(tmp);
    assert.equal(s.installed, false);
    hookSvc.installHook(tmp);
    s = hookSvc.hookStatus(tmp);
    assert.equal(s.installed, true);
    assert.equal(s.ours, true);
    assert.equal(s.foreign, false);
  });
});
