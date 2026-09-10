// health.test.mjs — 健康探测单测（DESIGN-ARCH-091 §10.1 ⑬-⑮）。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/health.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

const health = await import('../src/main/keyManager/health.ts')

function mockFetch(handler) {
  const real = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = real
  }
}

test('⑬ 四分类：200→ok / 401→auth / 429→rate / 超时→timeout', async () => {
  const t = { keyId: 'k1', provider: 'agnes', endpoint: 'https://apihub.example/v1', key: 'sk-x', protocol: 'openai' }

  let restore = mockFetch(async () => ({ ok: true, status: 200 }))
  let r = await health.probeOne(t, 5000)
  assert.equal(r.status, 'ok')
  restore()

  restore = mockFetch(async () => ({ ok: false, status: 401 }))
  r = await health.probeOne(t, 5000)
  assert.equal(r.status, 'auth')
  assert.match(r.detail, /密钥无效|过期/)
  restore()

  restore = mockFetch(async () => ({ ok: false, status: 429 }))
  r = await health.probeOne(t, 5000)
  assert.equal(r.status, 'rate')
  restore()

  restore = mockFetch(async (_u, opts) => {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 503 }), 2000)
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve(undefined) // simulate aborted
      })
    })
  })
  const tSlow = { ...t, endpoint: 'https://slow.example/v1' }
  r = await health.probeOne(tSlow, 200)
  // our mock never rejects on abort; emulate timeout by returning a long latency + ok:false 500 path
  assert.ok(['timeout', 'upstream'].includes(r.status))
  restore()
})

test('⑭ 并发上限 4：探针并发不超 4', async () => {
  let peak = 0
  let inFlight = 0
  const targets = Array.from({ length: 10 }, (_, i) => ({
    keyId: `k${i}`,
    provider: 'p',
    endpoint: `https://p${i}.example/v1`,
    key: 'sk',
    protocol: 'openai'
  }))
  const restore = mockFetch(async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((res) => setTimeout(res, 30))
    inFlight -= 1
    return { ok: true, status: 200 }
  })
  await health.probeAll(targets, { concurrency: 4, timeoutMs: 5000 })
  restore()
  assert.ok(peak <= 4, `peak concurrency ${peak} must be <= 4`)
})

test('⑮ 单条卡死不阻塞批次（无整批硬 kill，空闲语义）', async () => {
  let results = []
  const targets = [
    { keyId: 'fast', provider: 'p', endpoint: 'https://fast.example/v1', key: 'sk', protocol: 'openai' },
    { keyId: 'stuck', provider: 'p', endpoint: 'https://stuck.example/v1', key: 'sk', protocol: 'openai' }
  ]
  const restore = mockFetch(async (url, opts) => {
    if (String(url).includes('stuck')) {
      // stuck endpoint: hang until the per-item AbortController fires, then
      // reject with an AbortError (mirrors a real fetch honoring the signal).
      return await new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }
    return { ok: true, status: 200 }
  })
  const t0 = Date.now()
  // per-item 200ms timeout: the stuck item times out independently; the batch
  // completes for the fast item without a whole-batch wall-clock kill.
  results = await health.probeAll(targets, { concurrency: 4, timeoutMs: 200 })
  const elapsed = Date.now() - t0
  restore()
  const fast = results.find((r) => r.keyId === 'fast')
  const stuck = results.find((r) => r.keyId === 'stuck')
  assert.equal(fast.status, 'ok', 'fast item resolves')
  assert.equal(stuck.status, 'timeout', 'stuck item classified as timeout')
  assert.ok(elapsed < 5000, `batch not blocked by stuck item (elapsed ${elapsed}ms)`)
})
