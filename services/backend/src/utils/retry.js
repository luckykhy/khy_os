/**
 * Retry a function with exponential backoff.
 *
 * @param {Function} fn - Async function to retry
 * @param {number} [maxRetries=3] - Maximum number of retries
 * @param {number} [baseDelay=1000] - Initial delay in milliseconds (doubles each retry)
 * @returns {Promise<*>} Result of fn()
 */
async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  let delay = baseDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        if (t.unref) t.unref();
      });
      delay *= 2;
    }
  }
}

module.exports = retry;