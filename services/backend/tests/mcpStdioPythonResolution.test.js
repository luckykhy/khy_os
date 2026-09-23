'use strict';
/**
 * MCP stdio `python` resolution (new leaf `pythonCommandResolver`).
 *
 * The deepseek-eyes MCP server is configured with a bare `python` launcher, but
 * on a relocated/portable install the interpreter that actually has the
 * package installed lives in a venv under the install root (or VIRTUAL_ENV).
 * A stale absolute path baked in on a previous machine (e.g.
 * `C:\khy-os\tools\deepseek-eyes\.venv\Scripts\python.exe`) ENOENTs here.
 *
 * This pins the resolver contract so the spawn target FOLLOWS THE INSTALL and
 * a stale absolute path is flagged (fail-fast with an actionable hint) instead
 * of silently ENOENTing. Pure + injectable (fs/path-scan are passed in).
 *
 * TDD: the leaf does not exist yet — this suite is RED (module-not-found)
 * until F8 creates `src/services/domain/messaging/mcp/pythonCommandResolver.js`.
 */

const resolverPath = '../src/services/domain/messaging/mcp/pythonCommandResolver';
let resolveStdioCommand;

beforeAll(() => {
  resolveStdioCommand = require(resolverPath).resolveStdioCommand;
});

function makeCtx({ exists = [], pathScanResult = null, env = {}, venvCandidates = [] } = {}) {
  const existsSet = new Set(exists);
  return {
    platform: 'win32',
    env,
    venvCandidates,
    fsExists: (p) => existsSet.has(p),
    pathScan: (name) => (name === 'python' ? pathScanResult : null),
  };
}

describe('MCP stdio python command resolution', () => {
  test('bare python + VIRTUAL_ENV resolves to the venv interpreter', () => {
    const venvPy = 'D:\\Portable\\venv\\Scripts\\python.exe';
    const r = resolveStdioCommand('python', makeCtx({
      exists: [venvPy],
      env: { VIRTUAL_ENV: 'D:\\Portable\\venv' },
    }));
    expect(r.command).toBe(venvPy);
    expect(r.source).toBe('virtualenv');
    expect(r.exists).toBe(true);
    expect(r.portable).toBe(true);
  });

  test('bare python + PYTHON_PATH env wins over scanning', () => {
    const r = resolveStdioCommand('python3', makeCtx({
      exists: ['/opt/py/bin/python3'],
      env: { PYTHON_PATH: '/opt/py/bin/python3' },
    }));
    // PYTHON_PATH is used verbatim regardless of platform.
    expect(r.source).toBe('python_path');
    expect(r.command).toBe('/opt/py/bin/python3');
    expect(r.exists).toBe(true);
  });

  test('bare python falls back to an install-root venv candidate when present', () => {
    const cand = 'D:\\Portable\\khy-os\\tools\\deepseek-eyes\\.venv\\Scripts\\python.exe';
    const r = resolveStdioCommand('python', makeCtx({
      exists: [cand],
      venvCandidates: [cand, 'D:\\other\\.venv\\Scripts\\python.exe'],
    }));
    expect(r.command).toBe(cand);
    expect(r.source).toBe('venv_candidate');
    expect(r.exists).toBe(true);
    expect(r.portable).toBe(true);
  });

  test('bare python with nothing local falls back to PATH scan', () => {
    const r = resolveStdioCommand('python', makeCtx({
      pathScanResult: 'C:\\Python312\\python.exe',
      exists: ['C:\\Python312\\python.exe'],
    }));
    expect(r.source).toBe('path_scan');
    expect(r.command).toBe('C:\\Python312\\python.exe');
    expect(r.exists).toBe(true);
  });

  test('a stale absolute path that does not exist is flagged stale (fail-fast hint)', () => {
    const r = resolveStdioCommand('C:\\khy-os\\tools\\deepseek-eyes\\.venv\\Scripts\\python.exe', makeCtx({
      exists: [],
    }));
    expect(r.source).toBe('as_configured');
    expect(r.exists).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.portable).toBe(false);
  });

  test('an absolute path that exists is used as-configured', () => {
    const p = 'D:\\Portable\\Python\\python.exe';
    const r = resolveStdioCommand(p, makeCtx({ exists: [p] }));
    expect(r.source).toBe('as_configured');
    expect(r.exists).toBe(true);
    expect(r.stale).toBe(false);
  });
});
