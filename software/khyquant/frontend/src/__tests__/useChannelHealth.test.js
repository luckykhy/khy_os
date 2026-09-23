/**
 * useChannelHealth.test.js — locks the channel-health composable contract:
 * overallHealth rollup (unknown/healthy/degraded/critical), activity ring
 * buffer (max 20), and lifecycle wiring onto a ws service mock.
 * If the rollup rules or ring size drift, this test goes red first.
 */
import { describe, it, expect, vi } from 'vitest'
import { useChannelHealth } from '../composables/useChannelHealth.js'

function wsMock() {
  const handlers = {}
  return {
    on(event, fn) {
      handlers[event] = fn
      return () => {
        delete handlers[event]
      }
    },
    _emit(event, data) {
      if (handlers[event]) handlers[event](data)
    },
  }
}

function read(state) {
  return {
    overallHealth: state.overallHealth.value,
    healthyCount: state.healthyCount.value,
    totalCount: state.totalCount.value,
    channels: state.channels.value,
    activeAdapter: state.activeAdapter.value,
    activity: state.activity.value,
  }
}

describe('useChannelHealth overallHealth rollup', () => {
  it('no channels yet → unknown / 0 of 0', () => {
    const s = useChannelHealth(wsMock())
    expect(read(s)).toMatchObject({ overallHealth: 'unknown', healthyCount: 0, totalCount: 0 })
  })

  it('all healthy → healthy', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_health', {
      adapters: [{ name: 'a', status: 'healthy' }, { name: 'b', status: 'healthy' }],
    })
    const r = read(s)
    expect(r.overallHealth).toBe('healthy')
    expect(r.healthyCount).toBe(2)
    expect(r.totalCount).toBe(2)
  })

  it('all in cooldown → critical', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_health', {
      adapters: [{ name: 'a', status: 'cooldown' }, { name: 'b', status: 'cooldown' }],
    })
    expect(read(s).overallHealth).toBe('critical')
  })

  it('mixed healthy+cooldown → degraded', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_health', {
      adapters: [{ name: 'a', status: 'healthy' }, { name: 'b', status: 'cooldown' }],
    })
    const r = read(s)
    expect(r.overallHealth).toBe('degraded')
    expect(r.healthyCount).toBe(1)
    expect(r.totalCount).toBe(2)
  })

  it('malformed health payload is ignored (channels unchanged)', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_health', null)
    ws._emit('channel_health', { adapters: 'not-an-array' })
    expect(read(s).channels).toEqual([])
  })
})

describe('useChannelHealth activity ring buffer + active adapter', () => {
  it('activity entries keep at most the last 20 (ring eviction)', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    for (let i = 0; i < 25; i++) {
      ws._emit('channel_activity', { adapter: 'a', event: 'ok', seq: i })
    }
    const r = read(s)
    expect(r.activity).toHaveLength(20)
    expect(r.activity[0].seq).toBe(5)
    expect(r.activity[19].seq).toBe(24)
  })

  it('event=attempt moves activeAdapter to the attempting channel', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_activity', { adapter: 'b', event: 'attempt' })
    expect(read(s).activeAdapter).toBe('b')
  })

  it('non-attempt events do not touch activeAdapter', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_activity', { adapter: 'a', event: 'ok' })
    expect(read(s).activeAdapter).toBe(null)
    expect(read(s).activity).toHaveLength(1)
  })

  it('missing adapter key is ignored (no activity entry, no crash)', () => {
    const ws = wsMock()
    const s = useChannelHealth(ws)
    ws._emit('channel_activity', { event: 'ok' })
    ws._emit('channel_activity', null)
    expect(read(s).activity).toHaveLength(0)
    expect(read(s).activeAdapter).toBe(null)
  })
})

describe('useChannelHealth lifecycle (mounted/on-unmounted)', () => {
  it('no wsService or no .on → lifecycle is a safe no-op', () => {
    const s = useChannelHealth(null)
    expect(s).toBeDefined()
    const s2 = useChannelHealth({})
    expect(s2).toBeDefined()
  })

  it('re-subscribes cleanly when the ws service differs (no leaked handlers)', () => {
    const wsA = wsMock()
    const s = useChannelHealth(wsA)
    wsA._emit('channel_health', { adapters: [{ name: 'x', status: 'healthy' }] })
    expect(read(s).totalCount).toBe(1)
    // detach: on() returns an off fn; re-run with another service must not crash
    const wsB = wsMock()
    const s2 = useChannelHealth(wsB)
    wsB._emit('channel_health', { adapters: [{ name: 'y', status: 'cooldown' }] })
    expect(read(s2).overallHealth).toBe('critical')
  })
})
