'use strict';

/**
 * Tests for the in_progress task activeForm reaching the TUI spinner status line.
 *
 * Regression guard: activeForm used to be persisted everywhere but consumed
 * nowhere (write-only). The ink TUI now composes its spinner label from
 * `_getStatusLabel(status, _taskActivity())`, so the present-continuous
 * activeForm of the running V2 task ("Fixing auth bug") surfaces live in the
 * status line — CC parity.
 */

const assert = require('assert');

const App = require('../src/cli/tui/ink-components/App');
const taskStore = require('../src/tools/_taskStore');

describe('_getStatusLabel — activity composition', () => {
  test('no activity → static status label', () => {
    assert.strictEqual(App._getStatusLabel('tool', ''), '执行工具…');
    assert.strictEqual(App._getStatusLabel('thinking'), '思考中…');
  });

  test('activity is appended to the base label', () => {
    assert.strictEqual(
      App._getStatusLabel('tool', 'Fixing auth bug'),
      '执行工具… · Fixing auth bug'
    );
  });

  test('whitespace-only activity is ignored', () => {
    assert.strictEqual(App._getStatusLabel('streaming', '   '), '生成中…');
  });

  test('unknown status falls back to 思考中…', () => {
    assert.strictEqual(App._getStatusLabel('weird', 'Doing X'), '思考中… · Doing X');
  });
});

describe('_taskActivity — live read from the task store', () => {
  function freshId() {
    return 'spin-test-' + (freshId._n = (freshId._n || 0) + 1);
  }

  afterEach(() => { try { taskStore.clear(); } catch { /* ignore */ } });

  test('returns "" when nothing is running', () => {
    assert.strictEqual(App._taskActivity(), '');
  });

  test('returns the in_progress task activeForm', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'Fix auth bug', activeForm: 'Fixing auth bug', status: 'pending' });
    taskStore.update(id, { status: 'in_progress' });
    assert.strictEqual(App._taskActivity(), 'Fixing auth bug');
  });

  test('end-to-end: running task surfaces in the composed spinner label', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'Run tests', activeForm: 'Running tests', status: 'pending' });
    taskStore.update(id, { status: 'in_progress' });
    const label = App._getStatusLabel('tool', App._taskActivity());
    assert.strictEqual(label, '执行工具… · Running tests');
  });
});

describe('_liveActivity — real current event from live turn state', () => {
  test('running tool (last unresolved) → concrete narration', () => {
    const streaming = {
      tools: [
        { name: 'read', input: { file_path: '/a/done.js' }, result: { ok: true } },
        { name: 'grep', input: { pattern: 'foo', path: '/x/khy_os' } }, // no result → running
      ],
    };
    assert.strictEqual(
      App._liveActivity('tool', streaming, ''),
      '正在 khy_os 里搜索 "foo"'
    );
  });

  test('thinking phase → tail reasoning clause', () => {
    const streaming = { thinking: '先看一遍。让我检查网关适配器的处理逻辑' };
    assert.strictEqual(
      App._liveActivity('thinking', streaming, ''),
      '让我检查网关适配器的处理逻辑'
    );
  });

  test('no running tool → gateway detail surfaces (the stall message)', () => {
    assert.strictEqual(App._liveActivity('request', { tools: [] }, '等待模型响应中'), '等待模型响应中');
  });

  test('null streaming is safe', () => {
    assert.strictEqual(App._liveActivity('thinking', null, ''), '');
  });
});
