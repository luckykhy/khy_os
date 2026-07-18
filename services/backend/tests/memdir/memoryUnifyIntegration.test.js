'use strict';

// E2E: memory split-brain unification. Each scenario runs in a fresh child
// process (dataHome.js caches its resolved home per-process, so isolation is
// required). Proves: with the unified-home gate ON, recall resolves to the
// durable getDataHome()/memory AND orphaned legacy memory is additively merged
// in; with the gate OFF, resolution byte-reverts to getProjectDataHome()/memory.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Runs paths/memdir in a child with the given env and prints a JSON probe.
const PROBE = `
  const fs = require('fs');
  const path = require('path');
  const paths = require('${path.resolve(__dirname, '../../src/memdir/paths.js')}'.replace(/\\\\/g, '/'));
  const memdir = require('${path.resolve(__dirname, '../../src/memdir/memdir.js')}'.replace(/\\\\/g, '/'));
  paths.ensureMemoryDirExists();
  const dir = paths.getMemoryDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const indexPath = path.join(dir, 'MEMORY.md');
  const index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';
  process.stdout.write(JSON.stringify({ dir, files, indexHasHome: index.includes('user_home') }));
`;

function runProbe(env) {
  const out = execFileSync(process.execPath, ['-e', PROBE], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return JSON.parse(out);
}

test('gate ON: recall resolves to dataHome/memory and merges orphaned legacy file', () => {
  const dataHome = mkTmp('khy-dh-');
  const projectHome = mkTmp('khy-ph-');
  // Seed an orphaned legacy memory on the project side (the pre-fix recall root).
  const legacyMem = path.join(projectHome, 'memory');
  fs.mkdirSync(legacyMem, { recursive: true });
  fs.writeFileSync(
    path.join(legacyMem, 'user_home.md'),
    '---\nname: user_home\ndescription: 用户家庭地址\ntype: user\n---\n\n用户家在示例市示例路 1 号。',
  );

  const probe = runProbe({
    KHY_DATA_HOME: dataHome,
    KHY_PROJECT_DATA_HOME: projectHome,
    KHY_MEMORY_UNIFIED_HOME: '1',
    KHY_MEMORY_MERGE_LEGACY: '1',
  });

  // Recall now points at the durable data-home side.
  assert.ok(probe.dir.startsWith(fs.realpathSync(dataHome)) || probe.dir.startsWith(dataHome),
    `expected dir under dataHome, got ${probe.dir}`);
  // The orphaned legacy file was additively copied in.
  assert.ok(probe.files.includes('user_home.md'), `expected merged file, got ${probe.files}`);
  // And unioned into the index.
  assert.ok(probe.indexHasHome, 'expected MEMORY.md to reference the merged memory');
});

test('gate OFF: resolution byte-reverts to getProjectDataHome/memory', () => {
  const dataHome = mkTmp('khy-dh-');
  const projectHome = mkTmp('khy-ph-');
  const probe = runProbe({
    KHY_DATA_HOME: dataHome,
    KHY_PROJECT_DATA_HOME: projectHome,
    KHY_MEMORY_UNIFIED_HOME: 'off',
  });
  assert.ok(probe.dir.startsWith(fs.realpathSync(projectHome)) || probe.dir.startsWith(projectHome),
    `expected dir under projectHome, got ${probe.dir}`);
});
