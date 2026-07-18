'use strict';

/**
 * Structured-result recovery — machine-readable channels over prose scraping.
 *
 * Covers:
 *   1. extractFirstJson — recovers a JSON value embedded in prose / fences /
 *      truncated output, so consumers read typed data instead of regex-scraping.
 *   2. verificationAgent.adversarialVerify — prefers a structured JSON verdict
 *      block, and still falls back to the legacy VERDICT/Result prose format.
 */

const { extractFirstJson } = require('../src/services/gateway/safeJsonParse');
const { adversarialVerify } = require('../src/services/verificationAgent');

describe('extractFirstJson', () => {
  test('recovers a JSON object wrapped in prose', () => {
    const txt = 'Sure, here is the result:\n{"verdict": "PASS", "n": 2} — done.';
    expect(extractFirstJson(txt, null)).toEqual({ verdict: 'PASS', n: 2 });
  });

  test('recovers a JSON array inside a ```json fence', () => {
    const txt = 'Output below.\n```json\n[{"title":"a"},{"title":"b"}]\n```\nThanks.';
    expect(extractFirstJson(txt, null)).toEqual([{ title: 'a' }, { title: 'b' }]);
  });

  test('ignores braces inside string literals', () => {
    const txt = 'x {"msg": "use { and } chars", "ok": true} y';
    expect(extractFirstJson(txt, null)).toEqual({ msg: 'use { and } chars', ok: true });
  });

  test('repairs a truncated object via bracket closing', () => {
    const txt = 'result: {"verdict": "FAIL", "checks": [';
    const out = extractFirstJson(txt, null);
    expect(out).not.toBeNull();
    expect(out.verdict).toBe('FAIL');
  });

  test('returns fallback when no JSON is present', () => {
    expect(extractFirstJson('just prose, no json here', 'FB')).toBe('FB');
    expect(extractFirstJson('', 'FB')).toBe('FB');
    expect(extractFirstJson(null, 'FB')).toBe('FB');
  });
});

describe('adversarialVerify — structured verdict channel', () => {
  const params = (executeAI) => ({
    files: ['a.js'],
    cwd: process.cwd(),
    taskDescription: 'noop',
    executeAI,
  });

  test('prefers the structured JSON verdict block', async () => {
    const r = await adversarialVerify(params(async () =>
      'I checked things.\n```json\n{"verdict":"FAIL","checks":[{"command":"node -c a.js","output":"SyntaxError","result":"FAIL"}]}\n```'
    ));
    expect(r.verdict).toBe('FAIL');
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ command: 'node -c a.js', result: 'FAIL' });
  });

  test('falls back to legacy VERDICT/Result prose when no JSON block', async () => {
    const r = await adversarialVerify(params(async () =>
      'Command run: node -c a.js\nResult: PASS\nVERDICT: PASS'
    ));
    expect(r.verdict).toBe('PASS');
    expect(r.checks.some(c => c.result === 'PASS')).toBe(true);
  });

  test('defaults to PARTIAL when neither channel yields a verdict', async () => {
    const r = await adversarialVerify(params(async () => 'I am unsure about everything.'));
    expect(r.verdict).toBe('PARTIAL');
  });
});
