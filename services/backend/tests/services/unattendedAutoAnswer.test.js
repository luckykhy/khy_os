'use strict';
const ua = require('../../src/services/unattendedAutoAnswer');

describe('Unattended Auto Answer', () => {
  test('isEnabled: default OFF (absent/empty/other �?false)', () => {
      expect(ua.isEnabled({})).toBe(false);
      expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: '' })).toBe(false);
      expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: '0' })).toBe(false);
      expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'off' })).toBe(false);
      expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'no' })).toBe(false);
      expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: 'maybe' })).toBe(false);
  });

  test('isEnabled: explicit truthy values �?true (case/space-insensitive)', () => {
      for (const v of ['1', 'true', 'on', 'yes', ' YES ', 'True', 'ON']) {
        expect(ua.isEnabled({ KHY_UNATTENDED_AUTOANSWER: v })).toBe(true, `value=${v}`);
      }
  });

  test('selectAutoAnswers: gate OFF �?empty regardless of questions', () => {
      const r = ua.selectAutoAnswers([{ question: 'Q', options: ['A', 'B'] }], {});
      expect(r).toEqual({ answers: {}, picks: [] });
  });

  test('selectAutoAnswers: picks recommended option (index 0 after promote)', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const r = ua.selectAutoAnswers([
        { question: 'Deploy target?', options: ['staging', 'prod (recommended)'] },
      ], env);
      // recommended is promoted to index 0 �?chosen
      expect(r.answers['Deploy target?']).toBe('prod (recommended)');
      expect(r.picks.length).toBe(1);
      expect(r.picks[0].recommended).toBe(true);
  });

  test('selectAutoAnswers: no recommended marker �?falls to first option, recommended=false', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const r = ua.selectAutoAnswers([
        { question: 'Pick one', options: ['alpha', 'beta'] },
      ], env);
      expect(r.answers['Pick one']).toBe('alpha');
      expect(r.picks[0].recommended).toBe(false);
  });

  test('selectAutoAnswers: object options ({label}) resolved', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const r = ua.selectAutoAnswers([
        { question: 'DB?', options: [{ label: 'pg' }, { label: 'mysql' }] },
      ], env);
      expect(r.answers['DB?']).toBe('pg');
  });

  test('selectAutoAnswers: multiple questions all answered', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const r = ua.selectAutoAnswers([
        { question: 'Q1', options: ['a', 'b (推荐)'] },
        { question: 'Q2', options: ['x', 'y'] },
      ], env);
      expect(r.answers['Q1']).toBe('b (推荐)');
      expect(r.answers['Q2']).toBe('x');
      expect(Object.keys(r.answers).length).toBe(2);
  });

  test('selectAutoAnswers: never throws on junk input (fail-soft to empty)', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      expect(ua.selectAutoAnswers(null).toEqual(env), { answers: {}, picks: [] });
      expect(ua.selectAutoAnswers(undefined).toEqual(env), { answers: {}, picks: [] });
      expect(ua.selectAutoAnswers('nope').toEqual(env), { answers: {}, picks: [] });
      // questions with no usable options are skipped, not thrown on
      const r = ua.selectAutoAnswers([{}, { question: 'x', options: [] }, { question: '', options: ['a'] }], env);
      expect(r).toEqual({ answers: {}, picks: [] });
  });

  test('selectAutoAnswers: empty-label option skipped, valid ones still answered', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const r = ua.selectAutoAnswers([
        { question: 'ok', options: ['first'] },
        { question: 'bad', options: [{ nope: 1 }] },
      ], env);
      expect(r.answers['ok']).toBe('first');
      expect(!('bad' in r.answers).toBeTruthy());
  });

  test('buildAutoAnswerNote: renders picks, empty on empty/junk', () => {
      expect(ua.buildAutoAnswerNote([])).toBe('');
      expect(ua.buildAutoAnswerNote(null)).toBe('');
      const note = ua.buildAutoAnswerNote([{ question: 'Q', answer: 'A', recommended: true }]);
      expect(note).toMatch(/无人值守/);
      expect(note).toMatch(/「Q」→ A\(推荐\)/);
  });

  test('selectAutoAnswers: no intentContext �?byte-identical baseline (index 0)', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
      const r = ua.selectAutoAnswers(q, env); // no 3rd arg
      expect(r.answers['DB?']).toBe('sqlite');
      expect(r.picks[0].realigned).toBe(false);
  });

  test('selectAutoAnswers: intentContext realigns blind index-0 toward the original intent', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
      const ctx = { goalText: 'migrate the service to postgres', intentAnchors: [], originalMessage: '' };
      const r = ua.selectAutoAnswers(q, env, ctx);
      expect(r.answers['DB?']).toBe('postgres', 'should realign to the intent-aligned option');
      expect(r.picks[0].realigned).toBe(true);
      expect(r.picks[0].reason).toBe('intent-aligned');
  });

  test('selectAutoAnswers: intentContext but intent-guard OFF �?byte-identical baseline', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1', KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: 'off' };
      const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
      const ctx = { goalText: 'migrate the service to postgres' };
      const r = ua.selectAutoAnswers(q, env, ctx);
      expect(r.answers['DB?']).toBe('sqlite', 'guard off �?no realign');
      expect(r.picks[0].realigned).toBe(false);
  });

  test('selectAutoAnswers: no intent signal �?keeps baseline even with ctx', () => {
      const env = { KHY_UNATTENDED_AUTOANSWER: '1' };
      const q = [{ question: 'DB?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
      const ctx = { originalMessage: 'make it fast and reliable' };
      const r = ua.selectAutoAnswers(q, env, ctx);
      expect(r.answers['DB?']).toBe('sqlite');
      expect(r.picks[0].realigned).toBe(false);
  });

  test('buildAutoAnswerNote: realigned pick shows the calibration tag', () => {
      const note = ua.buildAutoAnswerNote([{ question: 'DB?', answer: 'postgres', recommended: false, realigned: true }]);
      expect(note).toMatch(/已按你的目标校准/);
  });

});

