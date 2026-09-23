// providers.test.mjs — Provider Card Hub 数据层单测（DESIGN-ARCH-094 M0/M1）。
//
// Run: node --experimental-strip-types --test apps/provider-hub/tests/providers.test.mjs
//
// 契约：providers.ts 直接读写 dataHome 下 cc_switch.json（与 khy CLI / khyos-desktop
// keyManager 同库，SSoT 不另起炉灶）。卡片无凭据设计（keyId 引用密钥池）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// isolate dataHome BEFORE importing the module under test
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-phub-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYPHUB_REPO_ROOT = tmp

const prov = await import('../src/main/providers.ts')

function ccFile() {
  return path.join(process.env.KHY_DATA_HOME, 'cc_switch.json')
}

test('P1 空 dataHome → listCards 空列表（不抛、不建第四套存储）', async () => {
  const { cards, active } = await prov.listCards()
  assert.deepEqual(cards, [])
  assert.deepEqual(active, {})
})

test('P2 addCard 写 cc_switch.json：无凭据（keyId 引用池）+ 去重（同名同端点不重复）', async () => {
  const r1 = await prov.addCard({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyId: 'k_1', protocol: 'openai' })
  assert.ok(r1.ok)
  assert.ok(r1.cardId)
  const r2 = await prov.addCard({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyId: 'k_1', protocol: 'openai' })
  const doc = JSON.parse(fs.readFileSync(ccFile(), 'utf-8'))
  assert.equal(doc.cards.length, 1, '同名同端点去重')
  assert.ok(doc.cards[0].keyId === 'k_1')
  const payload = JSON.stringify(doc)
  assert.ok(!/sk-/.test(payload), '卡片文件不得含明文密钥')
  void r2
})

test('P3 duplicateCard 复制为 -copy 且禁用（cc-switch 复制语义）', async () => {
  const r = await prov.addCard({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' })
  assert.ok(r.ok)
  const d = await prov.duplicateCard(r.cardId)
  assert.ok(d.ok && d.cardId)
  const { cards } = await prov.listCards()
  const copy = cards.find((c) => c.id === d.cardId)
  assert.match(copy.name, /-copy$/)
  assert.equal(copy.enabled, false)
})

test('P4 reorderCards 拖动排序持久化（数组顺序即展示顺序）', async () => {
  const a = await prov.addCard({ name: 'A', baseUrl: 'https://a.example.com/v1' })
  const b = await prov.addCard({ name: 'B', baseUrl: 'https://b.example.com/v1' })
  const c = await prov.addCard({ name: 'C', baseUrl: 'https://c.example.com/v1' })
  assert.ok(a.ok && b.ok && c.ok)
  const r = await prov.reorderCards(c.cardId, 0)
  assert.ok(r.ok)
  const { cards } = await prov.listCards()
  assert.equal(cards[0].id, c.cardId)
  // 相对顺序不变式：C 之后 A 在 B 前（P2/P3 的 DeepSeek/OpenRouter 残留卡不影响相对次序）
  const names = cards.map((x) => x.name)
  const iC = names.indexOf('C')
  const iA = names.indexOf('A')
  const iB = names.indexOf('B')
  assert.ok(iC === 0 && iA < iB, `相对顺序错误: ${JSON.stringify(names)}`)
})

test('P5 激活卡不可删（cc-switch「删不掉的当前激活」不变式）', async () => {
  const r = await prov.addCard({ name: 'Active', baseUrl: 'https://active.example.com/v1' })
  assert.ok((await prov.setActive('claude-code', r.cardId)).ok)
  const rm = await prov.removeCard(r.cardId)
  assert.equal(rm.ok, false)
  assert.ok(Array.isArray(rm.activeApps) && rm.activeApps.includes('claude-code'), '回报被哪些工具占用')
  assert.ok(fs.existsSync(ccFile()) && JSON.parse(fs.readFileSync(ccFile(), 'utf-8')).cards.some((x) => x.id === r.cardId), '卡片仍在盘上')
  // 解除占用后可删
  assert.ok((await prov.clearActive('claude-code')).ok)
  assert.ok((await prov.removeCard(r.cardId)).ok)
})

test('P6 updateCard 字段补丁 + 触碰 updatedAt（幂等、保留无关字段）', async () => {
  const r = await prov.addCard({ name: 'Upd', baseUrl: 'https://u.example.com/v1', models: ['m1'] })
  const u = await prov.updateCard(r.cardId, { defaultModel: 'm1', name: 'Upd2' })
  assert.ok(u.ok)
  const card = (await prov.listCards()).cards.find((x) => x.id === r.cardId)
  assert.equal(card.name, 'Upd2')
  assert.equal(card.defaultModel, 'm1')
  assert.deepEqual(card.models, ['m1'])
})

test('P7 原子写：.tmp 不留残 + 生成 .bak（configGuard 等价语义）', async () => {
  const r = await prov.addCard({ name: 'Atomic', baseUrl: 'https://at.example.com/v1' })
  assert.ok(r.ok)
  const dir = path.dirname(ccFile())
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, 'no .tmp residue')
  assert.ok(fs.existsSync(`${ccFile()}.bak`), '.bak 先于写入存在')
})

test('P8 损坏自愈：cc_switch.json 坏 JSON → 从 .bak 恢复（recovered 标记）', async () => {
  const r = await prov.addCard({ name: 'Heal', baseUrl: 'https://h.example.com/v1' })
  assert.ok(r.ok)
  fs.writeFileSync(ccFile(), '{ corrupt', 'utf-8')
  const out = await prov.listCards()
  assert.equal(out.recovered, true)
  assert.ok(out.cards.some((x) => x.name === 'Heal'), '.bak 内容恢复成功')
})
