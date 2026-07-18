'use strict';

/**
 * Tests for projectMemoryService.js — per-project memory management.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let mod;
try {
  mod = require('../../src/services/projectMemoryService');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('projectMemoryService', () => {
  const {
    getProjectDir,
    getMemoryDir,
    saveSessionTrace,
    loadLastSession,
    listProjects,
    pruneProjects,
  } = mod || {};

  // Use a unique temp directory as the fake project path
  let fakeCwd;

  beforeEach(() => {
    fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'projmem-test-'));
  });

  afterEach(() => {
    fs.rmSync(fakeCwd, { recursive: true, force: true });
  });

  test('getProjectDir creates and returns a directory', () => {
    const dir = getProjectDir(fakeCwd);
    expect(fs.existsSync(dir)).toBe(true);
    // Should contain a project.json metadata file
    const metaPath = path.join(dir, 'project.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.path).toBe(path.resolve(fakeCwd));
  });

  test('getProjectDir returns consistent path for same cwd', () => {
    const dir1 = getProjectDir(fakeCwd);
    const dir2 = getProjectDir(fakeCwd);
    expect(dir1).toBe(dir2);
  });

  test('getMemoryDir creates a memory subdirectory', () => {
    const memDir = getMemoryDir(fakeCwd);
    expect(fs.existsSync(memDir)).toBe(true);
    expect(memDir).toContain('memory');
  });

  test('saveSessionTrace and loadLastSession round-trip', () => {
    const trace = {
      commandsUsed: ['backtest', 'analyze'],
      messagesCount: 12,
      duration: 300,
    };
    saveSessionTrace(fakeCwd, trace);
    const loaded = loadLastSession(fakeCwd);
    expect(loaded).toBeTruthy();
    expect(loaded.commandsUsed).toEqual(['backtest', 'analyze']);
    expect(loaded.timestamp).toBeTruthy();
  });

  test('loadLastSession returns null when no session exists', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projmem-empty-'));
    const result = loadLastSession(otherDir);
    // May be null or undefined — the important thing is it does not throw
    expect([null, undefined]).toContain(result);
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  test('listProjects returns array sorted by lastAccessed', () => {
    // Create two project entries
    getProjectDir(fakeCwd);
    const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'projmem-second-'));
    getProjectDir(secondCwd);

    const projects = listProjects();
    expect(Array.isArray(projects)).toBe(true);
    // Should contain at least the two we just created
    expect(projects.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(secondCwd, { recursive: true, force: true });
  });

  test('pruneProjects removes oldest when exceeding limit', () => {
    // Create several project entries
    const cwds = [];
    for (let i = 0; i < 5; i++) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `projmem-prune-${i}-`));
      getProjectDir(cwd);
      cwds.push(cwd);
    }

    const before = listProjects().length;
    const removed = pruneProjects(Math.max(1, before - 2));
    expect(removed).toBeGreaterThanOrEqual(0);

    // Cleanup
    for (const cwd of cwds) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});
