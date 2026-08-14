'use strict';

/**
 * deploy.orchestrator.test.js — the detect→sync→install→build→start pipeline.
 *
 * Every external effect (detect/sync/runStep/launch/ledger) is injected, so the
 * orchestration logic is verified deterministically with zero processes, zero
 * disk writes, and zero network. Focus: correct step ordering, transparent step
 * reporting, fail-safe halting, and ledger persistence.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { deployProject, parseCommandOverride, safeName } = require('../src/services/deploy');

/** Build injectable deps with recording stubs; override per-test. */
function makeDeps(over = {}) {
  const calls = { runStep: [], launch: [], ledger: [] };
  const plan = over.plan || {
    type: 'node', signals: ['package.json'], packageManager: 'npm',
    install: { exe: 'npm', args: ['ci'], display: 'npm ci' },
    build: { exe: 'npm', args: ['run', 'build'], display: 'npm run build' },
    start: { exe: 'node', args: ['server.js'], display: 'node server.js' },
    port: null, notes: [],
  };
  const deps = {
    fs: { existsSync: () => true },
    cp: {},
    platform: 'linux',
    cwd: '/src',
    detect: over.detect || (() => plan),
    sync: over.sync || (() => ({ copied: ['a.js'], skipped: ['node_modules'], dirs: 1, bytes: 10 })),
    runStep: over.runStep || ((cmd) => { calls.runStep.push(cmd.display); return { ok: true, code: 0, output: '', command: cmd.display }; }),
    launch: over.launch || ((cmd, o) => { calls.launch.push(cmd.display); return { pid: 4242, logFile: o.logFile, command: cmd.display }; }),
    ledger: { upsert: (r) => { calls.ledger.push(r); return r; } },
    now: () => '2026-06-19T00:00:00.000Z',
  };
  return { deps, calls, plan };
}

describe('deployProject — happy path', () => {
  test('runs detect→sync→install→build then skips start without --start', () => {
    const { deps, calls } = makeDeps();
    const steps = [];
    const res = deployProject({ target: '/srv/app', source: '/src', onStep: (s) => steps.push(s.name), deps });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'deployed');
    assert.deepEqual(steps, ['detect', 'sync', 'install', 'build', 'start']);
    assert.deepEqual(calls.runStep, ['npm ci', 'npm run build']);
    assert.equal(calls.launch.length, 0);
    assert.equal(res.pid, null);
  });

  test('--start launches and records running pid + ledger', () => {
    const { deps, calls } = makeDeps();
    const res = deployProject({ target: '/srv/app', source: '/src', start: true, deps });
    assert.equal(res.status, 'running');
    assert.equal(res.pid, 4242);
    assert.equal(calls.launch.length, 1);
    const led = calls.ledger.at(-1);
    assert.equal(led.status, 'running');
    assert.equal(led.pid, 4242);
    assert.equal(led.startCmd, 'node server.js');
  });

  test('default name derives from target basename', () => {
    const { deps } = makeDeps();
    const res = deployProject({ target: '/srv/my-api', deps });
    assert.equal(res.name, 'my-api');
  });
});

describe('deployProject — fail-safe halting', () => {
  test('install failure halts before build and start', () => {
    const { deps, calls } = makeDeps({
      runStep: (cmd) => {
        calls && calls.runStep && calls.runStep.push(cmd.display);
        return { ok: cmd.display !== 'npm ci', code: 1, output: 'boom', command: cmd.display };
      },
    });
    const steps = [];
    const res = deployProject({ target: '/srv/app', start: true, onStep: (s) => steps.push(s), deps });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    const names = steps.map((s) => s.name);
    assert.ok(names.includes('install'));
    assert.ok(!names.includes('build'), 'build must not run after install failure');
    assert.ok(!names.includes('start'), 'start must not run after install failure');
    assert.equal(calls.launch.length, 0);
  });

  test('sync failure halts immediately', () => {
    const { deps } = makeDeps({ sync: () => { throw new Error('disk full'); } });
    const res = deployProject({ target: '/srv/app', deps });
    assert.equal(res.ok, false);
    const failed = res.steps.find((s) => s.name === 'sync');
    assert.equal(failed.status, 'failed');
    assert.match(failed.detail, /disk full/);
  });
});

describe('deployProject — flags & overrides', () => {
  test('--no-install / --no-build skip those steps', () => {
    const { deps, calls } = makeDeps();
    const res = deployProject({ target: '/srv/app', install: false, build: false, deps });
    assert.equal(calls.runStep.length, 0);
    const install = res.steps.find((s) => s.name === 'install');
    assert.equal(install.status, 'skipped');
  });

  test('--cmd override beats detected start command', () => {
    const { deps, calls } = makeDeps();
    deployProject({ target: '/srv/app', start: true, startCmd: 'pm2 start app', deps });
    assert.equal(calls.launch[0], 'pm2 start app');
  });

  test('start requested but no command available → honest failure, still deployed', () => {
    const plan = {
      type: 'unknown', signals: [], packageManager: null,
      install: null, build: null, start: null, port: null, notes: ['无法识别'],
    };
    const { deps } = makeDeps({ plan });
    const res = deployProject({ target: '/srv/app', start: true, deps });
    const startStep = res.steps.find((s) => s.name === 'start');
    assert.equal(startStep.status, 'failed');
    assert.match(startStep.detail, /--cmd/);
    // Files were still deployed even though we could not start.
    assert.equal(res.ok, true);
    assert.equal(res.status, 'deployed');
  });

  test('missing target throws', () => {
    const { deps } = makeDeps();
    assert.throws(() => deployProject({ deps }), /目标路径/);
  });
});

describe('helpers', () => {
  test('parseCommandOverride splits argv', () => {
    assert.deepEqual(parseCommandOverride('node server.js --port 3000'), {
      exe: 'node', args: ['server.js', '--port', '3000'], display: 'node server.js --port 3000',
    });
    assert.equal(parseCommandOverride('   '), null);
  });
  test('safeName sanitizes target basename', () => {
    assert.equal(safeName('/srv/My App!'), 'My_App_');
  });
});
