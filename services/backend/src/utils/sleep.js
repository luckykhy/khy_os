/**
 * Promise-based sleep helper.
 *
 * @param {number} ms - Delay in milliseconds.
 * @param {object|boolean} [options] - Sleep options or a boolean `unref` shorthand.
 * @param {boolean} [options.unref=false] - Unref timer so it won't keep the event loop alive.
 * @example
 * await sleep(500);
 * await sleep(1000, { unref: true });
 * @returns {Promise<void>}
 */
function sleep(ms, options = {}) {
  const normalizedOptions = typeof options === 'boolean' ? { unref: options } : (options || {});
  const { unref = false } = normalizedOptions;

  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new TypeError('ms must be a non-negative finite number'));
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

module.exports = sleep;
