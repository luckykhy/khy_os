'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LEAF = path.resolve(
  __dirname,
  '../../../src/cli/tui/chatChords.js',
);
const { isEnabled, resolveChatChord } = require(LEAF);

// Each call passes an explicit env so default-process.env never leaks in.
const ON = {};                       // gate unset → default-on
const OFF = { KHY_CHAT_CHORDS: '0' }; // gate off → byte-revert (null)

test('isEnabled: default-on; only explicit falsy disables', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_CHAT_CHORDS: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_CHAT_CHORDS: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_CHAT_CHORDS: v }), false, `should disable on ${JSON.stringify(v)}`);
  }
});

test('meta+letter → CC-aligned chat chords', () => {
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'p' }, ON), 'modelPicker');
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'o' }, ON), 'fastMode');
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 't' }, ON), 'thinkingToggle');
});

test('meta is case-insensitive on the letter', () => {
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'P' }, ON), 'modelPicker');
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'O' }, ON), 'fastMode');
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'T' }, ON), 'thinkingToggle');
});

test('ctrl+t → toggleTasks (CC app:toggleTodos)', () => {
  assert.strictEqual(resolveChatChord({ key: { ctrl: true }, input: 't' }, ON), 'toggleTasks');
  assert.strictEqual(resolveChatChord({ key: { ctrl: true }, input: 'T' }, ON), 'toggleTasks');
});

test('meta+other letters → null (only p/o/t are mapped)', () => {
  for (const ch of ['a', 'b', 'q', 'v', 'm', 'z']) {
    assert.strictEqual(resolveChatChord({ key: { meta: true }, input: ch }, ON), null, `meta+${ch}`);
  }
});

test('modifier discipline: ctrl+meta together is not a chord', () => {
  // meta branch requires !ctrl; ctrl branch requires !meta.
  assert.strictEqual(resolveChatChord({ key: { meta: true, ctrl: true }, input: 'p' }, ON), null);
  assert.strictEqual(resolveChatChord({ key: { meta: true, ctrl: true }, input: 't' }, ON), null);
});

test('ctrl+t requires pure ctrl (no meta/shift)', () => {
  assert.strictEqual(resolveChatChord({ key: { ctrl: true, shift: true }, input: 't' }, ON), null);
  assert.strictEqual(resolveChatChord({ key: { ctrl: true, meta: true }, input: 't' }, ON), null);
});

test('plain letters (no modifier) → null (never steals typed text)', () => {
  assert.strictEqual(resolveChatChord({ key: {}, input: 'p' }, ON), null);
  assert.strictEqual(resolveChatChord({ key: {}, input: 't' }, ON), null);
});

test('gate off → always null (byte-revert: keys fall through to textInput)', () => {
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'p' }, OFF), null);
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 'o' }, OFF), null);
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: 't' }, OFF), null);
  assert.strictEqual(resolveChatChord({ key: { ctrl: true }, input: 't' }, OFF), null);
});

test('defensive: missing/garbage args never throw, return null', () => {
  assert.strictEqual(resolveChatChord(undefined, ON), null);
  assert.strictEqual(resolveChatChord({}, ON), null);
  assert.strictEqual(resolveChatChord({ key: null, input: null }, ON), null);
  assert.strictEqual(resolveChatChord({ key: { meta: true }, input: '' }, ON), null);
  assert.strictEqual(resolveChatChord({ key: { meta: true } }, ON), null);
});
