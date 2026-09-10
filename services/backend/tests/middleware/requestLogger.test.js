'use strict';

const requestLogger = require('../../src/middleware/requestLogger');

describe('requestLogger middleware', () => {
  let mockReq;
  let mockRes;
  let mockNext;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
    jest.mock('../../src/utils/logger', () => mockLogger);

    mockReq = {
      method: 'GET',
      originalUrl: '/api/test',
      headers: {},
      ip: '127.0.0.1',
      id: 'req-123',
      user: { id: 42 },
    };

    mockRes = {
      statusCode: 200,
      on: jest.fn(),
    };

    mockNext = jest.fn();
  });

  test('calls next()', () => {
    requestLogger(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  test('registers finish event listener', () => {
    requestLogger(mockReq, mockRes, mockNext);
    expect(mockRes.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  test('logs info for 200 status', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('logs warn for 400 status', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 400;
    finishHandler();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  test('logs warn for 500 status', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 500;
    finishHandler();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  test('logs warn for 404 status', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 404;
    finishHandler();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  test('includes correct fields in log metadata', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logArgs = mockLogger.info.mock.calls[0];
    expect(logArgs[1]).toMatchObject({
      method: 'GET',
      url: '/api/test',
      status: 200,
      userId: 42,
      ip: '127.0.0.1',
      requestId: 'req-123',
    });
  });

  test('uses x-request-id header when present', () => {
    mockReq.headers['x-request-id'] = 'custom-request-id';
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logArgs = mockLogger.info.mock.calls[0];
    expect(logArgs[1].requestId).toBe('custom-request-id');
  });

  test('handles missing user', () => {
    mockReq.user = undefined;
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logArgs = mockLogger.info.mock.calls[0];
    expect(logArgs[1].userId).toBeUndefined();
  });

  test('handles missing headers', () => {
    mockReq.headers = {};
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logArgs = mockLogger.info.mock.calls[0];
    expect(logArgs[1].requestId).toBe('req-123');
  });

  test('calculates duration', () => {
    const originalDateNow = Date.now;
    let callCount = 0;
    Date.now = jest.fn(() => {
      callCount++;
      return callCount === 1 ? 1000 : 1050;
    });

    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logArgs = mockLogger.info.mock.calls[0];
    expect(logArgs[1].duration).toBe(50);

    Date.now = originalDateNow;
  });

  test('log message format includes method url status duration', () => {
    requestLogger(mockReq, mockRes, mockNext);
    const finishHandler = mockRes.on.mock.calls[0][1];

    mockRes.statusCode = 200;
    finishHandler();

    const logMessage = mockLogger.info.mock.calls[0][0];
    expect(logMessage).toContain('GET');
    expect(logMessage).toContain('/api/test');
    expect(logMessage).toContain('200');
    expect(logMessage).toContain('ms');
  });
});

