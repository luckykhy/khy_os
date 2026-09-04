/**
 * localOllamaProbe — discover locally served models via ollamaModelManager.
 *
 * Covers: not-running → empty + no error; running → mapped {id, source:'local'};
 * listModels failure → empty + error (never throws); isOllamaRunning throw →
 * graceful failure.
 */
'use strict';

jest.mock('../src/services/ollamaModelManager', () => ({
  isOllamaRunning: jest.fn(),
  listModels: jest.fn(),
}));

const ollama = require('../src/services/ollamaModelManager');
const { fetchLocalModels } = require('../src/services/gateway/localOllamaProbe');

afterEach(() => jest.clearAllMocks());

test('not running → empty list, no error, listModels not called', async () => {
  ollama.isOllamaRunning.mockResolvedValue(false);
  const out = await fetchLocalModels();
  expect(out).toEqual({ running: false, models: [], error: null });
  expect(ollama.listModels).not.toHaveBeenCalled();
});

test('running → maps model names to {id, source:local}', async () => {
  ollama.isOllamaRunning.mockResolvedValue(true);
  ollama.listModels.mockResolvedValue([
    { name: 'qwen2.5:7b', size: 1 },
    { name: 'llama3.1:8b' },
    { notName: true },
  ]);
  const out = await fetchLocalModels();
  expect(out.running).toBe(true);
  expect(out.error).toBeNull();
  expect(out.models).toEqual([
    { id: 'qwen2.5:7b', source: 'local' },
    { id: 'llama3.1:8b', source: 'local' },
  ]);
});

test('listModels rejects → running:true, empty models, error set (no throw)', async () => {
  ollama.isOllamaRunning.mockResolvedValue(true);
  ollama.listModels.mockRejectedValue(new Error('tags failed'));
  const out = await fetchLocalModels();
  expect(out.running).toBe(true);
  expect(out.models).toEqual([]);
  expect(out.error).toBe('tags failed');
});

test('isOllamaRunning throws → graceful failure, never throws', async () => {
  ollama.isOllamaRunning.mockRejectedValue(new Error('boom'));
  await expect(fetchLocalModels()).resolves.toEqual({ running: false, models: [], error: 'boom' });
});
