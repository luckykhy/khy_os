// modelCatalog.test.mjs — Provider Card Hub 模型目录拉取/合并单测（DESIGN-ARCH-094 M0/M1）。
//
// Run: node --experimental-strip-types --test apps/provider-hub/tests/modelCatalog.test.mjs
//
// 契约：modelCatalog.ts 按卡片协议路由模型目录请求（openai 线 /v1/models Bearer；
// anthropic 线 /v1/models x-api-key），空闲超时绝不硬挂；fail-soft 永不抛；
// 结果与错误消息绝不含明文 key（脱敏不变式）；合并语义「已有条目不覆盖」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const mc = await import('../src/main/modelCatalog.ts')

function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler({ url: String(url), init, calls })
  }
  fn.calls = calls
  return fn
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

test('M1 openai 线：GET {base}/v1/models + Bearer，解析 data[].id（顺序保留）', async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }))
  const r = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://x.example.com/v1', key: 'sk-super-secret-123' }, { fetchImpl: f })
  assert.ok(r.ok)
  assert.equal(r.verified, true)
  assert.deepEqual(r.models, ['gpt-4o', 'gpt-4o-mini'])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://x.example.com/v1/models', 'trailing /v1 不重复拼接')
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer sk-super-secret-123')
})

test('M2 openai_responses 按 openai 兼容线处理', async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [{ id: 'gpt-5-codex' }] }))
  const r = await mc.fetchModelCatalog({ protocol: 'openai_responses', baseUrl: 'https://x.example.com', key: 'sk-x' }, { fetchImpl: f })
  assert.equal(r.verified, true)
  assert.equal(f.calls[0].url, 'https://x.example.com/v1/models')
})

test('M3 anthropic 线：x-api-key + anthropic-version，URL /v1/models', async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }))
  const r = await mc.fetchModelCatalog({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'sk-ant-999' }, { fetchImpl: f })
  assert.equal(r.verified, true)
  assert.deepEqual(r.models, ['claude-sonnet-4-5', 'claude-haiku-4-5'])
  const h = f.calls[0].init.headers
  assert.equal(h['x-api-key'], 'sk-ant-999')
  assert.equal(h['anthropic-version'], '2023-06-01')
  assert.equal(h.authorization, undefined, 'anthropic 线不用 Bearer')
})

test('M4 无公开目录的协议（gemini）→ verified:false 不触网、不阻塞保存', async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [] }))
  const r = await mc.fetchModelCatalog({ protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', key: 'k' }, { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.verified, false)
  assert.equal(f.calls.length, 0, '不得发起请求')
  assert.match(r.error, /无公开模型目录|手工填写/)
})

test('M5 401/403 → verified:false 鉴权失败（端点可达但 key 未验证）', async () => {
  const r1 = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://x.example.com', key: 'sk-bad' }, { fetchImpl: fakeFetch(() => jsonRes(401, {})) })
  assert.equal(r1.verified, false)
  assert.match(r1.error, /401|403|鉴权/)
  const r2 = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://x.example.com', key: 'sk-denied' }, { fetchImpl: fakeFetch(() => jsonRes(403, {})) })
  assert.equal(r2.verified, false)
})

test('M6 5xx → verified:false 目录不可用（可手工填写，不抛）', async () => {
  const r = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://x.example.com', key: 'sk-x' }, { fetchImpl: fakeFetch(() => jsonRes(503, {})) })
  assert.equal(r.ok, true)
  assert.equal(r.verified, false)
  assert.match(r.error, /503/)
})

test('M7 端点不可达 → fail-soft verified:false（绝不抛、绝不挂起）', async () => {
  const fetchImpl = () => Promise.reject(new TypeError('fetch failed'))
  const r = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://dead.example.com', key: 'sk-x' }, { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.verified, false)
  assert.match(r.error, /不可达/)
})

test('M8 空闲超时：挂起请求在 timeoutMs 后中止（不硬挂，规则 3）', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const t0 = Date.now()
  const r = await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://slow.example.com', key: 'sk-x' }, { fetchImpl, timeoutMs: 60 })
  assert.equal(r.verified, false)
  assert.ok(Date.now() - t0 < 2000, '必须按空闲超时快速返回，不得硬挂')
})

test('M9 脱敏不变式：任何成功/失败路径结果不含明文 key', async () => {
  const cases = [
    await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://x.example.com', key: 'sk-topsecret-000' }, { fetchImpl: fakeFetch(() => jsonRes(401, {})) }),
    await mc.fetchModelCatalog({ protocol: 'openai', baseUrl: 'https://dead.example.com', key: 'sk-topsecret-000' }, { fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')) }),
    await mc.fetchModelCatalog({ protocol: 'gemini', baseUrl: 'https://x.example.com', key: 'sk-topsecret-000' }, {})
  ]
  for (const r of cases) {
    assert.ok(!JSON.stringify(r).includes('sk-topsecret-000'), '明文 key 泄漏: ' + JSON.stringify(r))
  }
})

test('M10 mergeCatalog：已有条目顺序保留不覆盖，新模型追加、去重（大小写敏感）', () => {
  const merged = mc.mergeCatalog(['a', 'b'], ['b', 'c', 'd', 'a'])
  assert.deepEqual(merged, ['a', 'b', 'c', 'd'])
  const cs = mc.mergeCatalog(['X'], ['x'])
  assert.deepEqual(cs, ['X', 'x'], '模型 id 大小写敏感，不去重撞车')
  assert.deepEqual(mc.mergeCatalog([], []), [])
})

test('M11 resolveDefault：既有默认仍在目录中则保留，否则取首个', () => {
  assert.equal(mc.resolveDefault('b', ['a', 'b', 'c']), 'b')
  assert.equal(mc.resolveDefault('gone', ['a', 'b']), 'a')
  assert.equal(mc.resolveDefault('', []), '')
})
