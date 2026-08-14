'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const mockBoulderDir = path.join(os.tmpdir(), `boulder-resume-${process.pid}-${Date.now()}`);
jest.mock('../../src/utils/dataHome', () => ({
  getDataDir: (...segments) => {
    const dir = require('path').join(mockBoulderDir, ...segments);
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
  },
}));

const {
  saveBoulderState,
  loadBoulderState,
  loadBoulderStateByTaskId,
  listResumableTasks,
  markBoulderInterrupted,
  rearmForResume,
  clearBoulderState,
} = require('../../src/services/boulderState');

afterAll(() => {
  try { fs.rmSync(mockBoulderDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('boulderState taskId resume', () => {
  const cwdA = '/home/user/proj-a';
  const cwdB = '/home/user/proj-b';

  afterEach(() => {
    clearBoulderState(cwdA);
    clearBoulderState(cwdB);
  });

  test('loadBoulderStateByTaskId retrieves the record across cwd and includes cwd', () => {
    saveBoulderState(cwdA, { taskId: 'task-AAA', userMessage: 'build feature A', iterations: 3, status: 'in_progress' });
    const loaded = loadBoulderStateByTaskId('task-AAA');
    expect(loaded).toBeTruthy();
    expect(loaded.taskId).toBe('task-AAA');
    expect(loaded.cwd).toBe(cwdA);
    expect(loaded.iterations).toBe(3);
  });

  test('loadBoulderStateByTaskId returns null for unknown id', () => {
    expect(loadBoulderStateByTaskId('does-not-exist')).toBeNull();
    expect(loadBoulderStateByTaskId('')).toBeNull();
  });

  test('markBoulderInterrupted flips status, preserves taskId, and survives auto-resume gate', () => {
    saveBoulderState(cwdA, { taskId: 'task-INT', userMessage: 'long running task', iterations: 7, status: 'in_progress' });
    const id = markBoulderInterrupted(cwdA, { interruptReason: 'Ctrl+C' });
    expect(id).toBe('task-INT');

    const loaded = loadBoulderState(cwdA);
    expect(loaded.status).toBe('interrupted');
    expect(loaded.interruptReason).toBe('Ctrl+C');
    expect(loaded.iterations).toBe(7); // preserved
  });

  test('markBoulderInterrupted is a no-op when no checkpoint exists', () => {
    expect(markBoulderInterrupted(cwdB)).toBeNull();
  });

  test('listResumableTasks reports in_progress and interrupted across cwds, newest first', () => {
    saveBoulderState(cwdA, { taskId: 'task-A', userMessage: 'task in A', iterations: 1, status: 'in_progress' });
    saveBoulderState(cwdB, { taskId: 'task-B', userMessage: 'task in B', iterations: 2, status: 'in_progress' });
    markBoulderInterrupted(cwdB, { interruptReason: 'Ctrl+C' });

    const list = listResumableTasks();
    const ids = list.map(t => t.taskId);
    expect(ids).toContain('task-A');
    expect(ids).toContain('task-B');

    const b = list.find(t => t.taskId === 'task-B');
    expect(b.status).toBe('interrupted');
    expect(b.cwd).toBe(cwdB);
    expect(b.userMessage).toBe('task in B');
  });

  test('listResumableTasks excludes completed checkpoints', () => {
    saveBoulderState(cwdA, { taskId: 'task-done', userMessage: 'finished', iterations: 9, status: 'completed' });
    const list = listResumableTasks();
    expect(list.find(t => t.taskId === 'task-done')).toBeUndefined();
  });

  test('rearmForResume flips an interrupted checkpoint back to in_progress so auto-resume can continue it', () => {
    saveBoulderState(cwdA, { taskId: 'task-RE', userMessage: 'resume me', iterations: 4, status: 'in_progress' });
    markBoulderInterrupted(cwdA, { interruptReason: 'Ctrl+C' });
    expect(loadBoulderState(cwdA).status).toBe('interrupted');

    const r = rearmForResume('task-RE');
    expect(r).toBeTruthy();
    expect(r.taskId).toBe('task-RE');
    expect(r.cwd).toBe(cwdA);
    expect(r.userMessage).toBe('resume me');
    expect(r.iterations).toBe(4);
    expect(r.status).toBe('in_progress');

    // The on-disk record is now re-armed for the live auto-resume gate.
    expect(loadBoulderState(cwdA).status).toBe('in_progress');
  });

  test('rearmForResume returns null for unknown id and completed tasks', () => {
    expect(rearmForResume('nope')).toBeNull();
    saveBoulderState(cwdB, { taskId: 'task-fin', userMessage: 'done', iterations: 2, status: 'completed' });
    expect(rearmForResume('task-fin')).toBeNull();
  });
});
