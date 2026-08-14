'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'ci', 'print-maintainer-map.js');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runMaintainerMap(...args) {
  const outputPath = path.join(os.tmpdir(), `khy-maintainer-map-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const command = [
    'node',
    shellQuote(path.relative(ROOT, scriptPath)),
    ...args.map(shellQuote),
    '>',
    shellQuote(outputPath),
    '2>&1',
  ].join(' ');

  let status = 0;
  try {
    execSync(command, {
      cwd: ROOT,
      stdio: 'ignore',
      shell: '/bin/bash',
    });
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1;
  }

  const stdout = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  fs.rmSync(outputPath, { force: true });
  return { status, stdout };
}

describe('print-maintainer-map script', () => {
  test('lists expected maintainer areas', () => {
    const { status, stdout } = runMaintainerMap('--list-areas');

    assert.equal(status, 0);
    assert.match(stdout, /ai-management-surface - AI Management UI and API/);
    assert.match(stdout, /maintenance-safety - Maintenance Safety and Rule Gates/);
  });

  test('prints selected area JSON with the current admin route mapping', () => {
    const { status, stdout } = runMaintainerMap('--area', 'ai-management-surface', '--json');

    assert.equal(status, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.area.id, 'ai-management-surface');
    assert.ok(payload.area.paths.includes('services/backend/src/routes/aiGatewayAdmin.js'));
    assert.ok(payload.area.paths.includes('services/ai-backend/src/routes/aiGatewayAdmin.js'));
    assert.deepEqual(payload.area.verify, [
      'npm run test:maintainer:ai-management',
      'npm run build --prefix apps/ai-frontend',
    ]);
  });

  test('checks a selected area without missing paths', () => {
    const { status, stdout } = runMaintainerMap('--check', '--area', 'ai-management-surface');

    assert.equal(status, 0);
    assert.match(stdout, /OK file services\/backend\/src\/routes\/aiGatewayAdmin\.js/);
    assert.match(stdout, /OK dir apps\/ai-frontend\/src/);
    assert.doesNotMatch(stdout, /MISSING /);
  });

  test('returns an error for an unknown area id', () => {
    const { status, stdout } = runMaintainerMap('--area', 'not-a-real-area');

    assert.equal(status, 2);
    assert.match(stdout, /Maintainer map error: unknown area: not-a-real-area/);
  });
});
