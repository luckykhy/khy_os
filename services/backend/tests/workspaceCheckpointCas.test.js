'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function loadCheckpointService(dataHome) {
  const modulePath = require.resolve('../src/services/workspace/checkpointService');
  const dataHomePath = require.resolve('../src/utils/dataHome');
  delete require.cache[modulePath];
  delete require.cache[dataHomePath];
  process.env.KHY_DATA_HOME = dataHome;
  return require('../src/services/workspace/checkpointService');
}

function loadCleanupService(appHome) {
  const modulePath = require.resolve('../src/services/cleanupService');
  const dataHomePath = require.resolve('../src/utils/dataHome');
  delete require.cache[modulePath];
  delete require.cache[dataHomePath];
  process.env.KHY_APP_HOME = appHome;
  return require('../src/services/cleanupService');
}

test('CAS git-diff checkpoints deduplicate, restore, and reclaim only unreferenced objects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-checkpoint-cas-'));
  const dataHome = path.join(root, 'data');
  const project = path.join(root, 'project');
  const oldDataHome = process.env.KHY_DATA_HOME;
  const oldMode = process.env.KHY_CHECKPOINT_STORAGE_MODE;

  try {
    fs.mkdirSync(project, { recursive: true });
    git(['init'], project);
    git(['config', 'user.email', 'checkpoint@example.test'], project);
    git(['config', 'user.name', 'Checkpoint Test'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'base\n');
    git(['add', 'note.txt'], project);
    git(['commit', '-m', 'base'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'changed\n');

    process.env.KHY_CHECKPOINT_STORAGE_MODE = 'cas';
    const service = loadCheckpointService(dataHome);
    const first = service.saveCheckpoint(project, { mode: 'git-diff', message: 'first' });
    const second = service.saveCheckpoint(project, { mode: 'git-diff', message: 'second' });
    assert.equal(first.storage, 'cas');
    assert.equal(second.storage, 'cas');
    assert.equal(first.objects[0].digest, second.objects[0].digest);

    const checkpointDir = path.join(service.CHECKPOINT_ROOT, require('crypto')
      .createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 12));
    const objectPath = path.join(checkpointDir, 'objects', 'sha256', first.objects[0].digest.slice(0, 2), first.objects[0].digest + '.gz');
    assert.equal(fs.existsSync(objectPath), true);
    assert.equal(fs.existsSync(path.join(checkpointDir, first.id + '.patch')), false);

    git(['checkout', '--', 'note.txt'], project);
    const restored = service.restoreCheckpoint(project, first.id);
    assert.equal(restored.restored, true);
    assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8').trimEnd(), 'changed');

    assert.equal(service.deleteCheckpoint(project, first.id), true);
    assert.equal(fs.existsSync(objectPath), true);
    assert.equal(service.deleteCheckpoint(project, second.id), true);
    assert.equal(fs.existsSync(objectPath), false);
  } finally {
    if (oldDataHome === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = oldDataHome;
    if (oldMode === undefined) delete process.env.KHY_CHECKPOINT_STORAGE_MODE;
    else process.env.KHY_CHECKPOINT_STORAGE_MODE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy checkpoint mode retains its materialized patch layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-checkpoint-legacy-'));
  const dataHome = path.join(root, 'data');
  const project = path.join(root, 'project');
  const oldDataHome = process.env.KHY_DATA_HOME;
  const oldMode = process.env.KHY_CHECKPOINT_STORAGE_MODE;

  try {
    fs.mkdirSync(project, { recursive: true });
    git(['init'], project);
    git(['config', 'user.email', 'checkpoint@example.test'], project);
    git(['config', 'user.name', 'Checkpoint Test'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'base\n');
    git(['add', 'note.txt'], project);
    git(['commit', '-m', 'base'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'changed\n');

    process.env.KHY_CHECKPOINT_STORAGE_MODE = 'legacy';
    const service = loadCheckpointService(dataHome);
    const entry = service.saveCheckpoint(project, { mode: 'git-diff' });
    assert.equal(entry.storage, undefined);
    const checkpointDir = path.join(service.CHECKPOINT_ROOT, require('crypto')
      .createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 12));
    assert.equal(fs.existsSync(path.join(checkpointDir, entry.id + '.patch')), true);
  } finally {
    if (oldDataHome === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = oldDataHome;
    if (oldMode === undefined) delete process.env.KHY_CHECKPOINT_STORAGE_MODE;
    else process.env.KHY_CHECKPOINT_STORAGE_MODE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint quota sweep evicts manifest entries and keeps referenced CAS objects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-checkpoint-quota-'));
  const appHome = path.join(root, 'app');
  const project = path.join(root, 'project');
  const oldDataHome = process.env.KHY_DATA_HOME;
  const oldAppHome = process.env.KHY_APP_HOME;
  const oldMode = process.env.KHY_CHECKPOINT_STORAGE_MODE;

  try {
    fs.mkdirSync(project, { recursive: true });
    git(['init'], project);
    git(['config', 'user.email', 'checkpoint@example.test'], project);
    git(['config', 'user.name', 'Checkpoint Test'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'base\n');
    fs.writeFileSync(path.join(project, 'big.txt'), 'base\n');
    git(['add', '.'], project);
    git(['commit', '-m', 'base'], project);

    process.env.KHY_CHECKPOINT_STORAGE_MODE = 'cas';
    process.env.KHY_APP_HOME = appHome;
    const service = loadCheckpointService(appHome);
    const checkpointRoot = service.CHECKPOINT_ROOT;
    assert.equal(checkpointRoot, path.join(appHome, 'checkpoints'));

    // Incompressible payload so the gzipped CAS object stays over the quota.
    const bulk = require('crypto').randomBytes(1024 * 1024).toString('hex');
    fs.writeFileSync(path.join(project, 'big.txt'), bulk + '\n');
    const bulky = service.saveCheckpoint(project, { mode: 'git-diff', message: 'bulky' });

    git(['checkout', '--', 'big.txt'], project);
    fs.writeFileSync(path.join(project, 'note.txt'), 'changed\n');
    const keepA = service.saveCheckpoint(project, { mode: 'git-diff', message: 'keep-a' });
    const keepB = service.saveCheckpoint(project, { mode: 'git-diff', message: 'keep-b' });
    assert.equal(keepA.objects[0].digest, keepB.objects[0].digest);

    const checkpointDir = path.join(checkpointRoot, require('crypto')
      .createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 12));
    const objectFor = (digest) => path.join(
      checkpointDir, 'objects', 'sha256', digest.slice(0, 2), digest + '.gz');
    const bulkyObject = objectFor(bulky.objects[0].digest);
    const sharedObject = objectFor(keepA.objects[0].digest);
    assert.equal(fs.existsSync(bulkyObject), true);
    assert.equal(fs.existsSync(sharedObject), true);

    const cleanup = loadCleanupService(appHome);
    const swept = cleanup.cleanCheckpointStorage(1);
    assert.ok(swept.removed >= 1);
    assert.ok(swept.bytes > 0);

    // The evicted entry's object is reclaimed; the object two surviving entries
    // still reference must never be dropped.
    assert.equal(fs.existsSync(bulkyObject), false);
    assert.equal(fs.existsSync(sharedObject), true);

    const ids = service.listCheckpoints(project).map((entry) => entry.id);
    assert.equal(ids.includes(bulky.id), false);
    assert.deepEqual(ids.sort(), [keepA.id, keepB.id].sort());

    git(['checkout', '--', 'note.txt'], project);
    const restored = service.restoreCheckpoint(project, keepB.id);
    assert.equal(restored.restored, true);
    assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8').trimEnd(), 'changed');
  } finally {
    if (oldDataHome === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = oldDataHome;
    if (oldAppHome === undefined) delete process.env.KHY_APP_HOME;
    else process.env.KHY_APP_HOME = oldAppHome;
    if (oldMode === undefined) delete process.env.KHY_CHECKPOINT_STORAGE_MODE;
    else process.env.KHY_CHECKPOINT_STORAGE_MODE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
