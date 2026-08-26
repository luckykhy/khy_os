const { clampRetryRounds } = require('../constants/retryBudget');

/**
 * Retry a function with exponential backoff.
 *
 * 注意 maxRetries 数的是**额外**重试次数,总轮次 = maxRetries + 1;总轮次受
 * constants/retryBudget 的 MAX_RETRY_ROUNDS 封顶(只封顶不抬升)。
 *
 * @param {Function} fn - Async function to retry
 * @param {number} [maxRetries=3] - Maximum number of retries (总轮次上界 MAX_RETRY_ROUNDS)
 * @param {number} [baseDelay=1000] - Initial delay in milliseconds (doubles each retry)
 * @returns {Promise<*>} Result of fn()
 */
async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  let delay = baseDelay;
  // 总轮次(含首次)封顶:maxRetries 数的是额外次数,故先 +1 过闸再 -1 还原。
  const retries = clampRetryRounds(Number(maxRetries) + 1, 4) - 1;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        if (t.unref) {
          t.unref();
        }
      });
      delay *= 2;
    }
  }
}

module.exports = retry;
