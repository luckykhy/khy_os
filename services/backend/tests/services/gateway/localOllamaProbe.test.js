'use strict';

jest.mock('../../../src/services/ollamaModelManager', () => ({
  isOllamaRunning: jest.fn(),
  listModels: jest.fn()
}));

const { fetchLocalModels } = require('../../../src/services/gateway/localOllamaProbe');
const ollamaModelManager = require('../../../src/services/ollamaModelManager');

describe('localOllamaProbe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns not running when Ollama is down', async () => {
    ollamaModelManager.isOllamaRunning.mockResolvedValue(false);
    const result = await fetchLocalModels();
    expect(result.running).toBe(false);
    expect(result.models).toEqual([]);
  });

  test('returns empty on isOllamaRunning error', async () => {
    ollamaModelManager.isOllamaRunning.mockRejectedValue(new Error('connection refused'));
    const result = await fetchLocalModels();
    expect(result.running).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  test('returns models when running', async () => {
    ollamaModelManager.isOllamaRunning.mockResolvedValue(true);
    ollamaModelManager.listModels.mockResolvedValue([
      { name: 'llama3' },
      { name: 'mistral' }
    ]);
    const result = await fetchLocalModels();
    expect(result.running).toBe(true);
    expect(result.models).toEqual([
      { id: 'llama3', source: 'local' },
      { id: 'mistral', source: 'local' }
    ]);
  });

  test('filters out models without name', async () => {
    ollamaModelManager.isOllamaRunning.mockResolvedValue(true);
    ollamaModelManager.listModels.mockResolvedValue([
      { name: 'llama3' },
      null,
      { name: '' }
    ]);
    const result = await fetchLocalModels();
    expect(result.models).toEqual([{ id: 'llama3', source: 'local' }]);
  });

  test('returns error on listModels failure', async () => {
    ollamaModelManager.isOllamaRunning.mockResolvedValue(true);
    ollamaModelManager.listModels.mockRejectedValue(new Error('timeout'));
    const result = await fetchLocalModels();
    expect(result.running).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.error).toBe('timeout');
  });
});

