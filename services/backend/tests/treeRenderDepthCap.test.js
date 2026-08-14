'use strict';

/**
 * Round-7 regression: tree-render depth cap (stack-overflow guard).
 *
 * _renderTree() in cli/mermaid.js recurses (count + walk) on tree depth with no
 * limit. It runs on ASSISTANT/model output — mermaid mindmap fences and deeply
 * nested markdown lists (renderNestedListTrees) — NOT on raw user messages
 * (those are char-capped and echoed without tree rendering). A model emitting a
 * ~5000-deep chain overflows the recursion stack (RangeError), and at the one
 * unwrapped render site (repl.js:486 renderAiResponse) that crashes the REPL.
 *
 * Honest scope: defense-in-depth against pathological MODEL output, not a
 * user-input-reachable P1. The cap makes the renderer total for any depth while
 * staying byte-identical for every realistic diagram. Gate KHY_TREE_DEPTH_CAP.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MERMAID_PATH = path.join(__dirname, '..', 'src', 'cli', 'mermaid.js');

function load(gate) {
  delete require.cache[require.resolve(MERMAID_PATH)];
  if (gate === undefined) delete process.env.KHY_TREE_DEPTH_CAP;
  else process.env.KHY_TREE_DEPTH_CAP = gate;
  return require(MERMAID_PATH);
}

test.afterEach(() => { delete process.env.KHY_TREE_DEPTH_CAP; });

function deepMindmap(n) {
  let s = 'mindmap\n';
  for (let i = 0; i < n; i++) s += '  '.repeat(i + 1) + 'node' + i + '\n';
  return s;
}

test('deep mindmap does not overflow the stack when cap enabled', () => {
  const mm = load(undefined);
  for (const n of [5000, 20000]) {
    let ok = true;
    try { mm.renderMermaidBlock(deepMindmap(n)); }
    catch { ok = false; }
    assert.ok(ok, `depth ${n} should render without throwing`);
  }
});

test('normal small mindmap is byte-identical with cap on vs off', () => {
  const code = 'mindmap\n  Root\n    A\n    B\n      C\n    D\n';
  const on = load(undefined).renderMermaidBlock(code);
  const off = load('0').renderMermaidBlock(code);
  assert.strictEqual(on, off);
  assert.ok(on && on.includes('A') && on.includes('C'));
});

test('moderately deep tree (below cap) unchanged by the guard', () => {
  const code = deepMindmap(100);
  const on = load(undefined).renderMermaidBlock(code);
  const off = load('0').renderMermaidBlock(code);
  assert.strictEqual(on, off);
});

test('gate disabled reproduces the legacy unbounded recursion (load-bearing)', () => {
  const mm = load('0');
  let threw = false;
  try { mm.renderMermaidBlock(deepMindmap(6000)); }
  catch (e) { threw = e instanceof RangeError; }
  assert.ok(threw, 'legacy path should still overflow (proves the guard is load-bearing)');
});

test('empty / non-mindmap input returns falsy without throwing', () => {
  const mm = load(undefined);
  assert.doesNotThrow(() => mm.renderMermaidBlock(''));
  assert.doesNotThrow(() => mm.renderMermaidBlock('not a mermaid block'));
});
