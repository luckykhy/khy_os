/**
 * performanceOptimizer.js — Throttle, debounce, and hardware acceleration utilities
 *
 * Used by SimpleTradingInterface for chart performance optimization.
 */

/**
 * Throttle a function — ensures it is called at most once per `delay` ms
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function throttleData(fn, delay = 100) {
  let lastCall = 0
  return function (...args) {
    const now = Date.now()
    if (now - lastCall >= delay) {
      lastCall = now
      return fn.apply(this, args)
    }
  }
}

/**
 * Debounce a function — calls it after `delay` ms of inactivity
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay = 300) {
  let timer = null
  return function (...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), delay)
  }
}

/**
 * Enable hardware acceleration on a DOM element
 * @param {HTMLElement} el
 */
export function enableHardwareAcceleration(el) {
  if (!el) return
  el.style.transform = 'translateZ(0)'
  el.style.backfaceVisibility = 'hidden'
  el.style.willChange = 'transform'
}
