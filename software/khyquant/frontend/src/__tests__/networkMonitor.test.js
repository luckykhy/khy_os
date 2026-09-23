/**
 * networkMonitor.test.js — locks the NetworkMonitor singleton's observable
 * contract: the 3-consecutive-failure threshold that triggers returnToSplash,
 * the failure-counter reset on handleOnline, the getStatus() reporting shape,
 * and getSplashUrl()'s file:-protocol branch. The exported default is one
 * shared instance, so each case resets its counters directly (the module only
 * exposes the singleton, not a factory).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import networkMonitor from '../utils/networkMonitor.js'

function resetCounters() {
  // The singleton persists across tests; clear its mutable state directly.
  networkMonitor.stopMonitoring()
  networkMonitor.failureCount = 0
  networkMonitor.lastSuccessTime = Date.now()
}

describe('networkMonitor', () => {
  beforeEach(() => {
    resetCounters()
  })

  it('new monitor reports not-monitoring with a fresh success time', () => {
    const st = networkMonitor.getStatus()
    expect(st.isMonitoring).toBe(false)
    expect(st.failureCount).toBe(0)
    expect(st.maxFailures).toBe(3)
    expect(st.timeSinceLastSuccess).toBeGreaterThanOrEqual(0)
  })

  it('stopMonitoring is a no-op when not already monitoring', () => {
    expect(() => networkMonitor.stopMonitoring()).not.toThrow()
  })

  it('handleOnline resets the failure counter and re-checks', () => {
    networkMonitor.failureCount = 2
    const checkSpy = vi
      .spyOn(networkMonitor, 'checkConnection')
      .mockImplementation(async () => {})
    networkMonitor.handleOnline()
    expect(networkMonitor.failureCount).toBe(0)
    expect(checkSpy).toHaveBeenCalled()
    checkSpy.mockRestore()
  })

  it('three consecutive failures trigger returnToSplash', () => {
    const splashSpy = vi
      .spyOn(networkMonitor, 'returnToSplash')
      .mockImplementation(() => {})
    networkMonitor.handleOffline() // 1
    expect(networkMonitor.failureCount).toBe(1)
    networkMonitor.handleOffline() // 2
    expect(networkMonitor.failureCount).toBe(2)
    expect(splashSpy).not.toHaveBeenCalled()
    networkMonitor.handleOffline() // 3 → threshold
    expect(splashSpy).toHaveBeenCalled()
    splashSpy.mockRestore()
  })

  it('getSplashUrl returns the file-relative splash for the file: protocol', () => {
    vi.stubGlobal('window', { ...window, location: { ...window.location, protocol: 'file:' } })
    try {
      expect(networkMonitor.getSplashUrl()).toBe('splash-beautiful.html')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('getSplashUrl returns the root path when not on the file: protocol', () => {
    expect(networkMonitor.getSplashUrl()).toBe('/')
  })

  it('handleOffline with returnToSplash stubbed just increments the counter', () => {
    vi.spyOn(networkMonitor, 'returnToSplash').mockImplementation(() => {})
    networkMonitor.failureCount = 2
    networkMonitor.handleOffline() // 3rd failure
    expect(networkMonitor.failureCount).toBe(3)
    vi.restoreAllMocks()
  })
})
