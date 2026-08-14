/**
 * PromiseTimeout — wrap a promise-returning function with a deadline.
 *
 * Usage:
 *   const result = await PromiseTimeout(fetchData(), 5000);
 *   // throws 'Operation timed out after 5000ms' on expiry
 */

function PromiseTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

module.exports = { PromiseTimeout };
