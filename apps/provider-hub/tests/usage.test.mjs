// usage.test.mjs — Provider Card Hub 用量聚合（DESIGN-ARCH-094 P3）。
// Run: node --experimental-strip-types --test apps/provider-hub/tests/usage.test.mjs
//
// 契约：usage.ts 聚合 token_usage.json（khy SSoT 用量账本，与
// services/backend tokenUsageService 同格式：daily[date]={inputTokens,outputTokens,
// totalTokens,requests,costUSD}）：
//   - 按日求和，输出最近 N 天（含空日补 0）
//   - 文件缺失/损坏 → { available:false, error }（fail-soft，不抛）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-phub-usage-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYPHUB_REPO_ROOT = tmp

const usage = await import('../src/main/usage.ts')

function seedUsage(doc) {
  fs.mkdirSync(process.env.KHY_DATA_HOME, { recursive: true })
  fs.writeFileSync(path.join(process.env.KHY_DATA_HOME, 'token_usage.json'), JSON.stringify(doc), 'utf-8')
}

test('U1 按日聚合：多日输入/输出/费用求和 + 最近 N 天补零', async () => {
  const today = new Date().toISOString().slice(0, 10)
  const y1 = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  seedUsage({
    daily: {
      [y1]: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.15, requests: 3 },
      [today]: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUSD: 0.2, requests: 4 }
    }
  })
  const r = await usage.usageSummary(7)
  assert.equal(r.available, true)
  assert.equal(r.days.length, 7, '固定 7 天窗口（不足补零）')
  const last = r.days[6]
  assert.equal(last.date, today)
  assert.equal(last.totalTokens, 300)
  assert.equal(last.costUSD, 0.2)
  assert.equal(last.requests, 4)
  // 第一天（6 天前）无数据 → 补零
  assert.equal(r.days[0].totalTokens, 0)
  // 昨日有数据
  assert.equal(r.days[5].totalTokens, 150)
})

test('U2 文件缺失 → available:false + 具体原因（fail-soft 不抛）', async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-phub-usage-empty-'))
  const prev = process.env.KHY_DATA_HOME
  process.env.KHY_DATA_HOME = emptyHome
  try {
    const r = await usage.usageSummary(7)
    assert.equal(r.available, false)
    assert.ok(r.error)
    assert.match(r.error, /无用量数据|不存在|未记录/)
  } finally {
    process.env.KHY_DATA_HOME = prev
  }
})

test('U3 损坏文件 → available:false（不抛、不静默）', async () => {
  seedUsage('{}')
  const r1 = await usage.usageSummary(7)
  assert.equal(r1.available, true, '空对象合法（无 daily 键 = 零用量）')
  fs.writeFileSync(path.join(process.env.KHY_DATA_HOME, 'token_usage.json'), '{ broken', 'utf-8')
  const r2 = await usage.usageSummary(7)
  assert.equal(r2.available, false, '损坏如实回报')
})

test('U4 未知来源容错：daily 条目缺字段按 0 处理', async () => {
  const today = new Date().toISOString().slice(0, 10)
  seedUsage({ daily: { [today]: { totalTokens: 42 } } })
  const r = await usage.usageSummary(7)
  const last = r.days[6]
  assert.equal(last.totalTokens, 42)
  assert.equal(last.inputTokens, 0)
  assert.equal(last.costUSD, 0)
})
