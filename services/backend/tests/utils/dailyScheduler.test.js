'use strict';

const { nextDailyRun, scheduleDaily } = require('../../src/utils/dailyScheduler');

describe('dailyScheduler', () => {
  test('selects the next local wall-clock occurrence', () => {
    expect(nextDailyRun(new Date(2026, 7, 14, 1, 30), 2, 0)).toEqual(new Date(2026, 7, 14, 2, 0));
    expect(nextDailyRun(new Date(2026, 7, 14, 2, 0), 2, 0)).toEqual(new Date(2026, 7, 15, 2, 0));
  });

  test('rechecks long waits hourly and runs once at the target', async () => {
    let current = new Date(2026, 7, 14, 0, 0);
    const callbacks = [];
    const delays = [];
    const task = jest.fn();
    const handle = scheduleDaily({
      hour: 2,
      minute: 0,
      task,
      now: () => current,
      setTimer(callback, delay) {
        callbacks.push(callback);
        delays.push(delay);
        return { unref() {} };
      },
    });

    expect(delays).toEqual([60 * 60 * 1000]);
    current = new Date(2026, 7, 14, 1, 0);
    callbacks.shift()();
    expect(delays).toEqual([60 * 60 * 1000, 60 * 60 * 1000]);

    current = new Date(2026, 7, 14, 2, 0);
    callbacks.shift()();
    await Promise.resolve();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  test('validates schedule inputs', () => {
    expect(() => scheduleDaily({ hour: 24, minute: 0, task() {} })).toThrow(RangeError);
    expect(() => scheduleDaily({ hour: 2, minute: -1, task() {} })).toThrow(RangeError);
    expect(() => scheduleDaily({ hour: 2, minute: 0 })).toThrow(TypeError);
  });
});
