/**
 * localEncrypt.test.js — locks the AES-GCM localStorage round-trip contract:
 * encrypt → decrypt returns the original object; the stored string is
 * base64(iv).base64(ciphertext) and NOT the plaintext; key is created once
 * and reused across calls.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { encryptForStorage, decryptFromStorage } from '../utils/localEncrypt.js'

// jsdom ships without WebCrypto; wire a real SubtleCrypto when present.
function ensureCrypto() {
  if (typeof globalThis.crypto?.subtle !== 'undefined') return
  const { webcrypto } = require('node:crypto')
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

describe('localEncrypt', () => {
  beforeEach(() => {
    ensureCrypto()
    localStorage.clear()
  })

  it('round-trips an object through encrypt/decrypt', async () => {
    const secret = { token: 'abc123', meta: { n: 42 } }
    const stored = await encryptForStorage(secret)
    const back = await decryptFromStorage(stored)
    expect(back).toEqual(secret)
  })

  it('stored value is base64(iv).base64(ct) and does not contain the plaintext', async () => {
    const stored = await encryptForStorage({ token: 'SUPERSECRET' })
    expect(stored).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/)
    expect(stored).not.toContain('SUPERSECRET')
  })

  it('a fresh key is created on first use and persists', async () => {
    await encryptForStorage({ a: 1 })
    const key = localStorage.getItem('khy_quant_local_ek')
    expect(key).toBeTruthy()
    // a second call reuses the same key (no re-randomisation)
    const key2 = localStorage.getItem('khy_quant_local_ek')
    expect(key2).toBe(key)
  })

  it('decrypt of a corrupted ciphertext rejects', async () => {
    await encryptForStorage({ a: 1 })
    await expect(decryptFromStorage('AAAA.CCCC')).rejects.toThrow()
  })
})
