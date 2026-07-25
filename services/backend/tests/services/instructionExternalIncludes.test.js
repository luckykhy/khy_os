'use strict';

// instructionExternalIncludes 契约测试 — 纯叶子(外部 @include 检测)。对齐 CC
// src/utils/claudemd.ts getExternalClaudeMdIncludes:标记解析到工作目录之外的
// @path 导入(第三方仓库安全隐患)。零 fs 读,path/os 纯解析。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const leaf = require('../../src/services/instructionExternalIncludes');

test('externalIncludeWarningEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.externalIncludeWarningEnabled({}), true);
  assert.strictEqual(leaf.externalIncludeWarningEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      leaf.externalIncludeWarningEnabled({ KHY_EXTERNAL_INCLUDE_WARNING: off }),
      false,
      `应关: ${off}`,
    );
  }
});

test('_isInside:路径边界(同路径/嵌套真·同前缀非嵌套假)', () => {
  assert.strictEqual(leaf._isInside('/foo/bar', '/foo/bar'), true, '同路径');
  assert.strictEqual(leaf._isInside('/foo/bar/baz', '/foo/bar'), true, '嵌套');
  assert.strictEqual(leaf._isInside('/foo/bar2', '/foo/bar'), false, '同前缀非嵌套');
  assert.strictEqual(leaf._isInside('/other', '/foo/bar'), false, '无关');
});

test('detectExternalIncludes:cwd 内的 include → 不标记', () => {
  const cwd = path.join(os.homedir(), 'proj');
  const content = '@sub/rules.md\n@./local.md';
  const r = leaf.detectExternalIncludes(content, cwd, cwd, {});
  assert.deepStrictEqual(r, [], 'cwd 内不算 external');
});

test('detectExternalIncludes:cwd 外但 home 内的 include → 标记(CC 的核心缺口)', () => {
  const cwd = path.join(os.homedir(), 'proj');
  // @../other-repo/khy.md 解析到 ~/other-repo(cwd 外·home 内)→ khy 会静默注入 → 应标记
  const content = '@../other-repo/khy.md';
  const r = leaf.detectExternalIncludes(content, cwd, cwd, {});
  assert.strictEqual(r.length, 1, '应标记一个 external');
  assert.strictEqual(r[0].path, '../other-repo/khy.md');
  assert.ok(r[0].resolved.startsWith(os.homedir()), 'resolved 在 home 内');
  assert.ok(!r[0].resolved.startsWith(cwd + path.sep), 'resolved 在 cwd 外');
});

test('detectExternalIncludes:home 外的 include → 不标记(khy 本就 deny,不静默注入)', () => {
  const cwd = path.join(os.homedir(), 'proj');
  // 解析到 /etc/passwd:既不在 baseDir 也不在 home → khy resolveIncludes 直接 deny
  // → 从不注入 → 无需警告(警告只针对被静默注入的那一类)
  const content = '@/etc/passwd';
  const r = leaf.detectExternalIncludes(content, cwd, cwd, {});
  assert.deepStrictEqual(r, [], 'home 外已被 deny,不在警告范围');
});

test('detectExternalIncludes:门控关 → []（逐字节 no-op 回退）', () => {
  const cwd = path.join(os.homedir(), 'proj');
  const content = '@../other-repo/khy.md';
  assert.deepStrictEqual(
    leaf.detectExternalIncludes(content, cwd, cwd, { KHY_EXTERNAL_INCLUDE_WARNING: '0' }),
    [],
  );
});

test('detectExternalIncludes:去重(同一 external 出现多次只报一次)', () => {
  const cwd = path.join(os.homedir(), 'proj');
  const content = '@../ext/a.md\n@../ext/a.md';
  const r = leaf.detectExternalIncludes(content, cwd, cwd, {});
  assert.strictEqual(r.length, 1, '去重');
});

test('detectExternalIncludes:坏输入/空内容 → [](fail-soft)', () => {
  assert.deepStrictEqual(leaf.detectExternalIncludes(undefined, '/x', '/x', {}), []);
  assert.deepStrictEqual(leaf.detectExternalIncludes('', '/x', '/x', {}), []);
  assert.deepStrictEqual(leaf.detectExternalIncludes(123, '/x', '/x', {}), []);
});

test('detectExternalIncludes:仅匹配独占一行的 @path(与 resolveIncludes 同口径)', () => {
  const cwd = path.join(os.homedir(), 'proj');
  // 行内的 email@host 或代码里的 @decorator 不应误匹配(正则要求行首 @ 且整行)
  const content = 'see foo@bar.com for details\nconst x = @decorator;\n';
  const r = leaf.detectExternalIncludes(content, cwd, cwd, {});
  assert.deepStrictEqual(r, [], '非独占行的 @ 不匹配');
});

test('buildExternalIncludeWarning:空/无 → ""(不追加·byte-identical)', () => {
  assert.strictEqual(leaf.buildExternalIncludeWarning('/x/khy.md', []), '');
  assert.strictEqual(leaf.buildExternalIncludeWarning('/x/khy.md', undefined), '');
});

test('buildExternalIncludeWarning:有 external → 含文件名+路径+第三方警示', () => {
  const line = leaf.buildExternalIncludeWarning('/x/khy.md', [{ path: '../ext/a.md' }, { path: '~/b.md' }]);
  assert.match(line, /\[SECURITY\]/);
  assert.match(line, /\/x\/khy\.md/);
  assert.match(line, /工作目录之外/);
  assert.match(line, /第三方仓库切勿允许/);
  assert.match(line, /\.\.\/ext\/a\.md/);
  assert.match(line, /~\/b\.md/);
});
