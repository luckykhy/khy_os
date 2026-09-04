'use strict';

const { ok, fail, page } = require('../../src/utils/response');

describe('response helpers', () => {
  const mockRes = () => ({
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  });

  describe('ok', () => {
    test('returns success response', () => {
      const res = mockRes();
      ok(res, { id: 1 }, 'Created');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Created',
        data: { id: 1 },
      });
    });

    test('uses defaults', () => {
      const res = mockRes();
      ok(res);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Success',
        data: null,
      });
    });
  });

  describe('fail', () => {
    test('returns error response', () => {
      const res = mockRes();
      fail(res, 'Not found', 404);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Not found',
      });
    });

    test('includes errors when provided', () => {
      const res = mockRes();
      fail(res, 'Validation failed', 400, ['field required']);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Validation failed',
        errors: ['field required'],
      });
    });
  });

  describe('page', () => {
    test('returns paginated response', () => {
      const res = mockRes();
      page(res, [1, 2, 3], 10, 1, 20);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          list: [1, 2, 3],
          total: 10,
          page: 1,
          pageSize: 20,
        },
      });
    });
  });
});
