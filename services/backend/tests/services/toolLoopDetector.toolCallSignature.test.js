'use strict';

/**
 * toolLoopDetector.toolCallSignature.test.js — the public signature helper that
 * the cross-turn repeat guard (「此路不通不换一条」fix) uses to recognize a call
 * already answered in a recent turn. It is a thin wrapper over the SAME private
 * hashCall/stableStringify the in-turn detector uses, so callers and the guard
 * agree byte-for-byte. These tests pin that contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { toolCallSignature } = require('../../src/services/toolLoopDetector');

describe('toolCallSignature (public stable signature)', () => {
  test('identical (name, params) → identical signature', () => {
    const a = toolCallSignature('bash', { command: 'dir "D:\\x\\Desktop" /s /b' });
    const b = toolCallSignature('bash', { command: 'dir "D:\\x\\Desktop" /s /b' });
    assert.equal(a, b);
    assert.ok(a && typeof a === 'string');
  });

  test('param key ORDER does not change the signature (stableStringify)', () => {
    const a = toolCallSignature('read', { file_path: '/a/foo.js', limit: 5 });
    const b = toolCallSignature('read', { limit: 5, file_path: '/a/foo.js' });
    assert.equal(a, b);
  });

  test('different tool OR different params → different signature', () => {
    const base = toolCallSignature('bash', { command: 'dir /s /b' });
    assert.notEqual(base, toolCallSignature('bash', { command: 'echo hi' }));
    assert.notEqual(base, toolCallSignature('shellCommand', { command: 'dir /s /b' }));
  });

  test('never throws on missing / garbage input', () => {
    assert.doesNotThrow(() => toolCallSignature(null, null));
    assert.doesNotThrow(() => toolCallSignature(undefined, undefined));
    assert.ok(typeof toolCallSignature('x', {}) === 'string');
  });
});
