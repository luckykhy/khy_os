'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyPayload } = require('../../../src/services/resources/archiveInstaller');

describe('archive installer', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-archive-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('rejects symlink payload entries before installation', () => {
    const payload = path.join(root, 'payload');
    const target = path.join(root, 'target');
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, 'ok.txt'), 'ok');
    try { fs.symlinkSync(path.join(root, 'outside.txt'), path.join(payload, 'escape.txt')); } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') return;
      throw err;
    }
    expect(() => copyPayload(payload, target)).toThrow(/symlink payload entry/);
    expect(fs.existsSync(target)).toBe(false);
  });
});
