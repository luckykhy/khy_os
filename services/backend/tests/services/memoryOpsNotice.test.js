'use strict';

/**
 * Unit tests for memoryOpsNotice.js — the "写记忆 / 召回记忆 明确告知用户" renderer
 * (pure leaf). Uses node:test (run via `node --test`), never jest.
 *
 * Covers:
 *   - formatWriteNotice: disk-persist / in-session(ephemeral) / already-exists(skip)
 *     wording; silent on non-memory kind / non-success / missing name / malformed;
 *     type-label mapping incl. unknown-type fallback.
 *   - formatRecallNotice: Set/Array input, name cap + 「等 N 条」tail, .md stripping,
 *     silent on empty / non-iterable.
 *   - gate KHY_MEMORY_NOTICE: {0,false,off,no} ⇒ both return '' (byte-revert), and
 *     default-on / unrelated values ⇒ enabled.
 *   - never throws on adversarial input.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const NOTICE = require('../../src/services/memoryOpsNotice');

/** Run body with KHY_MEMORY_NOTICE forced to `val` (undefined ⇒ unset), then restore. */
function withGate(val, fn) {
  const prev = process.env.KHY_MEMORY_NOTICE;
  if (val === undefined) delete process.env.KHY_MEMORY_NOTICE;
  else process.env.KHY_MEMORY_NOTICE = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_NOTICE;
    else process.env.KHY_MEMORY_NOTICE = prev;
  }
}

// ── formatWriteNotice ───────────────────────────────────────────────────────

test('write: disk-persist ⇒ 已落盘 + type label + name', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'user-name', type: 'user', action: 'write' });
    assert.match(s, /已写入/);
    assert.match(s, /身份/);       // user → 身份
    assert.match(s, /已落盘/);
    assert.match(s, /user-name/);
  });
});

test('write: ephemeral ⇒ 本会话 (not 已落盘)', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'foo', type: 'project', ephemeral: true, action: 'write' });
    assert.match(s, /本会话/);
    assert.ok(!s.includes('已落盘'), 'ephemeral must not claim 已落盘');
    assert.match(s, /项目/);       // project → 项目
  });
});

test('write: skip / skip-duplicate ⇒ 已存在（未重复写入），never claims new write', () => {
  withGate(undefined, () => {
    for (const action of ['skip', 'skip-duplicate']) {
      const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'foo', type: 'feedback', action });
      assert.match(s, /已存在/);
      assert.ok(!s.includes('已写入'), `action=${action} must not claim 已写入`);
    }
  });
});

test('write: unknown type ⇒ generic 记忆 label (never throws)', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'x', type: 'zzz-unknown', action: 'write' });
    assert.match(s, /记忆/);
    assert.match(s, /x/);
  });
});

test('write: silent (empty) on instruction kind / non-success / missing name / malformed', () => {
  withGate(undefined, () => {
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'instruction', success: true, name: 'x' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: false, name: 'x' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: '   ', type: 'user' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice(null), '');
    assert.strictEqual(NOTICE.formatWriteNotice(true), '');       // bare boolean (legacy)
    assert.strictEqual(NOTICE.formatWriteNotice(undefined), '');
    assert.strictEqual(NOTICE.formatWriteNotice(42), '');
  });
});

// ── formatRecallNotice ──────────────────────────────────────────────────────

test('recall: Set input ⇒ count + names, .md stripped', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(new Set(['a.md', 'b.md']));
    assert.match(s, /召回 2 条/);
    assert.match(s, /a、b/);
    assert.ok(!s.includes('.md'), '.md extension must be stripped');
  });
});

test('recall: over cap ⇒ first N names + 「等 N 条」tail', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    assert.match(s, /召回 5 条/);
    assert.match(s, /等 5 条/);
    assert.ok(!s.includes('d'), 'names beyond the cap must not be listed individually');
  });
});

test('recall: silent (empty) on empty / non-iterable / all-blank', () => {
  withGate(undefined, () => {
    assert.strictEqual(NOTICE.formatRecallNotice([]), '');
    assert.strictEqual(NOTICE.formatRecallNotice(new Set()), '');
    assert.strictEqual(NOTICE.formatRecallNotice(null), '');
    assert.strictEqual(NOTICE.formatRecallNotice(42), '');
    assert.strictEqual(NOTICE.formatRecallNotice(['', '  ', '.md']), '');
  });
});

// ── gate KHY_MEMORY_NOTICE ──────────────────────────────────────────────────

test('gate: {0,false,off,no} ⇒ both return empty string (byte-revert to silent)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    withGate(off, () => {
      assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'x', type: 'user', action: 'write' }), '', `write gate ${off}`);
      assert.strictEqual(NOTICE.formatRecallNotice(['a.md']), '', `recall gate ${off}`);
      assert.strictEqual(NOTICE.isNoticeEnabled(), false, `isNoticeEnabled ${off}`);
    });
  }
});

test('gate: default-on (unset) and unrelated values ⇒ enabled', () => {
  withGate(undefined, () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
  withGate('1', () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
  withGate('yes', () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
});

test('never throws on adversarial input', () => {
  const bad = [null, undefined, 42, 'str', {}, [], { name: {} }, { kind: 'memory', success: true, name: 123 }];
  for (const b of bad) {
    assert.doesNotThrow(() => NOTICE.formatWriteNotice(b));
    assert.doesNotThrow(() => NOTICE.formatRecallNotice(b));
  }
});
