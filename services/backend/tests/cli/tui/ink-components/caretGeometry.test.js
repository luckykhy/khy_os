'use strict';
// QUARANTINE: the original tests in this file were lost to encoding corruption
// (UTF-8 CJK mojibake destroyed the string literals and the file stopped
// parsing). No local recovery source was available. This is an intentional
// empty shell so the suite stays parseable; the coverage it once provided
// is recorded as debt in tests/DEBT.md.
//
// The shell used jest's describe/it/expect globals, which are undefined under
// `node --test` — the placeholder itself failed every test:node run. Ported to
// node:test style; jest.config's node:test marker detection now moves this file
// out of jest, so both runners see one trivially-passing placeholder.

const assert = require('node:assert');
const { describe, it } = require('node:test');

describe("tests/cli/tui/ink-components/caretGeometry - quarantined, no tests", () => {
  it('is a known-loss placeholder', () => {
    assert.ok(true);
  });
});
