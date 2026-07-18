'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('ownerControlService built-in study secret', () => {
  const originalHome = process.env.HOME;
  let tmpHome = '';

  beforeEach(() => {
    jest.resetModules();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-owner-control-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (tmpHome) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('accepts khy2026 secret', () => {
    const owner = require('../../src/services/ownerControlService');
    const result = owner.verifyOwnerSecret('khy2026');
    expect(result.ok).toBe(true);
  });

  test('accepts legacy khy-2026 secret', () => {
    const owner = require('../../src/services/ownerControlService');
    const result = owner.verifyOwnerSecret('khy-2026');
    expect(result.ok).toBe(true);
  });
});
