/**
 * performanceOptimizer.test.js — locks the throttle/debounce/hw-accel contract
 * in src/utils/performanceOptimizer.js. Throttle is call-based (leading edge,
 * no trailing), debounce is inactivity-based; both must preserve `this` and
 * forward the final args.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { throttleData, debounce, enableHardwareAcceleration } from '../utils/performanceOptimizer.js'

describe('performanceOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('throttleData allows the first call and suppresses calls inside the delay window', () => {
    const fn = vi.fn()
    const throttled = throttleData(fn, 100)
    throttled('a')
    expect(fn).toHaveBeenCalledTimes(1)
    throttled('b') // within 100ms of the first call
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    throttled('c') // now allowed
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('c')
  })

  it('throttleData uses a real Date.now clock (advancing real time opens the window)', () => {
    const fn = vi.fn()
    const throttled = throttleData(fn, 20)
    throttled(1)
    vi.advanceTimersByTime(30) // advance the fake clock past the 20ms window
    throttled(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('debounce delays the call until inactivity and forwards the last args + this', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced('x')
    debounced('y')
    debounced('z')
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('z')
  })

  it('debounce preserves the caller `this`', () => {
    let seenThis = null
    const fn = function () {
      seenThis = this
    }
    const ctx = { marker: true }
    const debounced = debounce(fn, 10)
    debounced.call(ctx, 'v')
    vi.advanceTimersByTime(10)
    expect(seenThis).toBe(ctx)
  })

  it('enableHardwareAcceleration sets the transform-gpu layer styles and no-ops on falsy el', () => {
    const el = document.createElement('div')
    enableHardwareAcceleration(el)
    expect(el.style.transform).toBe('translateZ(0)')
    expect(el.style.backfaceVisibility).toBe('hidden')
    expect(el.style.willChange).toBe('transform')
    // falsy element is a safe no-op
    expect(() => enableHardwareAcceleration(null)).not.toThrow()
  })
})
