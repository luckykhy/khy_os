'use strict';

const { createTaskMindMap, createIdleTaskMindMap, extractPlanStepsFromText } = require('../../src/cli/taskMindMap');

describe('taskMindMap', () => {
  test('creates default map with current and next step', () => {
    const map = createTaskMindMap({ title: 'Fix login bug' });
    const snap = map.getSnapshot();

    expect(snap.steps.length).toBeGreaterThanOrEqual(5);
    expect(snap.currentIndex).toBe(0);
    expect(snap.nextIndex).toBe(1);
    expect(snap.steps[0].status).toBe('running');
  });

  test('extracts numbered plan steps', () => {
    const text = [
      'Plan:',
      '1. Inspect router flow',
      '2. Patch handler logic',
      '3. Run tests',
    ].join('\n');
    const steps = extractPlanStepsFromText(text);
    expect(steps).toEqual([
      'Inspect router flow',
      'Patch handler logic',
      'Run tests',
    ]);
  });

  test('tracks tool call and result transitions', () => {
    const map = createTaskMindMap({ title: 'Update CLI output' });
    map.markToolCall('read_file', { path: 'backend/src/cli/repl.js' });
    let snap = map.getSnapshot();
    expect(snap.steps[1].status).toBe('running');

    map.markToolResult('read_file', true, 'Read 200 lines');
    snap = map.getSnapshot();
    expect(snap.steps[1].note).toContain('Read 200 lines');

    map.markToolCall('edit_file', { file_path: 'backend/src/cli/repl.js' });
    snap = map.getSnapshot();
    expect(snap.steps[2].status).toBe('running');
  });

  test('builds concise steer payload for AI', () => {
    const map = createTaskMindMap({ title: 'Implement command' });
    map.markToolCall('read_file', { path: 'backend/src/cli/router.js' });
    const payload = map.buildAiSteerMessage();
    expect(payload).toContain('[Task Mind Map State]');
    expect(payload).toContain('Current:');
    expect(payload).toContain('Next:');
    expect(payload).toContain('Progress:');
  });

  test('marks completion state', () => {
    const map = createTaskMindMap({ title: 'Deliver patch' });
    map.complete({ success: true, reason: 'done' });
    const snap = map.getSnapshot();
    const doneCount = snap.steps.filter(step => step.status === 'done').length;
    expect(doneCount).toBeGreaterThanOrEqual(1);
    expect(snap.nextIndex).toBe(-1);
  });

  test('idle map stays at start node and exposes idle mode to AI steer payload', () => {
    const map = createIdleTaskMindMap();
    const snap = map.getSnapshot();
    expect(snap.mode).toBe('idle');
    expect(snap.title).toContain('Start Node');
    expect(snap.currentIndex).toBe(0);
    expect(snap.steps[0].status).toBe('running');
    expect(snap.steps[0].note).toContain('No active task');

    const payload = map.buildAiSteerMessage();
    expect(payload).toContain('Mode: idle');
    expect(payload).toContain('stay at start node');
  });
});
