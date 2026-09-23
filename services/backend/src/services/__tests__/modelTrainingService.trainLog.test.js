/**
 * Unit tests for the khy-trainlog/v1 structured training-log protocol and
 * the post-training eval-gate helpers added to modelTrainingService.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { strict: assert } = require('node:assert');

// Point the training dir at a throwaway location so the module does not touch
// the real user data home during tests.
process.env.KHY_TRAINING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-train-test-'));

const svc = require('../modelTrainingService');

const lines = [
  { type: 'log_header', protocol: 'khy-trainlog/v1' },
  { type: 'epoch_start', epoch: 0, total: 3 },
  { type: 'log_step', step: 10, total: 90, loss: 1.23, lr: 0.0001, elapsed: 100, remaining: 300 },
  { type: 'epoch_end', epoch: 0, train_loss: 1.2, eval_loss: 1.45 },
  { type: 'log_step', step: 88, total: 90, loss: 0.98, eval_loss: 1.4, lr: 0.00009, elapsed: 880, remaining: 20 },
  { type: 'done', totalSteps: 90 },
].map((o) => JSON.stringify(o));

describe('modelTrainingService khy-trainlog/v1', () => {
  it('buildTrainLogHelper emits valid Python with no backticks or ${} interpolation', () => {
    const py = svc.buildTrainLogHelper();
    assert.ok(py.includes('def _khy_log_event'));
    assert.ok(py.includes('def _khy_emit_header'));
    assert.ok(py.includes('def _khy_done'));
    assert.ok(!py.includes('`'), 'helper must not contain JS template-literal backticks');
    assert.ok(!py.includes('${'), 'helper must not contain unescaped ${} interpolation');
  });

  it('parseTrainLogProgress extracts step/epoch/loss/elapsed/pct from a full run', () => {
    const p = svc.parseTrainLogProgress(lines.join('\n'));
    assert.equal(p.pct, 98, 'pct from step 88/90');
    assert.equal(p.epoch, 0, 'epoch from last epoch_end');
    assert.equal(p.epochs, 3, 'total epochs from epoch_start');
    assert.equal(p.totalSteps, 90);
    assert.equal(p.step, 88);
    assert.equal(p.loss, 0.98, 'last log_step loss');
    assert.equal(p.evalLoss, 1.4, 'last log_step eval_loss');
    assert.equal(p.lr, 0.00009);
    assert.equal(p.elapsedSec, 880);
    assert.equal(p.remainingSec, 0, 'done event forces remaining to 0');
  });

  it('parseTrainLogProgress tolerates a torn final line', () => {
    const partial = lines.join('\n') + '\n' + JSON.stringify({ type: 'log_step', step: 90, total: 90, loss: 0.95 }).slice(0, 30);
    const p = svc.parseTrainLogProgress(partial);
    assert.equal(p.pct, 98, 'torn line ignored, last good step still 88');
  });

  it('parseTrainLogProgress handles an empty log', () => {
    const p = svc.parseTrainLogProgress('');
    assert.equal(p.pct, undefined);
    assert.equal(p.step, undefined);
  });

  it('buildRecipeSnapshot captures hyperparams, data fingerprint and git state', () => {
    const recipe = svc.buildRecipeSnapshot({
      base: svc.BASE_MODELS['qwen-3b'],
      baseModel: 'qwen-3b',
      method: 'lora',
      preset: 'standard',
      config: svc.TRAINING_PRESETS.standard,
      datasetPath: process.env.KHY_TRAINING_DIR + '/dataset.json',
      datasetSize: 42,
      compute: { platform: 'win32', arch: 'x64', cpus: 8, totalRAM: 16, cuda: false, mps: false },
    });
    assert.equal(recipe.schema, 'khy-recipe/v1');
    assert.equal(recipe.hyperparams.epochs, svc.TRAINING_PRESETS.standard.epochs);
    assert.equal(recipe.hyperparams.seed, 42, 'seed is explicit for reproducibility');
    assert.equal(recipe.data.count, 42);
    // Fingerprint is null when the dataset file does not exist
    assert.equal(recipe.data.fingerprint, null);
  });

  it('writeRecipeSnapshot + readRecipeSnapshot round-trips to disk', () => {
    const dir = fs.mkdtempSync(path.join(process.env.KHY_TRAINING_DIR, 'recipe-test-'));
    const recipe = svc.buildRecipeSnapshot({
      base: svc.BASE_MODELS['qwen-3b'],
      baseModel: 'qwen-3b',
      method: 'lora',
      preset: 'quick',
      config: svc.TRAINING_PRESETS.quick,
      datasetPath: '/nonexistent',
      datasetSize: 0,
      compute: { platform: 'x', arch: 'x', cpus: 1 },
    });
    const written = svc.writeRecipeSnapshot(dir, recipe);
    assert.ok(written, 'writeRecipeSnapshot returns a path');
    assert.ok(fs.existsSync(written), 'recipe.json exists on disk');
    const readBack = svc.readRecipeSnapshot(dir);
    assert.equal(readBack.schema, 'khy-recipe/v1');
    assert.equal(readBack.model.hfId, svc.BASE_MODELS['qwen-3b'].hfId);
  });

  it('evaluateModel fail-opens (skipped=true) when Ollama is unreachable', async () => {
    const result = await svc.evaluateModel(os.tmpdir(), 'khy-9.9', {});
    assert.equal(result.skipped, true, 'gate must skip, not throw, when Ollama is down');
    assert.ok(result.reason && result.reason.length > 0, 'skip reason must be surfaced to the user');
  });

  it('autoRollbackOnEvalFailure reports a clean not-found message for an unregistered model', () => {
    const skipped = { skipped: true, passed: false, score: 0, total: 4, results: [], reason: 'Ollama unreachable' };
    const decision = svc.autoRollbackOnEvalFailure('khy-9.9', skipped);
    assert.equal(decision.success, false, 'unregistered model cannot be rolled back');
    assert.ok(decision.message.includes('not in registry'), 'message names the missing registry entry');
  });

  it('autoRollbackOnEvalFailure marks a skipped gate as skipped and does not roll back', () => {
    // Seed the registry so the failed model is known, then exercise the skip path.
    svc.registerModel('khy-9.9', { basedOn: 'x', method: 'lora', path: os.tmpdir() });
    const skipped = { skipped: true, passed: false, score: 0, total: 4, results: [], reason: 'Ollama 不可达' };
    const decision = svc.autoRollbackOnEvalFailure('khy-9.9', skipped);
    assert.equal(decision.success, true, 'a skipped gate is not a failure of the training run');
    assert.ok(decision.message.includes('跳过'), 'message reports the skip in user-facing Chinese');
    const reg = svc.listModels();
    assert.equal(reg['khy-9.9'].evalStatus, 'skipped');
  });

  it('EVAL_PROBES is a fixed, non-empty probe set with deterministic expectations', () => {
    assert.ok(Array.isArray(svc.EVAL_PROBES) && svc.EVAL_PROBES.length >= 3);
    for (const probe of svc.EVAL_PROBES) {
      assert.ok(probe.id, 'probe has an id');
      assert.ok(probe.prompt, 'probe has a prompt');
      assert.ok(probe.expectContains, 'probe has a deterministic expectation');
    }
  });
});
