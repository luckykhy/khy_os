'use strict';

/**
 * additionalDirectories.test.js — `/add-dir` working-directory grants (Claude
 * Code alignment) and their effect on editBoundaryGuard / pathTraversalGuard.
 *
 * A granted directory becomes an allowed write root; a path under it must no
 * longer be blocked as "outside project root" / "path traversal". The
 * sensitive-home-write denylist must STILL win over any grant.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const addl = require('../../src/services/additionalDirectories');
const toolGuards = require('../../src/services/toolGuards');
const guardApproval = require('../../src/services/guardApproval');

describe('additionalDirectories — /add-dir grants', () => {
  let tmp;
  let granted;
  let prevCwd;

  beforeEach(() => {
    addl._reset();
    delete process.env.KHY_ADDITIONAL_DIRS;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-adddir-'));
    granted = path.join(tmp, 'granted');
    fs.mkdirSync(granted, { recursive: true });
    // editBoundaryGuard resolves against KHYQUANT_CWD || cwd; pin a project root
    // that is NOT an ancestor of `granted` so the grant is what makes it allowed.
    prevCwd = process.env.KHYQUANT_CWD;
    process.env.KHYQUANT_CWD = path.join(tmp, 'project');
    fs.mkdirSync(process.env.KHYQUANT_CWD, { recursive: true });
  });

  afterEach(() => {
    addl._reset();
    if (prevCwd === undefined) delete process.env.KHYQUANT_CWD; else process.env.KHYQUANT_CWD = prevCwd;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('addDirectory validates existence and reports duplicates', () => {
    const ok = addl.addDirectory(granted);
    assert.equal(ok.success, true);
    assert.equal(ok.alreadyPresent, false);
    assert.equal(ok.dir, granted);

    const dup = addl.addDirectory(granted);
    assert.equal(dup.success, true);
    assert.equal(dup.alreadyPresent, true);

    const missing = addl.addDirectory(path.join(tmp, 'nope'));
    assert.equal(missing.success, false);
    assert.match(missing.error, /不存在/);
  });

  test('isUnderAdditionalDir matches the dir itself and nested paths', () => {
    addl.addDirectory(granted);
    assert.equal(addl.isUnderAdditionalDir(granted), true);
    assert.equal(addl.isUnderAdditionalDir(path.join(granted, 'a', 'b.txt')), true);
    assert.equal(addl.isUnderAdditionalDir(path.join(tmp, 'elsewhere.txt')), false);
  });

  test('env KHY_ADDITIONAL_DIRS seeds the set lazily', () => {
    addl._reset();
    process.env.KHY_ADDITIONAL_DIRS = granted;
    assert.equal(addl.isUnderAdditionalDir(path.join(granted, 'x')), true);
  });

  test('editBoundaryGuard blocks under-project-root violation until the dir is granted', () => {
    const target = path.join(granted, 'out.txt');
    const before = toolGuards.editBoundaryGuard({ params: { file_path: target } });
    assert.equal(before.action, 'block');
    assert.equal(before.approvable, true);

    addl.addDirectory(granted);
    const after = toolGuards.editBoundaryGuard({ params: { file_path: target } });
    assert.equal(after.action, 'allow');
  });

  test('pathTraversalGuard allows a .. path that lands inside a granted dir', () => {
    addl.addDirectory(granted);
    // From the project root, ../granted/file.txt resolves into the granted dir.
    const rel = path.join('..', 'granted', 'file.txt');
    const res = toolGuards.pathTraversalGuard({ params: { file_path: rel } });
    assert.equal(res.action, 'allow');
  });

  test('sensitive-home-write denylist still wins over a grant', () => {
    // Grant the home dir, then try to write an SSH key — must remain blocked.
    const home = os.homedir();
    addl.addDirectory(home);
    const sshKey = path.join(home, '.ssh', 'authorized_keys');
    const res = toolGuards.editBoundaryGuard({ params: { file_path: sshKey } });
    assert.equal(res.action, 'block');
    assert.match(res.reason, /sensitive home location/i);
  });

  test('readBoundaryGuard blocks reads outside project root until granted', () => {
    const target = path.join(granted, 'data.txt');
    const before = toolGuards.readBoundaryGuard({ params: { file_path: target } });
    assert.equal(before.action, 'block');
    assert.equal(before.approvable, true);
    assert.equal(before.source, 'ReadBoundaryGuard');

    addl.addDirectory(granted);
    const after = toolGuards.readBoundaryGuard({ params: { file_path: target } });
    assert.equal(after.action, 'allow');
  });

  test('readBoundaryGuard allows reads inside the project root with no grant', () => {
    const inside = path.join(process.env.KHYQUANT_CWD, 'sub', 'x.txt');
    const res = toolGuards.readBoundaryGuard({ params: { file_path: inside } });
    assert.equal(res.action, 'allow');
  });

  test('_rememberApprovedDirectory grants the approved file\'s parent dir', () => {
    // Before approval, an external read is an approvable block...
    const target = path.join(granted, 'report.txt');
    assert.equal(addl.isUnderAdditionalDir(target), false);

    // ...the user authorizes it "always" → the PARENT dir is remembered.
    guardApproval._rememberApprovedDirectory('ReadBoundaryGuard', { file_path: target });
    assert.equal(addl.isUnderAdditionalDir(granted), true);
    assert.equal(addl.isUnderAdditionalDir(path.join(granted, 'other.txt')), true);

    // ...and the boundary guard now lets that whole directory through silently.
    const after = toolGuards.readBoundaryGuard({ params: { file_path: target } });
    assert.equal(after.action, 'allow');
  });

  test('_rememberApprovedDirectory ignores non-boundary guard sources', () => {
    const target = path.join(granted, 'report.txt');
    guardApproval._rememberApprovedDirectory('FileStaleGuard', { file_path: target });
    assert.equal(addl.isUnderAdditionalDir(granted), false);
  });

  test('_rememberApprovedDirectory honors KHY_REMEMBER_APPROVED_DIR=0', () => {
    const prev = process.env.KHY_REMEMBER_APPROVED_DIR;
    process.env.KHY_REMEMBER_APPROVED_DIR = '0';
    try {
      const target = path.join(granted, 'report.txt');
      guardApproval._rememberApprovedDirectory('EditBoundaryGuard', { file_path: target });
      assert.equal(addl.isUnderAdditionalDir(granted), false);
    } finally {
      if (prev === undefined) delete process.env.KHY_REMEMBER_APPROVED_DIR;
      else process.env.KHY_REMEMBER_APPROVED_DIR = prev;
    }
  });
});
