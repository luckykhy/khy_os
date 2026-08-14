'use strict';

/**
 * Tests for moaService (MoA orchestration) + wiring grep.
 * Runner: node --test (NOT jest).
 *
 * The gateway and arena runner are injected so the service runs fully offline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moaService = require('../../src/services/moaService');

const BACKEND_ROOT = path.resolve(__dirname, '../..');

function fakeArena(entries) {
  return {
    async run() {
      return { arenaId: 'arena-test', entries };
    },
  };
}

function fakeGateway(finalAnswer) {
  const calls = [];
  return {
    calls,
    async generate(prompt, opts) {
      calls.push({ prompt, opts });
      return { content: finalAnswer };
    },
  };
}

test('runMoa returns a disabled result when the gate is off', async () => {
  const res = await moaService.runMoa({
    prompt: 'q',
    models: ['a', 'b'],
    env: { KHY_MOA_AGGREGATOR: 'off' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.disabled, true);
  assert.ok(/禁用/.test(res.message));
});

test('_moaEnabled honors the injected env', () => {
  assert.equal(moaService._moaEnabled({}), true, 'default-on');
  assert.equal(moaService._moaEnabled({ KHY_MOA_AGGREGATOR: '0' }), false);
  assert.equal(moaService._moaEnabled({ KHY_MOA_AGGREGATOR: 'false' }), false);
  assert.equal(moaService._moaEnabled({ KHY_MOA_AGGREGATOR: '1' }), true);
});

test('runMoa rejects an empty prompt', async () => {
  const res = await moaService.runMoa({ prompt: '   ', models: ['a', 'b'] });
  assert.equal(res.ok, false);
  assert.ok(/prompt/.test(res.error));
});

test('runMoa requires at least 2 reference models', async () => {
  const res = await moaService.runMoa({ prompt: 'q', models: ['only-one'] });
  assert.equal(res.ok, false);
  assert.ok(/2 个/.test(res.error));
});

test('runMoa happy path: fan-out → normalize → aggregate', async () => {
  const gw = fakeGateway('SYNTHESIZED FINAL ANSWER');
  const res = await moaService.runMoa({
    prompt: 'implement quicksort',
    models: ['model-a', 'model-b'],
    gateway: gw,
    _arena: fakeArena([
      { model: 'model-a', content: 'answer from a about pivots' },
      { model: 'model-b', content: 'distinct answer from b about recursion' },
    ]),
  });

  assert.equal(res.ok, true);
  assert.equal(res.finalAnswer, 'SYNTHESIZED FINAL ANSWER');
  assert.equal(res.references.length, 2);
  assert.equal(res.aggregatorModel, 'model-a', 'defaults to first reference');
  assert.equal(res.arenaId, 'arena-test');

  // aggregator prompt must have carried both references verbatim.
  const aggPrompt = gw.calls[0].prompt;
  assert.ok(aggPrompt.includes('answer from a about pivots'));
  assert.ok(aggPrompt.includes('distinct answer from b about recursion'));
});

test('runMoa honors an explicit aggregatorModel', async () => {
  const gw = fakeGateway('final');
  const res = await moaService.runMoa({
    prompt: 'q',
    models: ['a', 'b'],
    aggregatorModel: 'judge-model',
    gateway: gw,
    _arena: fakeArena([
      { model: 'a', content: 'alpha distinct' },
      { model: 'b', content: 'beta distinct answer' },
    ]),
  });
  assert.equal(res.ok, true);
  assert.equal(res.aggregatorModel, 'judge-model');
  assert.equal(gw.calls[0].opts.model, 'judge-model');
});

test('runMoa fails cleanly when every reference failed', async () => {
  const gw = fakeGateway('unused');
  const res = await moaService.runMoa({
    prompt: 'q',
    models: ['a', 'b'],
    gateway: gw,
    _arena: fakeArena([
      { model: 'a', content: '', failed: true },
      { model: 'b', content: '   ' },
    ]),
  });
  assert.equal(res.ok, false);
  assert.ok(/参考模型/.test(res.error));
});

test('runMoa fails cleanly when the aggregator produces no output', async () => {
  const gw = { async generate() { return { content: '' }; } };
  const res = await moaService.runMoa({
    prompt: 'q',
    models: ['a', 'b'],
    gateway: gw,
    _arena: fakeArena([
      { model: 'a', content: 'alpha distinct answer' },
      { model: 'b', content: 'beta distinct answer' },
    ]),
  });
  assert.equal(res.ok, false);
  assert.ok(/aggregator/.test(res.error));
  assert.equal(res.references.length, 2, 'references still returned for context');
});

// ---- wiring grep -----------------------------------------------------------

test('wiring: moaService requires the moaAggregation leaf', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/moaService.js'), 'utf8');
  assert.ok(src.includes("require('./moaAggregation')"), 'service imports leaf');
  assert.ok(src.includes('KHY_MOA_AGGREGATOR'), 'gate referenced');
});

test('wiring: KHY_MOA_AGGREGATOR is registered in flagRegistry', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/flagRegistry.js'), 'utf8');
  assert.ok(src.includes('KHY_MOA_AGGREGATOR'), 'flag registered');
});

test('wiring: CLI handler and router dispatch are wired', () => {
  const handler = fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli/handlers/moa.js'), 'utf8');
  assert.ok(handler.includes('handleMoa'), 'handler defines handleMoa');
  assert.ok(handler.includes("require('../../services/moaService')"), 'handler uses service');

  const tail = fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli/routerDispatchTail.js'), 'utf8');
  assert.ok(/case 'moa'/.test(tail), 'router has moa case');
  assert.ok(tail.includes('handleMoa'), 'router calls handleMoa');
});

test('wiring: moa registered in commandSchema', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/constants/commandSchema.js'), 'utf8');
  assert.ok(src.includes("'moa'"), 'moa in command schema');
});
