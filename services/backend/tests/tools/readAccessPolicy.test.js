'use strict';

/**
 * readAccessPolicy.test.js — validateReadAccess (READ mirror of validateNoPathTraversal).
 *
 * Covers the user requirement「全局可读，没有权限时向用户申请权限而不是直接失败」:
 *   - default (no strict flag): reads are GLOBALLY allowed, even far outside the project;
 *   - strict mode (KHY_STRICT_READ_BOUNDARY=1): out-of-scope reads become an *approvable*
 *     denial (never a silent hard-fail), while project / trusted / granted dirs pass;
 *   - the sensitive-home WRITE denylist is NOT consulted on reads (it stays write-only).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const { validateReadAccess } = require('../../src/tools/inputValidators');

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

test('default (non-strict): global read — far-outside system path is allowed', () => {
  withEnv('KHY_STRICT_READ_BOUNDARY', undefined, () => {
    const sys = process.platform === 'win32' ? 'C:\\Windows\\system32\\drivers\\etc\\hosts' : '/etc/hosts';
    assert.equal(validateReadAccess(sys, process.cwd()).valid, true);
  });
});

test('default (non-strict): a Windows-style drive path under D:\\ is allowed (transcript repro)', () => {
  withEnv('KHY_STRICT_READ_BOUNDARY', undefined, () => {
    // The exact shape that produced "Refused ... outside the project" before the fix.
    const r = validateReadAccess('D:\\.khy\\clipboard-img2file\\screenshot.png', process.cwd());
    assert.equal(r.valid, true);
  });
});

test('strict mode: project-internal read passes', () => {
  withEnv('KHY_STRICT_READ_BOUNDARY', '1', () => {
    const base = process.cwd();
    assert.equal(validateReadAccess(path.join(base, 'src', 'tools', 'readFile.js'), base).valid, true);
  });
});

test('strict mode: trusted user root (home) passes', () => {
  withEnv('KHY_STRICT_READ_BOUNDARY', '1', () => {
    const inHome = path.join(os.homedir(), 'Desktop', 'note.txt');
    assert.equal(validateReadAccess(inHome, process.cwd()).valid, true);
  });
});

test('strict mode: out-of-scope read is an APPROVABLE denial, not a silent hard-fail', () => {
  withEnv('KHY_STRICT_READ_BOUNDARY', '1', () => {
    // A path under neither the project nor any trusted/granted root.
    const r = validateReadAccess('/var/tmp/some-other-place/secret.bin', '/tmp/project-root');
    assert.equal(r.valid, false);
    assert.equal(r.approvable, true);           // escalate to user prompt, never dead-end
    assert.match(r.message, /KHY_STRICT_READ_BOUNDARY/);
  });
});

test('strict mode: session-granted additional directory passes', () => {
  const fs = require('fs');
  const additional = require('../../src/services/additionalDirectories');
  additional._reset();
  // addDirectory requires the dir to exist on disk → grant a real temp dir.
  const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-grant-'));
  additional.addDirectory(granted);
  try {
    withEnv('KHY_STRICT_READ_BOUNDARY', '1', () => {
      const r = validateReadAccess(path.join(granted, 'data', 'file.txt'), path.join(os.tmpdir(), 'project-root'));
      assert.equal(r.valid, true);
    });
  } finally {
    additional._reset();
    try { fs.rmSync(granted, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
