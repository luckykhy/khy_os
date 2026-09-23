/**
 * useStreamChat.test.js — locks the SSE stream composable contract:
 * per-event parsing (start/chunk/thinking/status/heartbeat/done/error),
 * HTTP failure handling, and AbortController-based cancellation.
 * If the SSE line-buffering or event dispatch rules drift, this goes red first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStreamChat } from '../composables/useStreamChat.js'

// Stub the api base so getApiBaseUrl() never touches real config/network.
vi.mock('../config/api.js', () => ({
  getApiBaseUrl: () => 'http://mock-host/api',
}))

// A minimal readable-body fake for Response.
function makeSseBody(frames) {
  // frames: array of strings, each becomes one reader.read() chunk.
  let i = 0
  const encoder = new TextEncoder()
  return {
    getReader() {
      return {
        async read() {
          if (i >= frames.length) return { done: true, value: undefined }
          const value = encoder.encode(frames[i])
          i += 1
          return { done: false, value }
        },
      }
    },
  }
}

function makeResponse({ ok = true, status = 200, body = '', frames = [], text = '' } = {}) {
  const resp = {
    ok,
    status,
    body: frames.length ? makeSseBody(frames) : undefined,
  }
  resp.text = () => Promise.resolve(text)
  return resp
}

describe('useStreamChat event parsing', () => {
  it('start event sets currentModel + adapterInfo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: ['data: {"type":"start","model":"m1","adapter":"ollama"}\n'],
        })
      )
    )
    const done = vi.fn()
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, done)
    expect(s.currentModel.value).toBe('m1')
    // start only records the adapter name (deduplicated is filled on 'done')
    expect(s.adapterInfo.value).toEqual({ adapter: 'ollama' })
  })

  it('chunk events accumulate into streamContent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: [
            'data: {"type":"chunk","content":"Hello "}\n',
            'data: {"type":"chunk","content":"world"}\n',
          ],
        })
      )
    )
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, vi.fn())
    expect(s.streamContent.value).toBe('Hello world')
  })

  it('thinking events accumulate into thinkingContent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: ['data: {"type":"thinking","content":"hmm"}\n'],
        })
      )
    )
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, vi.fn())
    expect(s.thinkingContent.value).toBe('hmm')
  })

  it('status event sets statusText; heartbeat is ignored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: [
            'data: {"type":"status","text":"working"}\n',
            'data: {"type":"heartbeat"}\n',
          ],
        })
      )
    )
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, vi.fn())
    expect(s.statusText.value).toBe('working')
  })

  it('done event with content replaces streamContent and calls onDone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: [
            'data: {"type":"chunk","content":"partial"}\n',
            'data: {"type":"done","content":"final","model":"m2"}\n',
          ],
        })
      )
    )
    const done = vi.fn()
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, done)
    expect(s.streamContent.value).toBe('final')
    expect(s.currentModel.value).toBe('m2')
    expect(done).toHaveBeenCalledOnce()
    expect(done.mock.calls[0][0]).toMatchObject({ type: 'done', content: 'final', model: 'm2' })
  })

  it('error event calls onDone with { error: message }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({
          frames: ['data: {"type":"error","message":"boom"}\n'],
        })
      )
    )
    const done = vi.fn()
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, done)
    expect(done).toHaveBeenCalledWith({ error: 'boom' })
    expect(s.isStreaming.value).toBe(false)
  })
})

describe('useStreamChat HTTP + abort behavior', () => {
  it('non-OK HTTP response calls onDone with the status text and stops', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ ok: false, status: 429, text: 'rate limited' }))
    )
    const done = vi.fn()
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, done)
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
    expect(String(done.mock.calls[0][0].error)).toContain('429')
    expect(s.isStreaming.value).toBe(false)
  })

  it('aborted fetch (AbortError) does NOT call onDone with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      })
    )
    const done = vi.fn()
    const s = useStreamChat()
    const p = s.sendStream({ question: 'hi' }, done)
    s.cancelStream()
    await p
    expect(done).not.toHaveBeenCalled()
    expect(s.isStreaming.value).toBe(false)
  })

  it('cancelStream() clears the streaming flag', async () => {
    const s = useStreamChat()
    s.cancelStream()
    expect(s.isStreaming.value).toBe(false)
  })

  it('non-abort fetch failure surfaces err.message via onDone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network down'))))
    const done = vi.fn()
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, done)
    expect(done).toHaveBeenCalledWith({ error: 'network down' })
    expect(s.isStreaming.value).toBe(false)
  })
})

describe('useStreamChat auth header', () => {
  it('adds Authorization Bearer header when a token is provided', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ frames: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, vi.fn(), 'jwt-token-123')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer jwt-token-123')
  })

  it('omits Authorization header when no token', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ frames: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const s = useStreamChat()
    await s.sendStream({ question: 'hi' }, vi.fn())
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
