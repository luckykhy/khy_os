'use strict';

const httpError = require('../../src/utils/httpError');

describe('httpError', () => {
  test('creates Error with message', () => {
    const err = httpError(404, 'Not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Not found');
  });

  test('sets statusCode property', () => {
    const err = httpError(500, 'Server error');
    expect(err.statusCode).toBe(500);
  });

  test('handles 400 status', () => {
    const err = httpError(400, 'Bad request');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Bad request');
  });

  test('handles 401 status', () => {
    const err = httpError(401, 'Unauthorized');
    expect(err.statusCode).toBe(401);
  });

  test('handles 403 status', () => {
    const err = httpError(403, 'Forbidden');
    expect(err.statusCode).toBe(403);
  });

  test('handles empty message', () => {
    const err = httpError(500, '');
    expect(err.message).toBe('');
    expect(err.statusCode).toBe(500);
  });

  test('handles undefined message - Error("") gives empty string', () => {
    const err = httpError(500);
    expect(err.message).toBe('');
    expect(err.statusCode).toBe(500);
  });

  test('does not mutate input', () => {
    const msg = 'original message';
    httpError(400, msg);
    expect(msg).toBe('original message');
  });

  test('returns new Error instance each call', () => {
    const err1 = httpError(400, 'error');
    const err2 = httpError(400, 'error');
    expect(err1).not.toBe(err2);
  });
});

