'use strict';

/**
 * localModelLoadDiagnosis.test.js — model-load incompatibility diagnosis (node:test).
 *
 * Goal "模型加载失败与本地推理引擎兼容性障碍": loading a Qwen 3.5 GGUF raised
 *   [node-llama-cpp] llama_model_load: error loading model: error loading model
 *   hyperparameters: key qwen35.rope.dimension_sections has wrong array length;
 *   expected 4, got 3
 * but the user only saw a bare "AI 在执行过程中超时". The built-in engine's
 * catch swallowed the real cause, and the raw native log leaked to the TUI.
 *
 * The fix classifies this ARCHITECTURE incompatibility into a structured,
 * actionable diagnosis (cause + concrete fixes incl. the Ollama fallback) and
 * preserves it across the backend fallthrough so the final error is specific,
 * not a timeout. These cases are the PRESERVED reproduction set for the symptom
 * and the invariants that prove it cannot regress to a bare failure.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const localLLM = require('../../src/services/localLLMService');
const { classifyModelLoadError } = localLLM;
const diagnosisDictionary = require('../../src/services/selfHeal/diagnosisDictionary');

// The exact line node-llama-cpp printed in the reported symptom.
const SYMPTOM =
  '[node-llama-cpp] llama_model_load: error loading model: error loading model ' +
  'hyperparameters: key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3';

describe('classifyModelLoadError — structured incompatibility diagnosis', () => {
  test('the reported Qwen3.5 rope/hyperparameter symptom is recognized as incompatible', () => {
    const d = classifyModelLoadError(SYMPTOM);
    assert.ok(d, 'the symptom must produce a diagnosis (not null / not swallowed)');
    assert.equal(d.code, 'LOCAL_MODEL_INCOMPATIBLE');
    assert.ok(/不兼容|超参|架构/.test(d.cause), 'cause must explain the format/architecture mismatch');
    assert.ok(Array.isArray(d.solutions) && d.solutions.length >= 2, 'must offer concrete solutions');
    // The Ollama fallback (the hard-constraint integration) must be among them.
    assert.ok(d.solutions.some((s) => /ollama/i.test(s)), 'solutions must include the Ollama path');
  });

  test('related hyperparameter / architecture phrasings are also recognized', () => {
    for (const m of [
      'error loading model hyperparameters: bad value',
      'unknown model architecture: \'qwen35\'',
      'unsupported model architecture',
      'llama_model_load_from_file_impl: failed to load model',
    ]) {
      assert.ok(classifyModelLoadError(m), `should classify: ${m}`);
    }
  });

  test('classification is case-insensitive (engine casing varies)', () => {
    assert.ok(classifyModelLoadError(SYMPTOM.toUpperCase()));
    assert.ok(classifyModelLoadError('ERROR LOADING MODEL HYPERPARAMETERS'));
  });

  test('UNRELATED failures are NOT misclassified as incompatibility (fall back instead)', () => {
    for (const m of [
      'connect ECONNREFUSED 127.0.0.1:11434',
      'socket hang up',
      "No module named 'node-llama-cpp'",
      'Cannot find module node-llama-cpp',
      'Python inference server startup timed out after 30s',
      'EACCES: permission denied',
    ]) {
      assert.equal(classifyModelLoadError(m), null, `must NOT classify as incompat: ${m}`);
    }
  });

  test('never throws on falsy / non-string input', () => {
    assert.equal(classifyModelLoadError(''), null);
    assert.equal(classifyModelLoadError(null), null);
    assert.equal(classifyModelLoadError(undefined), null);
    assert.doesNotThrow(() => classifyModelLoadError({}));
    assert.doesNotThrow(() => classifyModelLoadError(12345));
  });
});

describe('getStatus surfaces the incompatibility (no bare failure)', () => {
  test('status exposes modelIncompatible / modelLoadDiagnosis fields', () => {
    const status = localLLM.getStatus();
    // Fields always present (false/null when no incompatibility was seen) so the
    // UI can branch on the real cause instead of guessing from a timeout string.
    assert.ok('modelIncompatible' in status, 'status must expose modelIncompatible');
    assert.ok('modelLoadDiagnosis' in status, 'status must expose modelLoadDiagnosis');
    assert.equal(typeof status.modelIncompatible, 'boolean');
  });
});

describe('selfHeal diagnosisDictionary — consistent classification', () => {
  test('the rope/hyperparameter symptom maps to local-model-incompatible (L0 degrade-direct)', () => {
    const dx = diagnosisDictionary.diagnose(SYMPTOM, '');
    assert.ok(dx, 'dictionary must classify the symptom');
    assert.equal(dx.id, 'local-model-incompatible');
    assert.equal(dx.risk, diagnosisDictionary.RISK.L0);
    assert.equal(dx.fixKind, 'degrade-direct'); // auto-fall back, don't retry the broken engine
    assert.equal(dx.needsConfirm, false);
  });

  test('does not shadow existing dependency / connection diagnoses', () => {
    assert.equal(diagnosisDictionary.diagnose("No module named 'puppeteer'", 'MISSING_DEPENDENCY').id, 'module-not-found');
    assert.equal(diagnosisDictionary.diagnose('connect ECONNREFUSED 127.0.0.1:9222', 'ECONNREFUSED').id, 'conn-refused');
  });
});
