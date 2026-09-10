'use strict';

/**
 * passwordReset.enumeration.test.js — /api/password-reset/get-question cannot
 * be used to enumerate usernames.
 *
 * This endpoint is public (no authMiddleware), so its response shape is
 * observable by an anonymous attacker. Before the fix it answered 200 when the
 * account existed AND had a security question set, and 400 otherwise — a
 * clean oracle for mapping live accounts. It now returns the same 200 and the
 * same keys in every case, with `securityQuestion: null` when there is nothing
 * to reveal.
 *
 * The assertion that matters is the structural one at the end: the three
 * branches must produce indistinguishable envelopes. A status-code-only check
 * would still let the oracle back in through a differing message or key set.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models', () => ({
  User: { findOne: jest.fn() },
  sequelize: { getQueryInterface: () => ({ describeTable: jest.fn(async () => null) }) },
  QueryTypes: { SELECT: 'SELECT', UPDATE: 'UPDATE' },
}));

jest.mock('../../src/services/authSessionService', () => ({
  notePasswordChanged: jest.fn().mockResolvedValue(null),
  revokeUserSessions: jest.fn().mockResolvedValue(null),
  invalidateLegacyTokens: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/services/userLogService', () => ({
  logUserAction: jest.fn().mockResolvedValue(null),
}));

const app = express();
app.use(express.json());
app.use('/api/password-reset', require('../../src/routes/passwordReset'));

const { User } = require('../../src/models');

async function askQuestion(identifier) {
  return request(app).post('/api/password-reset/get-question').send(identifier);
}

describe('POST /api/password-reset/get-question — enumeration surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 for a non-existent account, not 400', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await askQuestion({ username: 'does-not-exist' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.securityQuestion).toBeNull();
    expect(res.body.data.username).toBeNull();
  });

  it('returns the same shape for an account without a security question', async () => {
    User.findOne.mockResolvedValue({ username: 'alice', securityQuestion: null });

    const res = await askQuestion({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.securityQuestion).toBeNull();
    expect(res.body.data.username).toBeNull();
  });

  it('returns the question when the account has one', async () => {
    User.findOne.mockResolvedValue({
      username: 'alice',
      securityQuestion: '你第一只宠物的名字？',
    });

    const res = await askQuestion({ username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.data.securityQuestion).toBe('你第一只宠物的名字？');
    expect(res.body.data.username).toBe('alice');
  });

  it('is public: no bearer token required', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await askQuestion({ username: 'alice' });

    expect(res.status).toBe(200);
  });

  it('still rejects a malformed request with no account identifier', async () => {
    const res = await askQuestion({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('produces indistinguishable envelopes across the three branches', async () => {
    const cases = [
      [null, { username: 'ghost' }],
      [{ username: 'alice', securityQuestion: null }, { username: 'alice' }],
      [{ username: 'alice', securityQuestion: 'q?' }, { username: 'alice' }],
    ];

    const shapes = [];
    for (const [user, body] of cases) {
      User.findOne.mockResolvedValue(user);
      const res = await askQuestion(body);
      shapes.push({
        status: res.status,
        success: res.body.success,
        dataKeys: Object.keys(res.body.data).sort(),
        metadataKeys: Object.keys(res.body.metadata || {}).sort(),
        hasError: Object.prototype.hasOwnProperty.call(res.body, 'error'),
      });
    }

    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0]).toEqual(shapes[2]);
    expect(shapes[0].status).toBe(200);
    expect(shapes[0].hasError).toBe(false);
  });
});
