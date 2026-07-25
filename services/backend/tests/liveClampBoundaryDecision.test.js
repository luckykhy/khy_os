'use strict';

const assert = require('node:assert');
const test = require('node:test');

const App = require('../src/cli/tui/ink-components/App');

test('_liveClampBoundaryDecision: same running turn samples normally', () => {
  assert.deepStrictEqual(
    App._liveClampBoundaryDecision(123, 123, 0),
    { changed: false, reset: false, sample: true },
  );
});

test('_liveClampBoundaryDecision: new turn with zero reserve samples on the first frame', () => {
  assert.deepStrictEqual(
    App._liveClampBoundaryDecision(null, 456, 0),
    { changed: true, reset: false, sample: true },
  );
});

test('_liveClampBoundaryDecision: new turn with leftover reserve resets first and skips sampling', () => {
  assert.deepStrictEqual(
    App._liveClampBoundaryDecision(111, 222, 3),
    { changed: true, reset: true, sample: false },
  );
});

test('_liveClampBoundaryDecision: turn end with zero reserve does not sample', () => {
  assert.deepStrictEqual(
    App._liveClampBoundaryDecision(456, null, 0),
    { changed: true, reset: false, sample: false },
  );
});

test('_liveClampBoundaryDecision: turn end with leftover reserve resets once and stops sampling', () => {
  assert.deepStrictEqual(
    App._liveClampBoundaryDecision(456, null, 2),
    { changed: true, reset: true, sample: false },
  );
});
