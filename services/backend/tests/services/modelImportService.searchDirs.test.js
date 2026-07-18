const os = require('os');
const path = require('path');

describe('modelImportService search dirs', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.KHY_DATA_HOME;
    delete process.env.OLLAMA_MODELS;
    delete process.env.KHYQUANT_ROOT;
  });

  test('includes khy data homes and ollama blobs by default', () => {
    const svc = require('../../src/services/modelImportService');
    const dirs = svc.getModelSearchDirs();

    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs).toContain(path.join(os.homedir(), '.khy', 'models'));
    expect(dirs).toContain(path.join(os.homedir(), '.khyquant', 'models'));
    expect(dirs).toContain(path.join(os.homedir(), '.ollama', 'models', 'blobs'));
  });

  test('respects custom OLLAMA_MODELS path', () => {
    process.env.OLLAMA_MODELS = '/tmp/custom-ollama-models';
    const svc = require('../../src/services/modelImportService');
    const dirs = svc.getModelSearchDirs();

    expect(dirs).toContain('/tmp/custom-ollama-models/blobs');
  });
});
