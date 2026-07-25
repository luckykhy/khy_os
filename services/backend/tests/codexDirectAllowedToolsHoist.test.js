'use strict';

/**
 * codexDirectAllowedToolsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the ALLOWED tool-name Set out of
 * buildDirectToolDefs. It was rebuilt on every Codex model round-trip; now built
 * once at module load as _CODEX_DIRECT_ALLOWED_TOOLS. Behavior must be
 * byte-identical: the Set is consumed read-only via `.has`, while the per-call
 * `seen` dedup Set stays inline (must NOT accumulate across calls).
 */

const test = require('node:test');
const assert = require('node:assert');

const cx = require('../src/services/gateway/adapters/codexAdapter');
const buildDirectToolDefs = cx.__test__.buildDirectToolDefs;

const ALLOWED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'web_search'];

test('every produced tool name is in the allowlist and unique', () => {
  const defs = buildDirectToolDefs();
  assert.ok(defs.length > 0);
  const names = defs.map((d) => d.name);
  for (const n of names) assert.ok(ALLOWED.includes(n), `unexpected tool ${n}`);
  assert.strictEqual(new Set(names).size, names.length, 'names must be deduped');
});

test('each def has the Responses-API function shape', () => {
  for (const d of buildDirectToolDefs()) {
    assert.strictEqual(d.type, 'function');
    assert.strictEqual(typeof d.name, 'string');
    assert.strictEqual(typeof d.description, 'string');
    assert.ok(d.parameters && typeof d.parameters === 'object');
  }
});

test('repeated calls are byte-identical (shared allowlist + per-call seen state)', () => {
  // The hoisted ALLOWED Set is shared; `seen` must remain per-call so dedup does
  // not leak. Two back-to-back calls must yield the same name list — if `seen`
  // had been hoisted too, the second call would filter everything out.
  const a = buildDirectToolDefs().map((d) => d.name);
  const b = buildDirectToolDefs().map((d) => d.name);
  assert.deepStrictEqual(a, b);
  assert.ok(b.length > 0, 'second call must not be emptied by leaked dedup state');
});
