'use strict';

/**
 * errorClassifier.authIdeStability.test.js — P0 of the IDE-channel stability fix.
 *
 * Live failure: Kiro returned "User is not authorized to make this call" but the
 * classifier did not map it to `auth`, so the cascade neither applied a fast-fail
 * cooldown NOR rotated the account — it re-selected the dead adapter and burned
 * the retry budget to "(5/4)" with no output.
 *
 * These cases lock in the expanded auth patterns: the not-authorized / token-expired
 * / AWS exception phrasings must classify as `auth` (→ rotation + cooldown), while a
 * genuine relay/model 404 must still classify as `model_not_found`, not auth.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectErrorKind,
  detectErrorKindDeep,
  classifyError,
} = require('../src/services/errorClassifier');

describe('errorClassifier — IDE auth phrasings classify as auth (P0)', () => {
  const authPhrases = [
    'User is not authorized to make this call',
    'not_authorized',
    'Your session token expired, please re-authenticate',
    'AccessDeniedException: not allowed',
    'ForbiddenException',
    'ExpiredTokenException: The security token included in the request is expired',
    'invalid_token',
    'invalid token provided',
  ];

  for (const phrase of authPhrases) {
    test(`"${phrase}" → auth`, () => {
      assert.equal(detectErrorKind({ message: phrase }), 'auth');
    });
  }

  test('Kiro live message classifies as auth through the deep cause chain', () => {
    const err = { message: 'request failed', cause: { message: 'User is not authorized to make this call' } };
    assert.equal(detectErrorKindDeep(err), 'auth');
  });

  test('auth → shouldRotateCredential is set (cascade will rotate the account)', () => {
    const c = classifyError(403, 'User is not authorized to make this call');
    assert.equal(c.kind, 'auth');
    assert.equal(c.shouldRotateCredential, true);
  });

  test('genuine model 404 still classifies as model_not_found, not auth', () => {
    assert.equal(detectErrorKind({ message: 'The model gpt-x does not exist', code: 404 }), 'model_not_found');
  });

  test('permission-denied phrasing is NOT swallowed by auth', () => {
    // Guard against collision: filesystem permission stays `permission`.
    assert.equal(detectErrorKind({ message: 'permission denied: /etc/shadow' }), 'permission');
  });
});
