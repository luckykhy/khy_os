'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'check-change-safety.js');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runSafetyCheck(...targets) {
  const outputPath = path.join(os.tmpdir(), `khy-change-safety-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const command = [
    'node',
    shellQuote(path.relative(ROOT, scriptPath)),
    ...targets.map(shellQuote),
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

describe('check-change-safety maintainer map integration', () => {
  test('uses exact-file maintainer verify commands for runtime files', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/services/daemonManager.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:maintainer:runtime/);
    assert.match(stdout, /khy doctor/);
  });

  test('uses directory maintainer verify commands for CLI handler targets', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/cli/handlers');

    assert.equal(status, 1);
    assert.match(stdout, /npm run test:maintainer:cli-routing/);
    assert.match(stdout, /node -e "require\('\.\/services\/backend\/src\/cli\/router'\)"/);
  });

  test('keeps targeted agent-rules command and prompt verification for prompt core', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/constants/prompts.js');

    assert.equal(status, 0);
    assert.match(stdout, /node scripts\/check-agent-rules\.js 'services\/backend\/src\/constants\/prompts\.js'/);
    assert.match(stdout, /node --test services\/backend\/tests\/promptOnDemandSections\.test\.js/);
    assert.doesNotMatch(stdout, /node scripts\/check-agent-rules\.js --changed/);
  });

  test('maps AI management files to the smallest useful verify commands', () => {
    const { status, stdout } = runSafetyCheck('services/ai-backend/src/routes/aiGatewayAdmin.js');

    assert.equal(status, 0);
    assert.match(stdout, /High-risk surface touched: route layer\./);
    assert.match(stdout, /npm run test:maintainer:ai-management/);
    assert.match(stdout, /npm run build --prefix apps\/ai-frontend/);
  });

  test('maps safety gate files back to safety verification', () => {
    const { status, stdout } = runSafetyCheck('scripts/check-change-safety.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run check:maintainer:safety/);
    assert.match(stdout, /npm run check:quality-gates/);
  });

  test('prefers AI management verification over generic gateway checks for backend admin routes', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/routes/aiGatewayAdmin.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:maintainer:ai-management/);
    assert.match(stdout, /npm run build --prefix apps\/ai-frontend/);
    assert.doesNotMatch(stdout, /npm run test:maintainer:gateway/);
  });

  test('keeps bootstrap verification minimal for packaging files already covered by the maintainer map', () => {
    const { status, stdout } = runSafetyCheck('pyproject.toml');

    assert.equal(status, 0);
    assert.match(stdout, /npm run check:maintainer:bootstrap/);
    assert.match(stdout, /npm run check:manifest-sync/);
    assert.match(stdout, /bash scripts\/release\/build-and-audit-pip-purity\.sh/);
    assert.doesNotMatch(stdout, /npm run test:maintainer:publish/);
    assert.doesNotMatch(stdout, /npm run check:version-sync/);
  });

  test('keeps generic gateway fallback for backend routes not covered by the maintainer map', () => {
    const { status, stdout } = runSafetyCheck('services/backend/src/routes/largeTasks.js');

    assert.equal(status, 0);
    assert.match(stdout, /npm run test:maintainer:gateway/);
    assert.match(stdout, /khy doctor/);
  });
});
