'use strict';

/**
 * Tests for the s13 fix: background-task completion notifications.
 *
 * Before this fix, an Agent dispatched with run_in_background ran fire-and-forget
 * and its result landed in AgentTool's private registry but was NEVER surfaced
 * back into the conversation — despite the spawn prompt promising "you will be
 * automatically notified when it completes". This wires a drain + a
 * <task_notification> formatter that the tool-use loop injects into a later turn.
 *
 * The drain/format logic is pure (operates on a plain Map / descriptors), so it
 * is fully testable without the agent runtime. We also assert AgentTool exposes
 * the collector.
 */

const assert = require('assert');

const tn = require('../src/services/query/taskNotification');
const AgentTool = require('../src/tools/AgentTool');

describe('s13 — taskNotification.drainCompletedBackgroundAgents', () => {
  test('returns terminal entries and marks them notified (one-shot)', () => {
    const reg = new Map([
      ['bg-1', { status: 'completed', result: 'all good', subagentType: 'Explore' }],
      ['bg-2', { status: 'running' }],
    ]);

    const first = tn.drainCompletedBackgroundAgents(reg);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].taskId, 'bg-1');
    assert.strictEqual(first[0].status, 'completed');
    assert.strictEqual(first[0].command, 'agent:Explore');
    assert.strictEqual(first[0].summary, 'all good');
    assert.strictEqual(reg.get('bg-1').notified, true, 'entry must be flagged notified');

    // Draining again must NOT re-emit the same completion.
    assert.deepStrictEqual(tn.drainCompletedBackgroundAgents(reg), []);
  });

  test('failed entries are drained with the error as summary', () => {
    const reg = new Map([['bg-x', { status: 'failed', error: 'boom', subagentType: 'claude' }]]);
    const out = tn.drainCompletedBackgroundAgents(reg);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].status, 'failed');
    assert.strictEqual(out[0].summary, 'boom');
  });

  test('still-running entries are never drained', () => {
    const reg = new Map([['bg-r', { status: 'running' }]]);
    assert.deepStrictEqual(tn.drainCompletedBackgroundAgents(reg), []);
    assert.ok(!reg.get('bg-r').notified);
  });

  test('the entry stays in the registry after notifying (lookup survives)', () => {
    const reg = new Map([['bg-1', { status: 'completed', result: 'x' }]]);
    tn.drainCompletedBackgroundAgents(reg);
    assert.ok(reg.has('bg-1'), 'drain must not delete the entry, only flag it');
  });

  test('a non-map / empty registry yields an empty array', () => {
    assert.deepStrictEqual(tn.drainCompletedBackgroundAgents(null), []);
    assert.deepStrictEqual(tn.drainCompletedBackgroundAgents(undefined), []);
    assert.deepStrictEqual(tn.drainCompletedBackgroundAgents(new Map()), []);
  });

  test('multiple completions drain together', () => {
    const reg = new Map([
      ['bg-1', { status: 'completed', result: 'a' }],
      ['bg-2', { status: 'completed', result: 'b' }],
    ]);
    const out = tn.drainCompletedBackgroundAgents(reg);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map(o => o.taskId).sort(), ['bg-1', 'bg-2']);
  });
});

describe('s13 — taskNotification.summarize', () => {
  test('reads structured result fields in priority order', () => {
    assert.strictEqual(tn.summarize({ status: 'completed', result: { summary: 's', reply: 'r' } }), 's');
    assert.strictEqual(tn.summarize({ status: 'completed', result: { reply: 'r' } }), 'r');
    assert.strictEqual(tn.summarize({ status: 'completed', result: { output: 'o' } }), 'o');
  });

  test('falls back to JSON for an opaque object result', () => {
    const s = tn.summarize({ status: 'completed', result: { foo: 1 } });
    assert.ok(s.includes('foo'));
  });

  test('truncates to SUMMARY_MAX chars', () => {
    const big = 'z'.repeat(tn.SUMMARY_MAX + 50);
    assert.strictEqual(tn.summarize({ status: 'completed', result: big }).length, tn.SUMMARY_MAX);
  });
});

describe('s13 — taskNotification formatting', () => {
  test('formatTaskNotification emits a well-formed <task_notification> block', () => {
    const block = tn.formatTaskNotification({
      taskId: 'bg-1', status: 'completed', command: 'agent:Explore', summary: 'done',
    });
    assert.ok(block.startsWith('<task_notification>'));
    assert.ok(block.includes('<task_id>bg-1</task_id>'));
    assert.ok(block.includes('<status>completed</status>'));
    assert.ok(block.includes('<command>agent:Explore</command>'));
    assert.ok(block.includes('<summary>done</summary>'));
    assert.ok(block.trim().endsWith('</task_notification>'));
  });

  test('escapes XML-sensitive characters in the summary', () => {
    const block = tn.formatTaskNotification({
      taskId: 'bg-1', status: 'completed', summary: 'a < b && c > d',
    });
    assert.ok(block.includes('a &lt; b &amp;&amp; c &gt; d'));
    assert.ok(!block.includes('a < b'), 'raw < must be escaped');
  });

  test('buildTaskNotifications joins multiple blocks and is empty for none', () => {
    assert.strictEqual(tn.buildTaskNotifications([]), '');
    assert.strictEqual(tn.buildTaskNotifications(null), '');
    const joined = tn.buildTaskNotifications([
      { taskId: 'bg-1', status: 'completed' },
      { taskId: 'bg-2', status: 'failed' },
    ]);
    assert.strictEqual((joined.match(/<task_notification>/g) || []).length, 2);
  });

  test('does NOT reuse a tool_use_id — task_id is the fresh background id', () => {
    // The notification carries the bg-* id, never the original tool call id.
    const block = tn.formatTaskNotification({ taskId: 'bg-1', status: 'completed' });
    assert.ok(block.includes('<task_id>bg-1</task_id>'));
    assert.ok(!/tool_use/i.test(block));
  });
});

describe('s13 — AgentTool surface', () => {
  test('exposes collectBackgroundResults returning an array', () => {
    assert.strictEqual(typeof AgentTool.collectBackgroundResults, 'function');
    assert.ok(Array.isArray(AgentTool.collectBackgroundResults()));
  });
});
