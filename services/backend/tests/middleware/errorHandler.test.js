/**
 * Unit tests for errorHandler middleware.
 *
 * The error handler is a pure 4-param Express middleware that normalizes
 * exceptions into { success: false, message, requestId } JSON responses.
 * No database dependency.
 */

// Mock logger so winston file transports don't interfere
jest.mock('@khy/shared/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const errorHandler = require('../../src/middleware/errorHandler');

function createMockRes() {
  const res = {
    statusCode: 200,
    _body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function createMockReq(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/test',
    headers: {},
    user: null,
    ...overrides,
  };
}

describe('errorHandler middleware', () => {
  test('exports a function', () => {
    expect(typeof errorHandler).toBe('function');
  });

  test('function has arity of 4 (err, req, res, next)', () => {
    expect(errorHandler.length).toBe(4);
  });

  test('sets status from err.status', () => {
    const res = createMockRes();
    const err = new Error('Not Found');
    err.status = 404;
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  test('sets status from err.statusCode', () => {
    const res = createMockRes();
    const err = new Error('Bad Request');
    err.statusCode = 400;
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res.statusCode).toBe(400);
  });

  test('defaults to 500 when no status on error', () => {
    const res = createMockRes();
    const err = new Error('something broke');
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res.statusCode).toBe(500);
  });

  test('response body has success: false', () => {
    const res = createMockRes();
    const err = new Error('fail');
    err.status = 422;
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res._body.success).toBe(false);
  });

  test('exposes original message for client errors (< 500)', () => {
    const res = createMockRes();
    const err = new Error('Validation failed');
    err.status = 422;
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res._body.message).toBe('Validation failed');
  });

  test('hides original message for server errors (>= 500)', () => {
    const res = createMockRes();
    const err = new Error('DB connection lost');
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res._body.message).toBe('Internal server error');
  });

  test('includes requestId from x-request-id header', () => {
    const res = createMockRes();
    const err = new Error('oops');
    err.status = 400;
    const req = createMockReq({ headers: { 'x-request-id': 'req-abc-123' } });
    errorHandler(err, req, res, jest.fn());
    expect(res._body.requestId).toBe('req-abc-123');
  });

  test('omits requestId when header is absent', () => {
    const res = createMockRes();
    const err = new Error('oops');
    err.status = 400;
    errorHandler(err, createMockReq(), res, jest.fn());
    expect(res._body.requestId).toBeUndefined();
  });
});
