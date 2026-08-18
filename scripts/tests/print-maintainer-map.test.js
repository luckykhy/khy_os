'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'ci', 'print-maintainer-map.js');

function runMaintainerMap(...args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (error) {
    const stdout = `${error.stdout || ''}${error.stderr || ''}`;
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout,
    };
  }
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
      'npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js',
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
