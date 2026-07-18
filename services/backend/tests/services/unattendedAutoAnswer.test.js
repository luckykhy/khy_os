'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ua = require('../../src/services/unattendedAutoAnswer');

test('isEnabled: default OFF (absent/empty/other → false)', () => {
  assert.strictEqual(ua.isEnabled({}), false);
  assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: '' }), false);
  assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: '0' }), false);
  assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'off' }), false);
  assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'no' }), false);
  assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'maybe' }), false);
});

test('isEnabled: explicit truthy values → true (case/space-insensitive)', () => {
  for (const v of ['1', 'true', 'on', 'yes', ' YES ', 'True', 'ON']) {
    assert.strictEqual(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: v }), true, `value=${v}`);
  }
});

test('selectAutoAnswers: gate OFF → empty regardless of questions', () => {
  const r = ua.selectAutoAnswers([{ question: 'Q', options: ['A', 'B'] }], {});
  assert.deepStrictEqual(r, { answers: {}, picks: [] });
});

test('selectAutoAnswers: picks recommended option (index 0 after promote)', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const r = ua.selectAutoAnswers([
    { question: 'Deploy target?', options: ['staging', 'prod (recommended)'] },
  ], env);
  // recommended is promoted to index 0 → chosen
  assert.strictEqual(r.answers['Deploy target?'], 'prod (recommended)');
  assert.strictEqual(r.picks.length, 1);
  assert.strictEqual(r.picks[0].recommended, true);
});

test('selectAutoAnswers: no recommended marker → falls to first option, recommended=false', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const r = ua.selectAutoAnswers([
    { question: 'Pick one', options: ['alpha', 'beta'] },
  ], env);
  assert.strictEqual(r.answers['Pick one'], 'alpha');
  assert.strictEqual(r.picks[0].recommended, false);
});

test('selectAutoAnswers: object options ({label}) resolved', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const r = ua.selectAutoAnswers([
    { question: 'DB?', options: [{ label: 'pg' }, { label: 'mysql' }] },
  ], env);
  assert.strictEqual(r.answers['DB?'], 'pg');
});

test('selectAutoAnswers: multiple questions all answered', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const r = ua.selectAutoAnswers([
    { question: 'Q1', options: ['a', 'b (推荐)'] },
    { question: 'Q2', options: ['x', 'y'] },
  ], env);
  assert.strictEqual(r.answers['Q1'], 'b (推荐)');
  assert.strictEqual(r.answers['Q2'], 'x');
  assert.strictEqual(Object.keys(r.answers).length, 2);
});

test('selectAutoAnswers: never throws on junk input (fail-soft to empty)', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  assert.deepStrictEqual(ua.selectAutoAnswers(null, env), { answers: {}, picks: [] });
  assert.deepStrictEqual(ua.selectAutoAnswers(undefined, env), { answers: {}, picks: [] });
  assert.deepStrictEqual(ua.selectAutoAnswers('nope', env), { answers: {}, picks: [] });
  // questions with no usable options are skipped, not thrown on
  const r = ua.selectAutoAnswers([{}, { question: 'x', options: [] }, { question: '', options: ['a'] }], env);
  assert.deepStrictEqual(r, { answers: {}, picks: [] });
});

test('selectAutoAnswers: empty-label option skipped, valid ones still answered', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const r = ua.selectAutoAnswers([
    { question: 'ok', options: ['first'] },
    { question: 'bad', options: [{ nope: 1 }] },
  ], env);
  assert.strictEqual(r.answers['ok'], 'first');
  assert.ok(!('bad' in r.answers));
});

test('buildAutoAnswerNote: renders picks, empty on empty/junk', () => {
  assert.strictEqual(ua.buildAutoAnswerNote([]), '');
  assert.strictEqual(ua.buildAutoAnswerNote(null), '');
  const note = ua.buildAutoAnswerNote([{ question: 'Q', answer: 'A', recommended: true }]);
  assert.match(note, /无人值守/);
  assert.match(note, /「Q」→ A\(推荐\)/);
});

test('selectAutoAnswers: no intentContext → byte-identical baseline (index 0)', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  const r = ua.selectAutoAnswers(q, env); // no 3rd arg
  assert.strictEqual(r.answers['DB?'], 'sqlite');
  assert.strictEqual(r.picks[0].realigned, false);
});

test('selectAutoAnswers: intentContext realigns blind index-0 toward the original intent', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  const ctx = { goalText: 'migrate the service to postgres', intentAnchors: [], originalMessage: '' };
  const r = ua.selectAutoAnswers(q, env, ctx);
  assert.strictEqual(r.answers['DB?'], 'postgres', 'should realign to the intent-aligned option');
  assert.strictEqual(r.picks[0].realigned, true);
  assert.strictEqual(r.picks[0].reason, 'intent-aligned');
});

test('selectAutoAnswers: intentContext but intent-guard OFF → byte-identical baseline', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1', KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: 'off' };
  const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  const ctx = { goalText: 'migrate the service to postgres' };
  const r = ua.selectAutoAnswers(q, env, ctx);
  assert.strictEqual(r.answers['DB?'], 'sqlite', 'guard off → no realign');
  assert.strictEqual(r.picks[0].realigned, false);
});

test('selectAutoAnswers: no intent signal → keeps baseline even with ctx', () => {
  const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
  const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  const ctx = { originalMessage: 'make it fast and reliable' };
  const r = ua.selectAutoAnswers(q, env, ctx);
  assert.strictEqual(r.answers['DB?'], 'sqlite');
  assert.strictEqual(r.picks[0].realigned, false);
});

test('buildAutoAnswerNote: realigned pick shows the calibration tag', () => {
  const note = ua.buildAutoAnswerNote([{ question: 'DB?', answer: 'postgres', recommended: false, realigned: true }]);
  assert.match(note, /已按你的目标校准/);
});
