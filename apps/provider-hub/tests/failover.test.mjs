// failover.test.mjs — Provider Card Hub failover 备卡队列（DESIGN-ARCH-094 P3）。
// Run: node --experimental-strip-types --test apps/provider-hub/tests/failover.test.mjs
//
// 契约：setFailover(app, cardIds) 写备卡队列（cc_switch.json 同库）；
// rotateFailover(app)：active 出列、队首晋级、原 active 降级到队尾（轮转语义），
// 返回 { promoted, retired }；队列空时如实拒绝。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-phub-failover-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYPHUB_REPO_ROOT = tmp

const prov = await import('../src/main/providers.ts')

test('F1 轮转：active 出列 + 队首晋级 + 原 active 降级队尾', async () => {
  const a = await prov.addCard({ name: 'P1', baseUrl: 'https://p1.example.com/v1' })
  const b = await prov.addCard({ name: 'P2', baseUrl: 'https://p2.example.com/v1' })
  const c = await prov.addCard({ name: 'P3', baseUrl: 'https://p3.example.com/v1' })
  assert.ok(a.ok && b.ok && c.ok)

  const r0 = await prov.setFailover('claude-code', [b.cardId, c.cardId])
  assert.ok(r0.ok)
  assert.ok((await prov.setActive('claude-code', a.cardId)).ok)

  const r1 = await prov.rotateFailover('claude-code')
  assert.ok(r1.ok, r1.error)
  assert.equal(r1.promoted, b.cardId, '队首 P2 晋级为 active')
  assert.equal(r1.retired, a.cardId, '原 active P1 降级到队尾')

  const after = await prov.listCards()
  assert.equal(after.active['claude-code'], b.cardId)
  assert.deepEqual(after.failover['claude-code'], [c.cardId, a.cardId], '队列顺序 P3 → P1')
})

test('F2 无 active 且无队列 → 如实拒绝', async () => {
  const r = await prov.rotateFailover('codex')
  assert.equal(r.ok, false)
  assert.match(r.error, /无备用卡片|未激活/)
})

test('F3 有队列无 active → 直接晋级队首（retired 为空）', async () => {
  const y = await prov.addCard({ name: 'Y', baseUrl: 'https://y.example.com/v1' })
  const z = await prov.addCard({ name: 'Z', baseUrl: 'https://z.example.com/v1' })
  await prov.setFailover('gemini', [y.cardId, z.cardId])
  const r = await prov.rotateFailover('gemini')
  assert.ok(r.ok)
  assert.equal(r.promoted, y.cardId)
  assert.equal(r.retired, '')
  assert.equal((await prov.listCards()).active['gemini'], y.cardId)
})

test('F4 空队列轮转 → 拒绝（不假装成功）', async () => {
  const r = await prov.rotateFailover('opencode')
  assert.equal(r.ok, false)
  assert.match(r.error, /无备用卡片/)
})
