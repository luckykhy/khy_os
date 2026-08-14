/**
 * AES-GCM encrypt/decrypt for localStorage data.
 * Protects against casual inspection of stored secrets.
 * Not a substitute for server-side key management.
 */

const KEY_STORAGE = 'khy_quant_local_ek'

async function getOrCreateKey() {
  let raw = localStorage.getItem(KEY_STORAGE)
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    raw = btoa(String.fromCharCode(...bytes))
    localStorage.setItem(KEY_STORAGE, raw)
  }
  const keyData = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptForStorage(data) {
  const key = await getOrCreateKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(JSON.stringify(data))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return btoa(String.fromCharCode(...iv)) + '.' + btoa(String.fromCharCode(...new Uint8Array(ct)))
}

export async function decryptFromStorage(stored) {
  const key = await getOrCreateKey()
  const [ivB64, ctB64] = stored.split('.')
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0))
  const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return JSON.parse(new TextDecoder().decode(plain))
}
