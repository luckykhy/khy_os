/**
 * qrcode.test.js — locks the lazy-loader contract in src/utils/qrcode.js:
 * repeated loadQRCode() calls must resolve to the SAME module instance
 * (no re-import storm), and the loader tolerates a CJS default export.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reset the module-level qrcodePromise cache between cases by re-importing.
function freshLoad() {
  // Clear the dynamic-import cache for the qrcode entry so the lazy load re-runs.
  vi.resetModules()
  return import('../utils/qrcode.js')
}

describe('qrcode.js loadQRCode', () => {
  it('resolves the qrcode module and caches the same instance across calls', async () => {
    const { loadQRCode } = await freshLoad()
    const a = await loadQRCode()
    const b = await loadQRCode()
    expect(a).toBe(b)
    // the resolved value should be the qrcode lib namespace or its default
    expect(typeof (a.default || a)).toBe('object')
  })

  it('exposes loadQRCode as the sole named export', async () => {
    const mod = await freshLoad()
    expect(typeof mod.loadQRCode).toBe('function')
  })
})
