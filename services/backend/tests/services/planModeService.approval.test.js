'use strict';

const planModeService = require('../../src/services/planModeService');

async function advanceBy(ms) {
  if (typeof jest.advanceTimersByTimeAsync === 'function') {
    await jest.advanceTimersByTimeAsync(ms);
    return;
  }
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
}

function createRendererStub() {
  return {
    TaskPlanTracker: class TaskPlanTracker {
      constructor() {
        this.items = [];
      }
      addTask(text) {
        this.items.push(text);
      }
      render() {}
    },
  };
}

describe('planModeService presentForApproval auto-approve policy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    planModeService.reset();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('does not auto-approve by default without explicit env', async () => {
    jest.useFakeTimers();
    delete process.env.KHY_PLAN_AUTO_APPROVE_MS;

    const plan = {
      steps: [{ id: 1, description: 'collect logs', status: 'pending' }],
      dataNeeds: [],
      risks: [],
    };
    const renderer = createRendererStub();
    const question = jest.fn();
    const rl = { question };
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const approvalPromise = planModeService.presentForApproval(plan, renderer, rl);
    expect(question).toHaveBeenCalledTimes(1);

    let settled = false;
    approvalPromise.then(() => { settled = true; });

    await advanceBy(25_000);
    expect(settled).toBe(false);

    const callback = question.mock.calls[0][1];
    callback('n');
    const approval = await approvalPromise;
    expect(approval).toEqual({ approved: false, modifications: [] });
  });

  test('keeps opt-in auto-approve when env timeout is configured', async () => {
    jest.useFakeTimers();
    process.env.KHY_PLAN_AUTO_APPROVE_MS = '50';

    const plan = {
      steps: [{ id: 1, description: 'collect logs', status: 'pending' }],
      dataNeeds: [],
      risks: [],
    };
    const renderer = createRendererStub();
    const rl = { question: jest.fn() };
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const approvalPromise = planModeService.presentForApproval(plan, renderer, rl);
    await advanceBy(60);
    const approval = await approvalPromise;

    expect(approval).toEqual({ approved: true, modifications: [] });
  });
});
