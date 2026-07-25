/**
 * Local model-server probe — discover models served by a locally running
 * Ollama instance (or compatible) for the per-user catalog.
 *
 * Thin wrapper over ollamaModelManager: it does NOT re-implement the HTTP call
 * or hardcode the port — it reuses the single-source `OLLAMA_HOST` constant and
 * the manager's `isOllamaRunning()` / `listModels()` so there is exactly one
 * place that knows how to reach Ollama.
 *
 * Never-throw + non-blocking: if Ollama is not running, not installed, or the
 * call times out, this returns an empty list (the catalog simply shows no local
 * models). It never hangs the detection flow and never invents a model.
 *
 * @pattern Adapter
 */
'use strict';

const ollamaModelManager = require('../ollamaModelManager');

/**
 * Probe the local Ollama server for its installed models.
 *
 * @returns {Promise<{running:boolean, models:Array<{id:string, source:'local'}>, error:string|null}>}
 *   `running` reflects whether the server answered; `models` are the local
 *   model ids (empty when not running / on failure); `error` carries a short
 *   reason for state transparency without throwing.
 */
async function fetchLocalModels() {
  let running = false;
  try {
    running = await ollamaModelManager.isOllamaRunning();
  } catch (err) {
    return { running: false, models: [], error: err && err.message ? err.message : 'ollama probe failed' };
  }
  if (!running) {
    return { running: false, models: [], error: null };
  }
  try {
    const list = await ollamaModelManager.listModels();
    const models = (Array.isArray(list) ? list : [])
      .filter((m) => m && m.name)
      .map((m) => ({ id: m.name, source: 'local' }));
    return { running: true, models, error: null };
  } catch (err) {
    return { running: true, models: [], error: err && err.message ? err.message : 'list models failed' };
  }
}

module.exports = { fetchLocalModels };
