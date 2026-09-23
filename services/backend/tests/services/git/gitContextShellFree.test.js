'use strict';
const cp = require('child_process');
const path = require('path');
const SERVICE_PATH = require.resolve('../../../src/services/gitContextService');
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

// Master spies installed ONCE at file load, BEFORE the service is first
// required: the service (and the win32 git detector) pull spawnSync/execSync
// off child_process at module load, so the wrapper must be in place first.
// Under jest, `delete require.cache` is a no-op (jest keeps its own registry),
// so per-test re-splicing leaves the singleton holding a dead spy — which is
// exactly why the OFF case used to record zero calls. A stable suite-level
// wrapper with a per-test ACTIVE_CALLS target routes every git invocation to
// whichever test is currently running.
let ACTIVE_CALLS = null;
const _realSpawnSync = cp.spawnSync;
const _realExecSync = cp.execSync;
// win32 transport may spawn an absolute git.exe path, not the PATH name.
const _isGitFile = (f) => typeof f === 'string' && /(^|[\\/])git(\.exe)?$/i.test(f);
const _isGitCmd = (c) => typeof c === 'string' && /git(\.exe)?["']?\s/i.test(c);
cp.spawnSync = function (file, args, opts) {
  if (ACTIVE_CALLS && _isGitFile(file)) ACTIVE_CALLS.spawnSyncGit.push(args);
  return _realSpawnSync.call(cp, file, args, opts);
};
cp.execSync = function (command, opts) {
  if (ACTIVE_CALLS && _isGitCmd(command)) ACTIVE_CALLS.execSyncGit.push(command);
  return _realExecSync.call(cp, command, opts);
};

const svc = require(SERVICE_PATH);

// Precondition: these are integration tests over REAL git, probed through the
// service's own resolution (the win32 detector can find an absolute git.exe
// even when PATH has none). If the machine has no reachable git or the repo
// root is not a git work tree, the transport contract is unobservable — skip
// honestly instead of failing an environment precondition the service
// correctly fail-softs on.
const _probe = svc.collectGitContext(REPO_ROOT, { force: true });
const GIT_PRECONDITION_OK = !!(_probe && _probe.isGitRepo === true);

function _setGate(val) {
  if (val === undefined) delete process.env.KHY_GIT_SHELL_FREE;
  else process.env.KHY_GIT_SHELL_FREE = val;
}

// `['--version']` is the win32 executable detector's PATH probe — detection
// overhead, not part of the service's transport contract.
const _isDetectorProbe = (a) => Array.isArray(a) && a.length === 1 && a[0] === '--version';

describe('Git Context Shell Free', () => {
  test('ON: shell-free spawnSync(git, argv[]) with zero shell-joined execSync git', () => {
    if (!GIT_PRECONDITION_OK) return; // env without git: contract unobservable
    const prev = process.env.KHY_GIT_SHELL_FREE;
    const calls = { spawnSyncGit: [], execSyncGit: [] };
    ACTIVE_CALLS = calls;
    _setGate('1');
    try {
      const ctx = svc.collectGitContext(REPO_ROOT, { force: true });
      expect(ctx.isGitRepo).toBe(true);
      expect(calls.spawnSyncGit.length).toBeGreaterThanOrEqual(4);
      expect(calls.execSyncGit.length).toBe(0);
      // Assert by presence, not call index: the detector probe may precede it.
      expect(
        calls.spawnSyncGit.some((a) => Array.isArray(a) && a[0] === 'rev-parse' && a[1] === '--show-toplevel')
      ).toBe(true);
    } finally {
      ACTIVE_CALLS = null;
      _setGate(prev);
    }
  });

  test('OFF: byte-reverts to shell execSync(git "cmd") with zero spawnSync git', () => {
    if (!GIT_PRECONDITION_OK) return; // env without git: contract unobservable
    const prev = process.env.KHY_GIT_SHELL_FREE;
    const calls = { spawnSyncGit: [], execSyncGit: [] };
    ACTIVE_CALLS = calls;
    _setGate('off');
    try {
      const ctx = svc.collectGitContext(REPO_ROOT, { force: true });
      expect(ctx.isGitRepo).toBe(true);
      expect(calls.spawnSyncGit.filter((a) => !_isDetectorProbe(a)).length).toBe(0);
      expect(calls.execSyncGit.length).toBeGreaterThanOrEqual(4);
      expect(calls.execSyncGit.some((c) => c.includes('rev-parse --show-toplevel'))).toBe(true);
    } finally {
      ACTIVE_CALLS = null;
      _setGate(prev);
    }
  });

  test('parity: ON and OFF yield identical context fields', () => {
    const prev = process.env.KHY_GIT_SHELL_FREE;
    const collect = (val) => {
      ACTIVE_CALLS = { spawnSyncGit: [], execSyncGit: [] };
      _setGate(val);
      try {
        return svc.collectGitContext(REPO_ROOT, { force: true });
      } finally {
        ACTIVE_CALLS = null;
      }
    };
    try {
      const on = collect('1');
      const off = collect('off');
      expect(on.isGitRepo).toBe(off.isGitRepo);
      expect(on.branch).toBe(off.branch);
      expect(on.mainBranch).toBe(off.mainBranch);
      expect(on.isDirty).toBe(off.isDirty);
    } finally {
      _setGate(prev);
    }
  });

  afterAll(() => {
    ACTIVE_CALLS = null;
    cp.spawnSync = _realSpawnSync;
    cp.execSync = _realExecSync;
  });
});
