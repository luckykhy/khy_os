'use strict';

/**
 * reduceToolPush / reduceToolResult — id-first pairing of the native tool-use
 * loop's onToolCall/onToolResult callbacks onto the streaming {tools,timeline}
 * state.
 *
 * Regression for the "hung on the wrong row" hard bug: the bridge used to pair
 * tool RESULTS to tool ROWS by tool NAME and attach to the first unresolved
 * match. Two same-name tools in one turn (two Reads, two Bashes) therefore
 * crossed results — the second tool's output rendered under the first. The loop
 * now threads the real tool_use_id, and these reducers pair on it exactly, with
 * name only as a fallback for legacy callers that supply no id.
 */

const { reduceToolPush, reduceToolResult } = require('../../src/cli/tui/hooks/useQueryBridge');

function emptyState() {
  return { text: '', tools: [], timeline: [] };
}

function resultFor(text) {
  return { text, isError: false };
}

// Find the result text attached to a tool row by id.
function rowResultText(s, id) {
  const t = s.tools.find((x) => x.id === id);
  return t && t.result ? t.result.text : undefined;
}
function timelineResultText(s, id) {
  const e = (s.timeline || []).find((x) => x.type === 'tool' && x.tool.id === id);
  return e && e.tool.result ? e.tool.result.text : undefined;
}

describe('reduceToolPush', () => {
  test('appends a tool row to both tools and timeline', () => {
    const s = reduceToolPush(emptyState(), { name: 'Read', params: { p: 'a' }, id: 'id-1', toolId: 'id-1' });
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ name: 'Read', id: 'id-1' });
    expect(s.timeline.filter((e) => e.type === 'tool')).toHaveLength(1);
  });

  test('two same-name calls with distinct ids create TWO rows (no collapse)', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: { p: 'a' }, id: 'id-1', toolId: 'id-1' });
    s = reduceToolPush(s, { name: 'Read', params: { p: 'b' }, id: 'id-2', toolId: 'id-2' });
    expect(s.tools).toHaveLength(2);
    expect(s.tools.map((t) => t.id)).toEqual(['id-1', 'id-2']);
  });

  test('de-dupes an adapter chunk already present with the same id', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'id-1', toolId: 'id-1' });
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'id-1', toolId: 'id-1' });
    expect(s.tools).toHaveLength(1);
  });

  test('without an id, de-dupes against first unresolved same-name row', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'loop-Read', toolId: undefined });
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'loop-Read', toolId: undefined });
    expect(s.tools).toHaveLength(1);
  });

  test('null state is passed through untouched', () => {
    expect(reduceToolPush(null, { name: 'Read', params: {}, id: 'x', toolId: 'x' })).toBeNull();
  });
});

describe('reduceToolResult — id pairing (the hard bug)', () => {
  test('two same-name tools, results delivered OUT OF ORDER, land on the right rows', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: { p: 'a' }, id: 'id-1', toolId: 'id-1' });
    s = reduceToolPush(s, { name: 'Read', params: { p: 'b' }, id: 'id-2', toolId: 'id-2' });

    // Result for the SECOND call arrives first.
    s = reduceToolResult(s, { name: 'Read', result: resultFor('B-output'), toolId: 'id-2' });
    s = reduceToolResult(s, { name: 'Read', result: resultFor('A-output'), toolId: 'id-1' });

    expect(rowResultText(s, 'id-1')).toBe('A-output');
    expect(rowResultText(s, 'id-2')).toBe('B-output');
    // Timeline must agree with the tools array.
    expect(timelineResultText(s, 'id-1')).toBe('A-output');
    expect(timelineResultText(s, 'id-2')).toBe('B-output');
  });

  test('result attaches to its id even when an earlier same-name row is still unresolved', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Bash', params: {}, id: 'b1', toolId: 'b1' });
    s = reduceToolPush(s, { name: 'Bash', params: {}, id: 'b2', toolId: 'b2' });
    // Resolve b2 first; b1 stays unresolved. Name-based pairing would wrongly
    // attach this to b1 (the first unresolved same-name row).
    s = reduceToolResult(s, { name: 'Bash', result: resultFor('second'), toolId: 'b2' });
    expect(rowResultText(s, 'b1')).toBeUndefined();
    expect(rowResultText(s, 'b2')).toBe('second');
  });

  test('falls back to first unresolved same-name row when the id matched nothing (race)', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Grep', params: {}, id: 'g-row', toolId: 'g-row' });
    // Result carries an id that no row has yet (result raced ahead of push).
    s = reduceToolResult(s, { name: 'Grep', result: resultFor('grep-out'), toolId: 'g-ghost' });
    expect(rowResultText(s, 'g-row')).toBe('grep-out');
  });

  test('name-only pairing still works for legacy callers without an id', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'loop-Read', toolId: undefined });
    s = reduceToolResult(s, { name: 'Read', result: resultFor('legacy'), toolId: undefined });
    expect(rowResultText(s, 'loop-Read')).toBe('legacy');
  });

  test('only the FIRST unresolved match is filled (one result, one row)', () => {
    let s = emptyState();
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'id-1', toolId: 'id-1' });
    s = reduceToolPush(s, { name: 'Read', params: {}, id: 'id-2', toolId: 'id-2' });
    s = reduceToolResult(s, { name: 'Read', result: resultFor('only-A'), toolId: 'id-1' });
    expect(rowResultText(s, 'id-1')).toBe('only-A');
    expect(rowResultText(s, 'id-2')).toBeUndefined();
  });

  test('null state is passed through untouched', () => {
    expect(reduceToolResult(null, { name: 'Read', result: resultFor('x'), toolId: 'x' })).toBeNull();
  });
});
