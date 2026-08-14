'use strict';

/**
 * Tests for the resumable / continueHint propagation chain:
 *   errorCodes (single source) → classifier._buildAttribution → streamInjector._inject.
 *
 * Requirement (Task B): a prematurely-ended reply must (a) carry a precise reason,
 * (b) tell the user it can be continued. E02 (safety) / E07 (permission) must NEVER
 * be marked resumable.
 */

const { ERROR_CODES } = require('../../../src/services/failsafe/errorCodes');
const failsafe = require('../../../src/services/failsafe');
const { StreamFailSafeInjector } = require('../../../src/services/failsafe/streamInjector');

describe('errorCodes — resumable single source', () => {
  test('every code declares a boolean resumable field', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(typeof ERROR_CODES[code].resumable).toBe('boolean');
    }
  });

  test('resumable codes are exactly E01 / E06 / E08', () => {
    const resumable = Object.keys(ERROR_CODES).filter((c) => ERROR_CODES[c].resumable);
    expect(resumable.sort()).toEqual(['E01', 'E06', 'E08']);
  });

  test('safety (E02) and permission (E07) are never resumable', () => {
    expect(ERROR_CODES.E02.resumable).toBe(false);
    expect(ERROR_CODES.E07.resumable).toBe(false);
  });

  test('resumable codes carry a non-empty continueHint; non-resumable carry null', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      const def = ERROR_CODES[code];
      if (def.resumable) {
        expect(typeof def.continueHint).toBe('string');
        expect(def.continueHint.length).toBeGreaterThan(0);
      } else {
        expect(def.continueHint).toBeNull();
      }
    }
  });
});

describe('classifier — propagates resumable / continueHint into attribution', () => {
  test('empty reply (E01) is resumable with a hint', () => {
    const attr = failsafe.classify(
      { errorType: 'empty_reply', model: 'm' },
      { kind: 'llm', model: 'm' },
    );
    expect(attr.error_code).toBe('E01');
    expect(attr.resumable).toBe(true);
    expect(typeof attr.continueHint).toBe('string');
    expect(attr.continueHint.length).toBeGreaterThan(0);
  });

  test('content-filter (E02) is non-resumable with null hint, and stays sensitive', () => {
    const attr = failsafe.classify(
      { errorType: 'content_filter', model: 'm', finish_reason: 'content_filter' },
      { kind: 'llm', model: 'm' },
    );
    expect(attr.error_code).toBe('E02');
    expect(attr.resumable).toBe(false);
    expect(attr.continueHint).toBeNull();
    expect(attr.sensitive).toBe(true);
  });
});

describe('streamInjector — emits resumable / continueHint on the error event', () => {
  function captureInject(failureInput) {
    const sent = [];
    const inj = new StreamFailSafeInjector({
      send: (e) => sent.push(e),
      res: { end() {} },
      context: { requestId: 'req-test' },
      track: false,
    });
    inj.fail(failureInput);
    inj.finalize();
    return sent.find((e) => e && e.type === 'error');
  }

  test('resumable failure (E06 network breaker) surfaces resumable=true + continueHint', () => {
    const ev = captureInject({ error_code: 'E06' });
    expect(ev).toBeTruthy();
    expect(ev.error_code).toBe('E06');
    expect(ev.resumable).toBe(true);
    expect(typeof ev.continueHint).toBe('string');
    expect(ev.continueHint.length).toBeGreaterThan(0);
  });

  test('safety failure surfaces resumable=false + null continueHint and does not leak detail', () => {
    const ev = captureInject({ errorType: 'content_filter', finish_reason: 'content_filter' });
    expect(ev).toBeTruthy();
    expect(ev.resumable).toBe(false);
    expect(ev.continueHint).toBeNull();
    expect(ev.sensitive).toBe(true);
  });
});
