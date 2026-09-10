'use strict';

const { ok, fail, page } = require('../../src/utils/response');

describe('response helpers', () => {
  let mockRes;

  beforeEach(() => {
    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
  });

  describe('ok', () => {
    test('returns success with default values', () => {
      ok(mockRes);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: 'Success',
        data: null,
      });
    });

    test('returns success with custom data', () => {
      ok(mockRes, { id: 1, name: 'test' });
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: 'Success',
        data: { id: 1, name: 'test' },
      });
    });

    test('returns success with custom message', () => {
      ok(mockRes, null, 'Created');
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: 'Created',
        data: null,
      });
    });

    test('returns success with all custom params', () => {
      ok(mockRes, [1, 2, 3], 'List retrieved');
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: 'List retrieved',
        data: [1, 2, 3],
      });
    });
  });

  describe('fail', () => {
    test('returns failure with defaults', () => {
      fail(mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Request failed',
      });
    });

    test('returns failure with custom message', () => {
      fail(mockRes, 'Not found');
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Not found',
      });
    });

    test('returns failure with custom status', () => {
      fail(mockRes, 'Server error', 500);
      expect(mockRes.status).toHaveBeenCalledWith(500);
    });

    test('includes errors when provided', () => {
      const errors = [{ field: 'email', message: 'Invalid' }];
      fail(mockRes, 'Validation failed', 422, errors);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Validation failed',
        errors,
      });
    });

    test('omits errors when null', () => {
      fail(mockRes, 'Error', 400, null);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Error',
      });
    });
  });

  describe('page', () => {
    test('returns paginated response', () => {
      const rows = [{ id: 1 }, { id: 2 }];
      page(mockRes, rows, 100, 1, 10);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: {
          list: rows,
          total: 100,
          page: 1,
          pageSize: 10,
        },
      });
    });

    test('converts string page/pageSize to int', () => {
      page(mockRes, [], 0, '2', '20');
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: {
          list: [],
          total: 0,
          page: 2,
          pageSize: 20,
        },
      });
    });

    test('handles empty rows', () => {
      page(mockRes, [], 0, 1, 10);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: {
          list: [],
          total: 0,
          page: 1,
          pageSize: 10,
        },
      });
    });
  });
});
