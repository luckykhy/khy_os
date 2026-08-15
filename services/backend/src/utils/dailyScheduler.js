'use strict';

const MAX_RECHECK_MS = 60 * 60 * 1000;

function nextDailyRun(now, hour, minute) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function scheduleDaily({ hour, minute, task, now = () => new Date(), setTimer = setTimeout }) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError('hour must be an integer from 0 to 23');
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError('minute must be an integer from 0 to 59');
  }
  if (typeof task !== 'function') {
    throw new TypeError('task must be a function');
  }

  let stopped = false;
  let timer = null;
  let target = nextDailyRun(now(), hour, minute);

  const arm = () => {
    if (stopped) return;
    const delay = target.getTime() - now().getTime();
    timer = setTimer(run, Math.max(0, Math.min(delay, MAX_RECHECK_MS)));
    timer.unref?.();
  };

  const run = () => {
    if (stopped) return;
    const current = now();
    if (current.getTime() < target.getTime()) {
      arm();
      return;
    }

    target = nextDailyRun(current, hour, minute);
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(arm);
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { nextDailyRun, scheduleDaily };
