'use strict';

describe('resourceGuard watchdog', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('touch() extends the watchdog timeout window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));

    const resourceGuard = require('../src/services/resourceGuard');
    const onTimeout = jest.fn();
    const wd = resourceGuard.startWatchdog('ai-chat', 1000, onTimeout);

    jest.advanceTimersByTime(700);
    wd.touch();
    jest.advanceTimersByTime(700);
    expect(onTimeout).not.toHaveBeenCalled();

    jest.advanceTimersByTime(400);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    wd.done();
  });
});
