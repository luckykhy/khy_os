// Uses Jest's global describe/it/expect (previously imported from node:test,
// which Jest does not collect).
const { apiLimiter } = require('../src/middleware/rateLimit');

describe('apiLimiter', () => {
  it('should be a function', () => {
    expect(typeof apiLimiter).toBe('function');
  });
});