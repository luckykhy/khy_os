'use strict';

const assert = require('node:assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withTempDir, createEphemeralDir } = require('../src/utils/ephemeralTmp');

test('withTempDir creates a real dir and destroys it on success', async () => {
  let seen = '';
  const out = await withTempDir(async (dir) => {
    seen = dir;
    assert.ok(fs.existsSync(dir), 'dir should exist inside the body');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'hi');
    return 'result';
  });
  assert.strictEqual(out, 'result');
  assert.ok(seen.startsWith(os.tmpdir()) || seen.includes('khy-ephemeral-'));
  assert.ok(!fs.existsSync(seen), 'dir must be destroyed after the body');
});

test('withTempDir destroys the dir even when the body throws', async () => {
  let seen = '';
  await assert.rejects(
    withTempDir(async (dir) => {
      seen = dir;
      assert.ok(fs.existsSync(dir));
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.ok(seen && !fs.existsSync(seen), 'dir must be destroyed on throw');
});

test('withTempDir supports a synchronous body', async () => {
  let seen = '';
  const out = await withTempDir((dir) => {
    seen = dir;
    return fs.existsSync(dir);
  });
  assert.strictEqual(out, true);
  assert.ok(!fs.existsSync(seen));
});

test('dir name carries the khy-ephemeral- prefix so cleanupService sweeps leaks', async () => {
  let seen = '';
  await withTempDir((dir) => { seen = dir; });
  assert.ok(path.basename(seen).startsWith('khy-ephemeral-'));
});

test('createEphemeralDir dispose is idempotent and removes the dir', () => {
  const h = createEphemeralDir({ prefix: 'unit/test bad*chars' });
  assert.ok(fs.existsSync(h.path));
  // label is sanitized (no slash/space/star) but still applied
  assert.ok(path.basename(h.path).startsWith('khy-ephemeral-unittestbadchars-'));
  h.dispose();
  assert.ok(!fs.existsSync(h.path));
  h.dispose(); // second call must be a no-op, not throw
  assert.ok(!fs.existsSync(h.path));
});

test('honors KHY_OS_TEMP_DIR as the base directory', async () => {
  const customBase = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ephemeral-base-'));
  const prev = process.env.KHY_OS_TEMP_DIR;
  process.env.KHY_OS_TEMP_DIR = customBase;
  try {
    let seen = '';
    await withTempDir((dir) => { seen = dir; });
    assert.ok(seen.startsWith(customBase), 'dir should sit under the configured base');
  } finally {
    if (prev === undefined) delete process.env.KHY_OS_TEMP_DIR;
    else process.env.KHY_OS_TEMP_DIR = prev;
    fs.rmSync(customBase, { recursive: true, force: true });
  }
});
