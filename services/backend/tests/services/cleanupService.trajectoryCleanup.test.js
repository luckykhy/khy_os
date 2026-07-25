'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function agePath(target, daysAgo) {
  const sec = (Date.now() - daysAgo * 86400 * 1000) / 1000;
  fs.utimesSync(target, sec, sec);
}

function mkAged(filePath, daysAgo) {
  fs.writeFileSync(filePath, 'x');
  agePath(filePath, daysAgo);
}

describe('cleanupService.cleanTrajectories', () => {
  let root;
  let prevHome;
  let prevAge;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-traj-'));
    prevHome = process.env.KHY_PROJECT_DATA_HOME;
    prevAge = process.env.KHY_TRAJECTORY_MAX_AGE_D;
    process.env.KHY_PROJECT_DATA_HOME = path.join(root, '.khy');
    process.env.KHY_TRAJECTORY_MAX_AGE_D = '7';
    jest.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.KHY_PROJECT_DATA_HOME;
    else process.env.KHY_PROJECT_DATA_HOME = prevHome;
    if (prevAge === undefined) delete process.env.KHY_TRAJECTORY_MAX_AGE_D;
    else process.env.KHY_TRAJECTORY_MAX_AGE_D = prevAge;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('deletes whole trajectory group only when newest sidecar is stale; keeps active groups and non-trajectory files', () => {
    const dataHome = require('../../src/utils/dataHome');
    const sessDir = path.join(dataHome.getProjectDataDir('sessions'), '-home-test');
    fs.mkdirSync(sessDir, { recursive: true });

    // Stale group: transcript + every sidecar suffix, all aged 30d → entire group removed.
    for (const ext of ['.jsonl', '.json', '.checkpoint.json', '.replay-ledger.jsonl', '.trace-chain.json']) {
      mkAged(path.join(sessDir, `oldsess${ext}`), 30);
    }
    // Active group: .json sidecar is stale but the .jsonl transcript is fresh → whole group kept.
    mkAged(path.join(sessDir, 'newsess.jsonl'), 1);
    mkAged(path.join(sessDir, 'newsess.json'), 30);
    // Non-trajectory file (e.g. cwd marker) must never be touched.
    mkAged(path.join(sessDir, 'project.marker'), 30);

    const cleanupService = require('../../src/services/cleanupService');
    const result = cleanupService.cleanTrajectories();

    expect(result.removed).toBe(5);

    const sess = (p) => fs.existsSync(path.join(sessDir, p));
    expect(sess('oldsess.jsonl')).toBe(false);
    expect(sess('oldsess.json')).toBe(false);
    expect(sess('oldsess.checkpoint.json')).toBe(false);
    expect(sess('oldsess.replay-ledger.jsonl')).toBe(false);
    expect(sess('oldsess.trace-chain.json')).toBe(false);
    expect(sess('newsess.jsonl')).toBe(true);
    expect(sess('newsess.json')).toBe(true);
    expect(sess('project.marker')).toBe(true);
  });

  test('removes stale trajectory_replay content-store dirs by newest tree mtime, keeps fresh ones', () => {
    const dataHome = require('../../src/utils/dataHome');
    const replayRoot = path.join(dataHome.getProjectDataHome(), 'trajectory_replay');

    // Stale sid: age the entire tree (dirs included) so _newestMtime sees it as old.
    fs.mkdirSync(path.join(replayRoot, 'oldsid', 'content'), { recursive: true });
    mkAged(path.join(replayRoot, 'oldsid', 'content', 'abc'), 30);
    agePath(path.join(replayRoot, 'oldsid', 'content'), 30);
    agePath(path.join(replayRoot, 'oldsid'), 30);

    // Fresh sid: kept.
    fs.mkdirSync(path.join(replayRoot, 'newsid', 'content'), { recursive: true });
    mkAged(path.join(replayRoot, 'newsid', 'content', 'def'), 1);

    const cleanupService = require('../../src/services/cleanupService');
    cleanupService.cleanTrajectories();

    expect(fs.existsSync(path.join(replayRoot, 'oldsid'))).toBe(false);
    expect(fs.existsSync(path.join(replayRoot, 'newsid'))).toBe(true);
  });

  test('retention <= 0 disables cleanup entirely', () => {
    process.env.KHY_TRAJECTORY_MAX_AGE_D = '0';
    jest.resetModules();
    const dataHome = require('../../src/utils/dataHome');
    const sessDir = path.join(dataHome.getProjectDataDir('sessions'), '-home-test');
    fs.mkdirSync(sessDir, { recursive: true });
    mkAged(path.join(sessDir, 'ancient.jsonl'), 365);

    const cleanupService = require('../../src/services/cleanupService');
    const result = cleanupService.cleanTrajectories();

    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(sessDir, 'ancient.jsonl'))).toBe(true);
  });
});
