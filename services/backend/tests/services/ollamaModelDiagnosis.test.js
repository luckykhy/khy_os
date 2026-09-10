'use strict';
/**
 * ollamaModelDiagnosis.test.js â€?`khy doctor` Ollama local-inference verdict (node:test).
 *
 * Companion to localModelLoadDiagnosis: when the built-in node-llama-cpp engine
 * can't load a newer GGUF, Ollama is the recommended fallback. `khy doctor` now
 * probes OLLAMA_HOST/api/tags and feeds the result to the PURE diagnoseOllamaModel,
 * which returns an actionable verdict + an auto-correct OLLAMA_MODEL suggestion.
 *
 * The branches must mirror the runtime:
 *   - offline                  â†?warn, tell the user to `ollama serve` + `ollama pull`
 *   - exact tag installed      â†?ok, local inference usable
 *   - same FAMILY tag only     â†?warn, suggest OLLAMA_MODEL=<installed tag> (because
 *                                generateOllama sends the EXACT tag and would 404)
 *   - online but no match      â†?warn, list installed tags + pull/set-env guidance
 * These are the regression guards proving the doctor verdict cannot silently lie.
 */
const localLLM = require('../../src/services/localLLMService');
const { diagnoseOllamaModel } = localLLM;
describe('diagnoseOllamaModel â€?actionable local-inference verdict', () => {
});

describe('Ollama Model Diagnosis', () => {
  test('offline â†?warn with serve + pull guidance, never ok', () => {
        const v = diagnoseOllamaModel({ online: false, tags: [], configuredModel: 'qwen3.5:4b' });
        expect(v.ok).toBe(false);
        expect(v.level).toBe('warn');
        expect(v.suggestion).toBe(null);
        expect(v.detail).toMatch(/ollama serve/);
        expect(v.detail).toMatch(/ollama pull qwen3\.5:4b/);
  });

  test('exact configured tag installed â†?ok / info, no suggestion', () => {
        const v = diagnoseOllamaModel({
          online: true,
          tags: ['llama3:8b', 'qwen3.5:4b', 'mistral:7b'],
          configuredModel: 'qwen3.5:4b',
        });
        expect(v.ok).toBe(true);
        expect(v.level).toBe('info');
        expect(v.matchedTag).toBe('qwen3.5:4b');
        expect(v.suggestion).toBe(null);
  });

  test('same-family tag only â†?warn + auto-correct OLLAMA_MODEL suggestion', () => {
        // isOllamaAvailable() would PASS on the family prefix, but generateOllama
        // sends the exact 'qwen3.5:4b' and would 404. The doctor must steer the user.
        const v = diagnoseOllamaModel({
          online: true,
          tags: ['qwen3.5:7b', 'llama3:8b'],
          configuredModel: 'qwen3.5:4b',
        });
        expect(v.ok).toBe(false);
        expect(v.level).toBe('warn');
        expect(v.matchedTag).toBe('qwen3.5:7b');
        expect(v.suggestion).toBe('OLLAMA_MODEL=qwen3.5:7b');
        expect(v.detail).toMatch(/qwen3\.5:7b/);
  });

  test('online but no matching family â†?warn, lists installed tags + guidance', () => {
        const v = diagnoseOllamaModel({
          online: true,
          tags: ['llama3:8b', 'mistral:7b'],
          configuredModel: 'qwen3.5:4b',
        });
        expect(v.ok).toBe(false);
        expect(v.level).toBe('warn');
        expect(v.matchedTag).toBe(null);
        expect(v.suggestion).toBe('OLLAMA_MODEL=<å·²å®‰è£…çš„tag>');
        expect(v.detail).toMatch(/llama3:8b/);
        expect(v.detail).toMatch(/ollama pull qwen3\.5:4b/);
  });

  test('online with zero installed models â†?warn, no tag suggestion (pull first)', () => {
        const v = diagnoseOllamaModel({ online: true, tags: [], configuredModel: 'qwen3.5:4b' });
        expect(v.ok).toBe(false);
        expect(v.suggestion).toBe(null);
        expect(v.detail).toMatch(/ollama pull qwen3\.5:4b/);
  });

  test('falls back to the configured default model when none is passed', () => {
        const v = diagnoseOllamaModel({ online: true, tags: [] });
        expect(v.ok).toBe(false);
        expect(v.detail).toMatch(new RegExp(localLLM.OLLAMA_MODEL.replace(/[.]/g, '\\.')));
  });

  test('never throws on missing / malformed input (doctor must not crash)', () => {
        expect(() => diagnoseOllamaModel().not.toThrow());
        expect(() => diagnoseOllamaModel({}).not.toThrow());
        expect(() => diagnoseOllamaModel({ online: true, tags: null }).not.toThrow());
        expect(() => diagnoseOllamaModel({ online: true, tags: [null, undefined, 123] }).not.toThrow());
        const v = diagnoseOllamaModel({ online: true, tags: [null, 'qwen3.5:4b'], configuredModel: 'qwen3.5:4b' });
        expect(v.ok).toBe(true); // junk entries filtered, real match still found
  });

  test('exports OLLAMA_MODEL / OLLAMA_HOST for the doctor probe', () => {
        expect(typeof localLLM.OLLAMA_MODEL).toBe('string');
        expect(localLLM.OLLAMA_MODEL.length > 0).toBeTruthy();
        expect(typeof localLLM.OLLAMA_HOST).toBe('string');
        expect(localLLM.OLLAMA_HOST).toMatch(/^https?:\/\//);
  });

});

