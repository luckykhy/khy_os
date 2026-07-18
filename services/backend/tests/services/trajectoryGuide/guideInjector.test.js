'use strict';

/**
 * guideInjector.test.js — DESIGN-ARCH-049 G8 (weak-model prompt injection).
 *
 * buildGuideBlock is strictly gated. Verifies:
 *   - KHY_TRAJ_GUIDE_INJECT off → null (sp byte-identical, zero regression);
 *   - inject on + STRONG model → null (strong models author maps, not consume);
 *   - inject on + WEAK model + a relevant map → a "Recommended Path" advisory
 *     block naming the steps, worded as guidance not a hard constraint;
 *   - inject on + WEAK model + no map → null;
 *   - _renderBlock honors the char budget (truncation note appears).
 *
 * The retriever is exercised against a real stored map (no model). RAG_ENABLED
 * is forced on for the weak-hit case.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g8-proj-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_PROJ;
process.env.KHY_DEP_HEALING = 'off';
delete process.env.KHY_TRAJ_GUIDE_INJECT;

const learningRetrieval = require('../../../src/services/learningRetrieval');
const guideInjector = require('../../../src/services/trajectoryGuide/guideInjector');
const mapAuthor = require('../../../src/services/trajectoryGuide/mapAuthor');
const mapStore = require('../../../src/services/trajectoryGuide/mapStore');

const STRONG = 'claude-opus-4-8';
const WEAK = 'claude-haiku-4-5';

function seedMap(task, files) {
  const steps = files.map((f, i) => ({
    seq: i, name: 'write_file', tier: 'FILE',
    artifacts: [{ path: f, sha256: `h${i}`, op: 'create' }],
  }));
  const { map } = mapAuthor.authorMap({ v: 1, sessionId: `s-${task.length}`, env: null, steps }, {
    modelId: STRONG, task,
  });
  mapStore.saveMap(map);
  return map;
}

test('KHY_TRAJ_GUIDE_INJECT off → null', async () => {
  delete process.env.KHY_TRAJ_GUIDE_INJECT;
  const out = await guideInjector.buildGuideBlock({ userMessage: 'anything', modelId: WEAK });
  assert.strictEqual(out, null);
});

test('inject on + strong model → null (strong models do not consume maps)', async () => {
  process.env.KHY_TRAJ_GUIDE_INJECT = 'on';
  try {
    const out = await guideInjector.buildGuideBlock({ userMessage: 'rust wasm module', modelId: STRONG });
    assert.strictEqual(out, null);
  } finally {
    delete process.env.KHY_TRAJ_GUIDE_INJECT;
  }
});

test('inject on + weak model + relevant map → advisory recommended-path block', async () => {
  seedMap('scaffold a rust webassembly module with wasm-pack', ['/work/lib.rs', '/work/Cargo.toml']);
  process.env.KHY_TRAJ_GUIDE_INJECT = 'on';
  const prevRag = learningRetrieval.RAG_ENABLED;
  learningRetrieval.RAG_ENABLED = true;
  try {
    const out = await guideInjector.buildGuideBlock({
      userMessage: 'rust webassembly wasm-pack module',
      modelId: WEAK,
      allowVector: false,
    });
    assert.ok(typeof out === 'string');
    assert.match(out, /Recommended Path/);
    assert.match(out, /guidance, not a constraint/);
    assert.match(out, /lib\.rs/);
  } finally {
    learningRetrieval.RAG_ENABLED = prevRag;
    delete process.env.KHY_TRAJ_GUIDE_INJECT;
  }
});

test('inject on + weak model + no map → null', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g8-empty-'));
  const prevHome = process.env.KHY_PROJECT_DATA_HOME;
  process.env.KHY_PROJECT_DATA_HOME = empty;
  process.env.KHY_TRAJ_GUIDE_INJECT = 'on';
  const prevRag = learningRetrieval.RAG_ENABLED;
  learningRetrieval.RAG_ENABLED = true;
  try {
    const out = await guideInjector.buildGuideBlock({ userMessage: 'unrelated query', modelId: WEAK });
    assert.strictEqual(out, null);
  } finally {
    learningRetrieval.RAG_ENABLED = prevRag;
    process.env.KHY_PROJECT_DATA_HOME = prevHome;
    delete process.env.KHY_TRAJ_GUIDE_INJECT;
  }
});

test('_renderBlock honors the char budget (truncation note)', () => {
  const steps = [];
  for (let i = 0; i < 30; i += 1) {
    steps.push({ seq: i, tier: 'FILE', intent: `create file-number-${i}-with-a-fairly-long-name.js` });
  }
  const block = guideInjector._renderBlock({ task: 'big task', steps }, 300);
  assert.match(block, /path truncated/);
  assert.ok(block.length < 600);
});
