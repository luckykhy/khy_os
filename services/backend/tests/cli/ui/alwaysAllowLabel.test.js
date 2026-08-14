'use strict';

/**
 * alwaysAllowLabel.test.js — 权限对话「始终允许」标签动词口径单一真源(node:test)。
 *
 * 对齐 CC 按工具族分流(FilePermissionDialog "all edits" / BashPermissionRequest 命令族);
 * 锁定:门控开 → 写/编辑/bash 改用真实动词,只读类保留 legacy "reading";
 * 门控关 → 原样返回 call-site 传入的 legacyLabel(逐字节回退)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAlwaysAllowLabelOr, isEnabled } = require('../../../src/cli/ui/alwaysAllowLabel');

const LEGACY = 'Yes, allow reading from {project} from this project';
const ON = {}; // 默认开
const OFF = { KHY_ALWAYS_ALLOW_LABEL: 'off' };

describe('isEnabled 门控梯', () => {
  test('无 env / 空 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled(), true);
    assert.equal(isEnabled({ KHY_ALWAYS_ALLOW_LABEL: '' }), true);
  });
  test('0/false/off/no(大小写/空白不敏感)→ 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(isEnabled({ KHY_ALWAYS_ALLOW_LABEL: v }), false, `值 ${JSON.stringify(v)}`);
    }
  });
  test('其它真值(1/true/on)→ 开', () => {
    assert.equal(isEnabled({ KHY_ALWAYS_ALLOW_LABEL: '1' }), true);
    assert.equal(isEnabled({ KHY_ALWAYS_ALLOW_LABEL: 'true' }), true);
  });
});

describe('buildAlwaysAllowLabelOr 门控开', () => {
  test('写/编辑族 → "all edits"(归一覆盖大小写/分隔符变体)', () => {
    const want = 'Yes, allow all edits in {project} from this project';
    for (const name of ['write', 'Write', 'write_file', 'writeFile', 'createFile',
                        'edit', 'editFile', 'edit_file', 'multiedit', 'MultiEdit',
                        'notebookEdit', 'scaffold', 'scaffold_files']) {
      assert.equal(buildAlwaysAllowLabelOr(name, LEGACY, ON), want, `工具 ${name}`);
    }
  });
  test('bash/命令族 → "running commands"(不臆造命令前缀)', () => {
    const want = 'Yes, allow running commands in {project} from this project';
    for (const name of ['bash', 'Bash', 'shell_command', 'shellCommand', 'command']) {
      assert.equal(buildAlwaysAllowLabelOr(name, LEGACY, ON), want, `工具 ${name}`);
    }
  });
  test('只读类工具 → 保留 legacy "reading"(本就成立,不动)', () => {
    for (const name of ['read', 'readFile', 'grep', 'glob', 'ls', 'webfetch', 'webFetch']) {
      assert.equal(buildAlwaysAllowLabelOr(name, LEGACY, ON), LEGACY, `工具 ${name}`);
    }
  });
});

describe('buildAlwaysAllowLabelOr 门控关', () => {
  test('写/编辑/bash 也恒返回 legacy(逐字节回退历史 "reading")', () => {
    for (const name of ['write', 'edit', 'bash', 'read']) {
      assert.equal(buildAlwaysAllowLabelOr(name, LEGACY, OFF), LEGACY, `工具 ${name}`);
    }
  });
  test('门控关时 legacy 原样透传(call-site 各自传入,绝不串味)', () => {
    const other = 'Yes, custom {project} label';
    assert.equal(buildAlwaysAllowLabelOr('write', other, OFF), other);
  });
});

describe('防呆 + 默认门控', () => {
  test('toolName 为 null/undefined/数字 → 归一为空,非写/bash → legacy', () => {
    assert.equal(buildAlwaysAllowLabelOr(null, LEGACY, ON), LEGACY);
    assert.equal(buildAlwaysAllowLabelOr(undefined, LEGACY, ON), LEGACY);
    assert.equal(buildAlwaysAllowLabelOr(123, LEGACY, ON), LEGACY);
  });
  test('默认门控(无 env)= 开:write → "all edits"', () => {
    const prev = process.env.KHY_ALWAYS_ALLOW_LABEL;
    delete process.env.KHY_ALWAYS_ALLOW_LABEL;
    try {
      assert.equal(
        buildAlwaysAllowLabelOr('write', LEGACY),
        'Yes, allow all edits in {project} from this project',
      );
    } finally {
      if (prev == null) delete process.env.KHY_ALWAYS_ALLOW_LABEL;
      else process.env.KHY_ALWAYS_ALLOW_LABEL = prev;
    }
  });
});
