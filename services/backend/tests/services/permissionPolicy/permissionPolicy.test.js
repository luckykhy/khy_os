'use strict';

/**
 * Unit tests for the fine-grained permission policy middleware
 * (services/permissionPolicy). Covers:
 *   - strict no-op when no policy file exists (existing behavior preserved);
 *   - auto-mode whitelist in/out → allow/deny;
 *   - confirm / deny strategies and per-tool overrides;
 *   - sensitive-operation forced二次确认;
 *   - code-execution language gate + resource-limit surfacing;
 *   - glob path & URL matching edge cases.
 *
 * The policy file path is resolved via utils/dataHome, which honors
 * KHY_DATA_HOME; each test points it at a throwaway temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const POLICY_MOD = '../../../src/services/permissionPolicy';
const MATCHERS_MOD = '../../../src/services/permissionPolicy/matchers';

function freshModules() {
  // The config caches nothing across calls (it reads disk each time), but the
  // dataHome resolver may; clear the require cache to be safe between dirs.
  jest.resetModules();
  return require(POLICY_MOD);
}

describe('permissionPolicy', () => {
  let tmp;
  const savedDataHome = process.env.KHY_DATA_HOME;
  const savedSwitch = process.env.KHY_PERMISSION_POLICY;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-'));
    process.env.KHY_DATA_HOME = tmp;
    delete process.env.KHY_PERMISSION_POLICY;
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (savedDataHome === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = savedDataHome;
    if (savedSwitch === undefined) delete process.env.KHY_PERMISSION_POLICY;
    else process.env.KHY_PERMISSION_POLICY = savedSwitch;
  });

  function writePolicy(policy) {
    fs.writeFileSync(path.join(tmp, 'permissions.json'), JSON.stringify(policy), 'utf8');
  }

  test('no policy file ⇒ evaluate() returns null (strict no-op)', () => {
    const policy = freshModules();
    expect(policy.evaluate('Write', { file_path: '/etc/hosts' })).toBeNull();
    expect(policy.summarize().exists).toBe(false);
  });

  test('kill switch KHY_PERMISSION_POLICY=off ⇒ null even with a file', () => {
    writePolicy({ defaultPolicy: 'deny' });
    process.env.KHY_PERMISSION_POLICY = 'off';
    const policy = freshModules();
    expect(policy.evaluate('Write', { file_path: '/x' })).toBeNull();
  });

  test('default deny blocks everything', () => {
    writePolicy({ defaultPolicy: 'deny' });
    const policy = freshModules();
    const v = policy.evaluate('Read', { file_path: '/tmp/a' });
    expect(v.decision).toBe('deny');
  });

  test('auto mode: in-whitelist path allows, out-of-whitelist path denies', () => {
    writePolicy({
      defaultPolicy: 'auto',
      filesystem: { pathWhitelist: ['/work/**'] },
    });
    const policy = freshModules();
    expect(policy.evaluate('Write', { file_path: '/work/src/a.js' }, { category: 'filesystem' }).decision).toBe('auto');
    expect(policy.evaluate('Write', { file_path: '/etc/passwd' }, { category: 'filesystem' }).decision).toBe('deny');
  });

  test('auto mode with no whitelist imposes no restriction (allow)', () => {
    writePolicy({ defaultPolicy: 'auto' });
    const policy = freshModules();
    expect(policy.evaluate('Read', { file_path: '/anywhere' }).decision).toBe('auto');
  });

  test('confirm mode prompts regardless of whitelist membership', () => {
    writePolicy({
      defaultPolicy: 'confirm',
      filesystem: { pathWhitelist: ['/work/**'] },
    });
    const policy = freshModules();
    expect(policy.evaluate('Write', { file_path: '/work/a' }).decision).toBe('confirm');
  });

  test('per-tool override beats the default policy', () => {
    writePolicy({ defaultPolicy: 'auto', tools: { shellCommand: 'confirm' } });
    const policy = freshModules();
    expect(policy.evaluate('shellCommand', { command: 'ls' }).decision).toBe('confirm');
    // a different tool still follows the default
    expect(policy.evaluate('Read', { file_path: '/x' }).decision).toBe('auto');
  });

  test('sensitive operation forces confirm even under auto', () => {
    writePolicy({
      defaultPolicy: 'auto',
      sensitiveOperations: { requireConfirm: ['git push', 'rm -rf'] },
    });
    const policy = freshModules();
    const v = policy.evaluate('shellCommand', { command: 'git push origin main' });
    expect(v.decision).toBe('confirm');
    expect(v.matched).toBe('sensitiveOperations');
  });

  test('explicit deny outranks a sensitive-op confirm', () => {
    writePolicy({
      defaultPolicy: 'deny',
      sensitiveOperations: { requireConfirm: ['git push'] },
    });
    const policy = freshModules();
    expect(policy.evaluate('shellCommand', { command: 'git push' }).decision).toBe('deny');
  });

  test('code-exec language gate denies a disallowed language', () => {
    writePolicy({
      defaultPolicy: 'auto',
      codeExecution: { allowedLanguages: ['javascript', 'python'] },
    });
    const policy = freshModules();
    expect(policy.evaluate('executeCode', { language: 'ruby', code: 'x' }).decision).toBe('deny');
    expect(policy.evaluate('executeCode', { language: 'python', code: 'x' }).decision).toBe('auto');
  });

  test('getCodeExecutionLimits surfaces configured caps; zeros when absent', () => {
    const empty = freshModules();
    expect(empty.getCodeExecutionLimits()).toEqual({ cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 });

    writePolicy({ codeExecution: { limits: { cpuSeconds: 2, memoryMb: 256, timeoutMs: 3000 } } });
    const policy = freshModules();
    expect(policy.getCodeExecutionLimits()).toEqual({ cpuSeconds: 2, memoryMb: 256, timeoutMs: 3000 });
  });

  test('network auto mode: domain whitelist gates by hostname', () => {
    writePolicy({
      defaultPolicy: 'auto',
      network: { urlWhitelist: ['*.github.com'] },
    });
    const policy = freshModules();
    expect(policy.evaluate('WebFetch', { url: 'https://api.github.com/repos' }).decision).toBe('auto');
    expect(policy.evaluate('WebFetch', { url: 'https://evil.example.com' }).decision).toBe('deny');
  });

  test('admin helpers scaffold and mutate the policy file', () => {
    const policy = freshModules();
    expect(policy.summarize().exists).toBe(false);
    expect(policy.setDefaultStrategy('auto').success).toBe(true);
    expect(policy.addPathRule('/work/**', 'write').success).toBe(true);
    expect(policy.setToolStrategy('shellCommand', 'deny').success).toBe(true);
    expect(policy.setDefaultStrategy('bogus').success).toBe(false);

    const s = policy.summarize();
    expect(s.exists).toBe(true);
    expect(s.policy.defaultPolicy).toBe('auto');
    expect(s.policy.tools.shellCommand).toBe('deny');
    expect(s.policy.filesystem.writeWhitelist).toContain('/work/**');
  });

  test('malformed policy file degrades to null (fail-closed read)', () => {
    fs.writeFileSync(path.join(tmp, 'permissions.json'), '{ not json', 'utf8');
    const policy = freshModules();
    expect(policy.evaluate('Write', { file_path: '/x' })).toBeNull();
  });
});

describe('permissionPolicy/matchers', () => {
  const matchers = require(MATCHERS_MOD);

  test('globToRegExp: * within segment, ** across separators, ? single char', () => {
    expect(matchers.globToRegExp('/a/*.js').test('/a/b.js')).toBe(true);
    expect(matchers.globToRegExp('/a/*.js').test('/a/b/c.js')).toBe(false);
    expect(matchers.globToRegExp('/a/**').test('/a/b/c.js')).toBe(true);
    expect(matchers.globToRegExp('/a/?.js').test('/a/x.js')).toBe(true);
    expect(matchers.globToRegExp('/a/?.js').test('/a/xy.js')).toBe(false);
  });

  test('matchPath: ** covers nested, empty patterns ⇒ false', () => {
    expect(matchers.matchPath('/work/src/deep/a.js', ['/work/**'])).toBe(true);
    expect(matchers.matchPath('/work/a.js', [])).toBe(false);
    expect(matchers.matchPath('/other/a.js', ['/work/**'])).toBe(false);
  });

  test('matchUrl: *.x.com also covers the bare apex x.com', () => {
    expect(matchers.matchUrl('https://x.com/a', ['*.x.com'])).toBe(true);
    expect(matchers.matchUrl('https://sub.x.com/a', ['*.x.com'])).toBe(true);
    expect(matchers.matchUrl('https://y.com', ['*.x.com'])).toBe(false);
  });

  test('detectCategory classifies canonical and legacy tool names', () => {
    expect(matchers.detectCategory('Read', { file_path: '/a' })).toBe('fileRead');
    expect(matchers.detectCategory('writeFile', { path: '/a' })).toBe('fileWrite');
    expect(matchers.detectCategory('shellCommand', { command: 'ls' })).toBe('shell');
    expect(matchers.detectCategory('WebFetch', { url: 'https://a' })).toBe('network');
    expect(matchers.detectCategory('executeCode', { language: 'js', code: 'x' })).toBe('codeExec');
  });

  test('isSensitiveOperation matches case-insensitively on command text', () => {
    expect(matchers.isSensitiveOperation('shellCommand', { command: 'GIT PUSH origin' }, ['git push'])).toBe(true);
    expect(matchers.isSensitiveOperation('shellCommand', { command: 'git status' }, ['git push'])).toBe(false);
    expect(matchers.isSensitiveOperation('x', {}, [])).toBe(false);
  });
});
