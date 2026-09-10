'use strict';

describe('routes/commands', () => {
  let router;
  let mockBuildCommandCatalog;

  beforeEach(() => {
    jest.resetModules();
    mockBuildCommandCatalog = jest.fn(() => ({
      categories: [
        { name: 'General', commands: [{ cmd: '/help', label: 'Help', desc: 'Show help' }] },
      ],
      total: 1,
      generatedBy: 'commandSchema',
    }));
    jest.mock('../services/domain/catalog/commandCatalog/commandCatalog.js', () => ({
      buildCommandCatalog: mockBuildCommandCatalog,
    }));
    router = require('./commands');
  });

  it('should export an express router', () => {
    expect(typeof router).toBe('function');
    expect(router.stack).toBeDefined();
  });

  it('GET / returns full catalog when no query', async () => {
    const req = { query: {} };
    const res = { json: jest.fn() };
    const route = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    expect(mockBuildCommandCatalog).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.any(Object) })
    );
  });

  it('GET /?q=help filters by keyword', async () => {
    const req = { query: { q: 'help' } };
    const res = { json: jest.fn() };
    const route = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    const result = res.json.mock.calls[0][0];
    expect(result.data.total).toBe(1);
  });

  it('GET /?q=nonexistent returns empty categories', async () => {
    const req = { query: { q: 'nonexistent' } };
    const res = { json: jest.fn() };
    const route = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    const result = res.json.mock.calls[0][0];
    expect(result.data.categories).toEqual([]);
    expect(result.data.total).toBe(0);
  });

  it('GET / returns degraded catalog on error', async () => {
    jest.resetModules();
    jest.mock('../services/domain/catalog/commandCatalog/commandCatalog.js', () => ({
      buildCommandCatalog: jest.fn(() => { throw new Error('fail'); }),
    }));
    const freshRouter = require('./commands');
    const req = { query: {} };
    const res = { json: jest.fn() };
    const route = freshRouter.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    await route.route.stack[0].handle(req, res, () => {});
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { categories: [], total: 0, generatedBy: 'commandSchema' },
        degraded: true,
      })
    );
  });
});

