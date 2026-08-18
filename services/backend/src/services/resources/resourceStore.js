'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getBaseDataDir } = require('../../utils/dataHome');

const LOCK_STALE_MS = 20 * 60 * 1000;
const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function assertSafeSegment(value, label = 'resource id') {
  if (typeof value !== 'string' || !RESOURCE_ID_RE.test(value) || value.includes('..')) throw new Error(`unsafe ${label}`);
  return value;
}

function getRoot() {
  return path.resolve(process.env.KHY_RESOURCE_HOME || getBaseDataDir('resources'));
}

function layout(root = getRoot()) {
  return {
    root,
    blobs: path.join(root, 'blobs', 'sha256'),
    installs: path.join(root, 'installs'),
    active: path.join(root, 'active'),
    staging: path.join(root, 'staging'),
    locks: path.join(root, 'locks'),
    state: path.join(root, 'state'),
  };
}

function ensureLayout(root = getRoot()) {
  const dirs = layout(root);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function blobPath(sha256, root = getRoot()) {
  if (!/^[a-f0-9]{64}$/i.test(String(sha256))) throw new Error('invalid sha256');
  const hash = String(sha256).toLowerCase();
  return path.join(layout(root).blobs, hash.slice(0, 2), hash);
}

function installPath(kind, id, version, platform, root = getRoot()) {
  assertSafeSegment(kind, 'resource kind');
  assertSafeSegment(id);
  assertSafeSegment(version, 'resource version');
  assertSafeSegment(platform, 'platform');
  return path.join(layout(root).installs, kind, id, version, platform);
}

function activePath(kind, id, root = getRoot()) {
  assertSafeSegment(kind, 'resource kind');
  assertSafeSegment(id);
  return path.join(layout(root).active, kind, `${id}.json`);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readActive(kind, id, root = getRoot()) {
  return readJson(activePath(kind, id, root));
}

function installRecordPath(kind, id, version, platform, root = getRoot()) {
  return path.join(installPath(kind, id, version, platform, root), 'install.json');
}

function readInstallRecord(kind, id, version, platform, root = getRoot()) {
  return readJson(installRecordPath(kind, id, version, platform, root));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  try { fs.renameSync(temp, filePath); } catch (err) { try { fs.rmSync(filePath, { force: true }); fs.renameSync(temp, filePath); } catch { throw err; } }
}

function activate(record, root = getRoot()) {
  const file = activePath(record.kind, record.id, root);
  atomicWriteJson(file, { ...record, activatedAt: new Date().toISOString() });
  return readActive(record.kind, record.id, root);
}

function acquireLock(name, root = getRoot()) {
  const file = path.join(layout(root).locks, `${assertSafeSegment(name, 'lock')}.lock`);
  try { fs.mkdirSync(file, { recursive: false }); fs.writeFileSync(path.join(file, 'owner'), `${process.pid}\n`); return file; }
  catch (err) {
    if (err.code === 'EEXIST') {
      try { if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) { fs.rmSync(file, { recursive: true, force: true }); fs.mkdirSync(file); return file; } } catch { /* another process owns it */ }
    }
    return null;
  }
}

function releaseLock(lock) { if (lock) try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }

function createStore(options = {}) {
  const root = path.resolve(options.root || process.env.KHY_RESOURCE_HOME || getBaseDataDir('resources'));
  const dirs = ensureLayout(root);
  return {
    root, dirs,
    blobPath: sha => blobPath(sha, root),
    installPath: (kind, id, version, platform) => installPath(kind, id, version, platform, root),
    activePath: (kind, id) => activePath(kind, id, root),
    installRecordPath: (kind, id, version, platform) => installRecordPath(kind, id, version, platform, root),
    readInstallRecord: (kind, id, version, platform) => readInstallRecord(kind, id, version, platform, root),
    writeInstallRecord: record => atomicWriteJson(installRecordPath(record.kind, record.id, record.version, record.platform, root), record),
    readActive: (kind, id) => readActive(kind, id, root),
    activate: record => activate(record, root),
    acquireLock: name => acquireLock(name, root),
    releaseLock,
    sha256File,
    atomicWriteJson,
    hasBlob: sha => fs.existsSync(blobPath(sha, root)),
    stat: () => ({ root, dirs }),
  };
}

module.exports = { createStore, getRoot, layout, ensureLayout, blobPath, installPath, installRecordPath, readInstallRecord, activePath, readActive, activate, acquireLock, releaseLock, sha256File, atomicWriteJson, assertSafeSegment };
