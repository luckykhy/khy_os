'use strict';

/**
 * unpackTool — zip-family format support (jest).
 *
 * Regression for the Windows pip failure where `unpack` refused a Python wheel
 * ("Unsupported archive format: .whl"). A .whl (and .jar/.egg/.nupkg/.xpi/.vsix)
 * is a standard ZIP container; node-stream-zip reads it by central directory, so
 * the only gate that mattered was _detectFormat. These tests exercise the public
 * validateInput / execute API with real fixtures (built via python3 zipfile).
 *
 * list_only is used for the read path: it writes nothing (unconfined), so it
 * proves the archive is parsed without touching extraction-root confinement.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const unpack = require('../src/tools/unpackTool');

let tmpDir;
let hasPython = false;

function makeZip(targetPath) {
  const script = [
    'import sys, zipfile',
    'p = sys.argv[1]',
    "z = zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED)",
    "z.writestr('pkg/__init__.py', 'x = 1\\n')",
    "z.writestr('pkg-1.0.dist-info/METADATA', 'Name: pkg\\nVersion: 1.0\\n')",
    'z.close()',
  ].join('\n');
  execFileSync('python3', ['-c', script, targetPath]);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-unpack-'));
  try {
    execFileSync('python3', ['--version']);
    hasPython = true;
  } catch { hasPython = false; }
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('unpack — zip-family detection via validateInput', () => {
  test.each(['pkg-1.0.whl', 'lib.jar', 'thing.egg', 'tool.nupkg', 'ext.xpi', 'plugin.vsix'])(
    'accepts %s as a valid (zip-family) archive',
    async (name) => {
      if (!hasPython) return; // no python3 to build a real fixture; skip quietly
      const p = path.join(tmpDir, name);
      makeZip(p);
      const res = await unpack.validateInput({ file_path: p });
      expect(res.valid).toBe(true);
    },
  );

  test('still rejects a genuinely unsupported extension with a clear message', async () => {
    const p = path.join(tmpDir, 'note.bogus');
    fs.writeFileSync(p, 'not an archive');
    const res = await unpack.validateInput({ file_path: p });
    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/Unsupported archive format/);
    expect(res.message).toMatch(/\.whl/); // help text now advertises zip-family
  });
});

describe('unpack — reads a real .whl end-to-end (list_only)', () => {
  test('lists wheel contents without error', async () => {
    if (!hasPython) return;
    const p = path.join(tmpDir, 'wheel-2.3.whl');
    makeZip(p);
    const res = await unpack.execute({ file_path: p, list_only: true });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/pkg\/__init__\.py/);
    expect(res.output).toMatch(/METADATA/);
  });
});
