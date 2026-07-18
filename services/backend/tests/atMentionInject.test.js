'use strict';

/**
 * atMentionInject.test.js — `@path` 文件/目录提及 → 内容注入(REPL + TUI 共用单一真源)回归。
 * (goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐,两处对齐」)
 *
 * 守护:
 *   1. 门控默认开:@file → 注入 `[File: …]` 内容块、剥掉 `@`、reads 记一笔。
 *   2. @dir → 注入 `[Directory: …]` 目录树(复用 _buildDirTree)。
 *   3. 敏感文件(.env / id_rsa / *.key)→ 拦截,绝不读入内容,blocked 记一笔。
 *   4. 门控关 → 逐字节回退(原文不动、无注入)。
 *   5. 不存在的 @ 提及(邮箱/handle)→ 安静跳过、原文不动。
 *   6. 畸形输入 / 无 @ → 不抛、原样返回。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAtMentions, isEnabled } = require('../src/cli/atMentionInject');

let dir = '';
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-at-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from note');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=topsecret');
  fs.writeFileSync(path.join(dir, 'server.key'), 'PRIVATE KEY MATERIAL');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a');
});

test('门控默认开:@file → 注入内容块 + 剥 @ + reads 记录', () => {
  const r = resolveAtMentions('看看 @note.txt 这个文件', { cwd: dir, env: {} });
  assert.ok(r.changed);
  assert.ok(r.text.includes('[File: note.txt]'));
  assert.ok(r.text.includes('hello from note'));
  assert.ok(!r.text.includes('@note.txt'), 'leading @ must be stripped');
  assert.strictEqual(r.reads.length, 1);
  assert.strictEqual(r.reads[0].kind, 'file');
});

test('@dir → 注入目录树', () => {
  const r = resolveAtMentions('结构 @sub', { cwd: dir, env: {} });
  assert.ok(r.changed);
  assert.ok(r.text.includes('[Directory: sub]'));
  assert.strictEqual(r.reads[0].kind, 'dir');
});

test('敏感文件被拦截:.env / *.key 绝不读入内容', () => {
  const r = resolveAtMentions('@.env 和 @server.key', { cwd: dir, env: {} });
  assert.strictEqual(r.changed, false);
  assert.ok(!r.text.includes('topsecret'), '.env content must never leak');
  assert.ok(!r.text.includes('PRIVATE KEY MATERIAL'), '.key content must never leak');
  assert.ok(r.blocked.length >= 2);
});

test('门控关:逐字节回退(原文不动、无注入)', () => {
  const msg = '看看 @note.txt 这个文件';
  const r = resolveAtMentions(msg, { cwd: dir, env: { KHY_AT_MENTION_INJECT: 'off' } });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, msg);
  assert.strictEqual(r.reads.length, 0);
});

test('不存在的 @ 提及(邮箱/handle)→ 安静跳过、原文不动', () => {
  const msg = 'ping @nobody/here and @someone';
  const r = resolveAtMentions(msg, { cwd: dir, env: {} });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, msg);
});

test('无 @ / 畸形输入 → 不抛、原样返回', () => {
  assert.strictEqual(resolveAtMentions('普通文本', { cwd: dir, env: {} }).text, '普通文本');
  assert.strictEqual(resolveAtMentions(undefined, { env: {} }).text, '');
  assert.strictEqual(resolveAtMentions(null, { env: {} }).text, '');
});

test('门控判定:仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(isEnabled({ KHY_AT_MENTION_INJECT: v }), false, `env=${v}`);
  }
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_AT_MENTION_INJECT: 'true' }), true);
});

// CC 后端口径对齐:@file 大小标注走 ccFormat SSOT(ccFormatFileSize)。note.txt = 15 字节,
// 旧本地口径塌成无意义的 "0.0KB",CC formatFileSize 给 "15 bytes"。
test('@file sizeInfo:门控开 → CC formatFileSize(15 字节小文件不塌成 0.0KB)', () => {
  const r = resolveAtMentions('看看 @note.txt', { cwd: dir, env: {} });
  assert.strictEqual(r.reads[0].sizeInfo, '15 bytes');
});

test('@file sizeInfo:KHY_CC_FORMAT 关 → 逐字节回退旧 toFixed(1)KB 口径', () => {
  const r = resolveAtMentions('看看 @note.txt', { cwd: dir, env: { KHY_CC_FORMAT: '0' } });
  assert.strictEqual(r.reads[0].sizeInfo, '0.0KB');
});
