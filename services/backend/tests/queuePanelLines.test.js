'use strict';

/**
 * Tests for the "send while busy" queue panel rendering in the ink TUI.
 *
 * The queue used to surface only as a count ("N 条排队"). Users could not see
 * WHICH message was waiting, nor pull an unsent one back to edit. App now
 * renders each queued message verbatim via `_queuePanelLines`, tagging the last
 * (most-recently queued) one with "↑ 取回" — the entry the up-arrow restore pops.
 */

const assert = require('assert');

const App = require('../src/cli/tui/ink-components/App');

describe('_queuePanelLines — queued message visibility', () => {
  test('empty queue → no rows', () => {
    assert.deepStrictEqual(App._queuePanelLines([]), []);
    assert.deepStrictEqual(App._queuePanelLines(undefined), []);
  });

  test('single item: shows verbatim text, tagged as retrievable, with summary', () => {
    const lines = App._queuePanelLines(['fix the login bug']);
    assert.strictEqual(lines.length, 2); // item row + summary
    assert.strictEqual(lines[0], '  1. fix the login bug  ↑ 取回');
    assert.ok(lines[1].includes('1 条排队'));
    assert.ok(lines[1].includes('↑ 取回最后一条'));
  });

  test('only the LAST item is tagged with ↑ 取回', () => {
    const lines = App._queuePanelLines(['first', 'second', 'third']);
    assert.ok(lines[0].endsWith('first'), lines[0]);
    assert.ok(lines[1].endsWith('second'), lines[1]);
    assert.ok(lines[2].endsWith('third  ↑ 取回'), lines[2]);
    assert.ok(lines[3].includes('3 条排队'));
  });

  test('multiline / extra whitespace is collapsed to a single line', () => {
    const [row] = App._queuePanelLines(['line one\n   line two\t\tmore']);
    assert.strictEqual(row, '  1. line one line two more  ↑ 取回');
  });

  test('long text is truncated with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const [row] = App._queuePanelLines([long]);
    assert.ok(row.includes('…'), row);
    assert.ok(row.includes('x'.repeat(56)), row);
    assert.ok(!row.includes('x'.repeat(57)), 'should cap at 56 chars before ellipsis');
  });

  test('more than 5 items: shows first 5 + overflow line + summary', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const lines = App._queuePanelLines(items);
    // 5 item rows + overflow row + summary row
    assert.strictEqual(lines.length, 7);
    assert.ok(lines[5].includes('还有 2 条'), lines[5]);
    assert.ok(lines[6].includes('7 条排队'), lines[6]);
    // ↑ 取回 tag never appears when the last item is past the shown window
    assert.ok(!lines.slice(0, 5).some((l) => l.includes('↑ 取回')), 'no retrieve tag in truncated view');
  });
});
