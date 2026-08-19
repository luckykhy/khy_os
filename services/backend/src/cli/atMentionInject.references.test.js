'use strict';

/**
 * atMentionInject.references.test.js — integration tests for the References
 * half of atMentionInject via jest.mock: `@alias` mentions inject content from
 * the reference root, and absolute-path mentions refused by the boundary are
 * NOT inlined (was: silent inline, a permission bypass).
 *
 * referencesService is mocked so the boundary decision is fully deterministic
 * regardless of host platform path semantics (Windows drive-letter mentions
 * like `@D:\…` never match the `@[\w./-]+` token regex anyway — a pre-existing
 * platform quirk, not part of this feature).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../services/referencesService', () => {
  const actual = jest.requireActual('../services/referencesService');
  return {
    ...actual,
    resolveMentionAbs: jest.fn(),
    isWithinBoundary: jest.fn(),
  };
});

const svc = require('../services/referencesService');

const { resolveAtMentions } = require('./atMentionInject');

describe('atMentionInject + references', () => {
  let tmp;
  let cwd;
  let docs;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atrefs-test-'));
    cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    docs = path.join(tmp, 'docs');
    fs.mkdirSync(path.join(docs, 'api'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'README.md'), 'DOCS README CONTENT', 'utf-8');
    fs.writeFileSync(path.join(docs, 'api', 'guide.md'), 'API GUIDE CONTENT', 'utf-8');
    svc.resolveMentionAbs.mockClear();
    svc.isWithinBoundary.mockClear();
    svc.resolveMentionAbs.mockReturnValue(null); // default: no reference hit
    svc.isWithinBoundary.mockReturnValue(true); // default: boundary passes
  });
  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('injects content from a reference root via @alias/sub/path', () => {
    svc.resolveMentionAbs.mockReturnValue(path.join(docs, 'README.md'));
    const out = resolveAtMentions('read @docs/README.md please', { cwd });
    expect(out.changed).toBe(true);
    expect(out.text).toContain('DOCS README CONTENT');
    expect(out.reads).toHaveLength(1);
    expect(out.reads[0].kind).toBe('file');
  });

  it('injects a directory tree from @alias root', () => {
    svc.resolveMentionAbs.mockReturnValue(docs);
    const out = resolveAtMentions('list @docs', { cwd });
    expect(out.changed).toBe(true);
    expect(out.text).toContain('[Directory: docs]');
  });

  it('resolves @alias/sub further down the reference tree', () => {
    svc.resolveMentionAbs.mockReturnValue(path.join(docs, 'api', 'guide.md'));
    const out = resolveAtMentions('see @docs/api/guide.md', { cwd });
    expect(out.changed).toBe(true);
    expect(out.text).toContain('API GUIDE CONTENT');
  });

  it('does NOT inline an absolute path the boundary refused', () => {
    // resolveMentionAbs returns null (no alias) → falls to absolute-path branch
    svc.resolveMentionAbs.mockReturnValue(null);
    svc.isWithinBoundary.mockReturnValue(false); // outside boundary
    // mention 的 token 正则是 `@[\w./-]+`，抓不到盘符路径（`:` 与 `\` 都不在字符类里）。
    // 直接用 path.join(tmp, …) 拼出的 `C:\…` 在 Windows 上会被截成 `@/C` —— 一个不
    // 存在的路径，于是「当然不会注入」，用例变成空转。这正是它长期本机绿、Linux 门禁
    // 红的原因：真正的绕过（边界拒绝后落进 legacy 兜底、把绝对路径原样读出来）在
    // Windows 上被这个截断掩盖了。所以剥掉盘符前缀，用「当前盘的绝对 POSIX 路径」，
    // 两个平台都真正走绝对路径分支。（tmpdir 与 cwd 不同盘时解析不到文件 → 断言仍成立，
    // 只是退回空转，不会误红。）
    const outside = path.join(tmp, 'unrelated', 'secret.txt');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'SECRET CONTENT', 'utf-8');
    const driveRelative = outside.slice(path.parse(outside).root.length);
    const mentionPath = '/' + driveRelative.split(path.sep).join('/');
    const out = resolveAtMentions(`show @${mentionPath}`, { cwd });
    // Path refused → treated as unresolvable mention → no injection.
    expect(out.changed).toBe(false);
    expect(out.text).not.toContain('SECRET CONTENT');
    expect(svc.isWithinBoundary).toHaveBeenCalled();
  });

  it('still inlines relative paths inside cwd without any reference', () => {
    fs.writeFileSync(path.join(cwd, 'plain.md'), 'PLAIN CONTENT', 'utf-8');
    const out = resolveAtMentions('see @plain.md', { cwd });
    expect(out.changed).toBe(true);
    expect(out.text).toContain('PLAIN CONTENT');
  });

  it('keeps blocking sensitive files even through a reference', () => {
    // A reference that resolves to a sensitive file must still be blocked.
    svc.resolveMentionAbs.mockReturnValue(path.join(tmp, '.env'));
    const out = resolveAtMentions('see @cfg/.env', { cwd });
    expect(out.changed).toBe(false);
    expect(out.blocked).toContain('.env');
  });
});
