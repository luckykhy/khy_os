// keyStore.test.mjs — Key/Endpoint Manager 数据层单测（DESIGN-ARCH-091 §10.1 ①-⑦⑳）。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/keyStore.test.mjs
// (Node 22.6+ type stripping; the .ts modules import cleanly without a build step.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// isolate dataHome BEFORE importing keyStore (the module caches it on first use)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-keystore-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYOS_DESKTOP_REPO_ROOT = tmp // keep repo-root detection away from the real repo

const ks = await import('../src/main/keyManager/keyStore.ts')

function cleanupEnv() {
  delete process.env.AGNES_API_KEY
  delete process.env.OPENAI_API_KEY
}

test('① listPool 正常读 api_keys.json → 脱敏列表无明文', async () => {
  cleanupEnv()
  const apiKeysFile = path.join(process.env.KHY_DATA_HOME, 'api_keys.json')
  await fs.mkdirSync(path.dirname(apiKeysFile), { recursive: true })
  fs.writeFileSync(
    apiKeysFile,
    JSON.stringify({ supxh: [{ key: 'sk-SECRET-VALUE-123456', endpoint: 'https://speed44.toter.me/v1', priority: 10, label: 'SupXH' }] }),
    'utf-8'
  )
  ks._resetDataHomeCache()
  const { providers } = await ks.listPool()
  const payload = JSON.stringify(providers)
  assert.ok(payload.includes('sk-…1234') || payload.includes('…'), 'should be masked')
  assert.ok(!payload.includes('SECRET-VALUE-123456'), 'plaintext key must not appear in the payload')
  const p = providers.find((x) => x.id === 'supxh')
  assert.ok(p, 'provider present')
  assert.equal(p.keys.length, 1)
  assert.ok(p.keys[0].fingerprint.length === 8, 'sha256-8 fingerprint')
})

test('② addKey 原子写：.tmp 不留残 + 生成 .bak', async () => {
  const apiKeysFile = path.join(process.env.KHY_DATA_HOME, 'api_keys.json')
  const r = await ks.addKey({ provider: 'agg', endpoint: 'https://example.com/v1', key: 'sk-agg-001', label: 'Agg' })
  assert.ok(r.ok)
  assert.ok(r.keyId && r.keyId.length === 12, 'keyId = md5(provider:key).12')
  // no .tmp residue
  const dir = path.dirname(apiKeysFile)
  const tmps = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.equal(tmps.length, 0, 'no .tmp residue')
  // .bak of previous content exists
  assert.ok(fs.existsSync(`${apiKeysFile}.bak`), '.bak created before write')
  // idempotent dedup by key value
  const r2 = await ks.addKey({ provider: 'agg', endpoint: 'https://example.com/v1', key: 'sk-agg-001' })
  const doc = JSON.parse(fs.readFileSync(apiKeysFile, 'utf-8'))
  assert.equal(doc.agg.length, 1, 'duplicate key is deduped, not appended')
  void r2
})

test('③ 注入损坏 JSON → .bak 自愈（恢复上一次写入前的健康快照）', async () => {
  const apiKeysFile = path.join(process.env.KHY_DATA_HOME, 'api_keys.json')
  // .bak = the on-disk content from before this write (atomicWriteJson copies
  // current → .bak first), so it holds test ②'s 'agg' but NOT 'healme'.
  await ks.addKey({ provider: 'healme', key: 'sk-heal-1', endpoint: 'https://h.example/v1' })
  fs.writeFileSync(apiKeysFile, '{corrupt!!', 'utf-8')
  const { data, recovered } = await ks.safeReadJson(path.join(process.env.KHY_DATA_HOME, 'api_keys.json'), {})
  assert.ok(recovered, 'recovered from .bak')
  assert.ok(data.agg, 'previous healthy snapshot (agg) restored')
  assert.equal(data.healme, undefined, '.bak predates the healme write (by design)')
  // and the on-disk file is valid JSON again
  const healed = JSON.parse(fs.readFileSync(apiKeysFile, 'utf-8'))
  assert.ok(healed.agg, 'healed on disk (valid JSON)')
})

test('④ env 叠加：AGNES_API_KEY 设置后 list 出现 env 来源标记，且池文件零改动', async () => {
  process.env.AGNES_API_KEY = 'sk-env-overlay'
  ks._resetDataHomeCache()
  const apiKeysFile = path.join(process.env.KHY_DATA_HOME, 'api_keys.json')
  const before = fs.readFileSync(apiKeysFile, 'utf-8')
  const { envOverlay } = await ks.listPool()
  const agnes = envOverlay.find((e) => e.provider === 'agnes')
  assert.ok(agnes, 'agnes in overlay table')
  assert.ok(agnes.set, 'env var detected')
  const after = fs.readFileSync(apiKeysFile, 'utf-8')
  assert.equal(after, before, 'env overlay must not write the pool file')
  delete process.env.AGNES_API_KEY
})

test('⑤ removeKey 被启用卡片引用时拒绝（无凭据卡片引用检查）', async () => {
  // create a card referencing the pool key
  const add = await ks.addKey({ provider: 'cardref', key: 'sk-card-1', endpoint: 'https://c.example/v1' })
  const card = await ks.addCard({ name: 'C', baseUrl: 'https://c.example/v1', keyId: add.keyId, protocol: 'openai' })
  assert.ok(card.ok)
  const blocked = await ks.removeKey('cardref', add.keyId)
  assert.ok(!blocked.ok, 'blocked by active card')
  assert.ok(blocked.blockedCards && blocked.blockedCards.length === 1)
  // removing the card unblocks the key
  await ks.removeCard(card.cardId)
  const ok = await ks.removeKey('cardref', add.keyId)
  assert.ok(ok.ok)
})

test('⑥ toggle/优先级语义', async () => {
  const r = await ks.addKey({ provider: 'tog', key: 'sk-tog-1', endpoint: 'https://t.example/v1', priority: 5 })
  const off = await ks.toggleKey('tog', r.keyId, false)
  assert.ok(off.ok)
  let providers = (await ks.listPool()).providers
  assert.equal(providers.find((p) => p.id === 'tog').keys[0].enabled, false)
  const on = await ks.toggleKey('tog', r.keyId, true)
  assert.ok(on.ok)
  providers = (await ks.listPool()).providers
  assert.equal(providers.find((p) => p.id === 'tog').keys[0].enabled, true)
  // updateKey re-key cascades card references
  const c2 = await ks.addCard({ name: 'T2', baseUrl: 'https://t.example/v1', keyId: r.keyId, protocol: 'openai' })
  const up = await ks.updateKey('tog', r.keyId, { key: 'sk-tog-2' })
  assert.ok(up.ok)
  assert.notEqual(up.newKeyId, r.keyId, 'keyId changes with the key value')
  const doc = JSON.parse(fs.readFileSync(path.join(process.env.KHY_DATA_HOME, 'cc_switch.json'), 'utf-8'))
  const c2Doc = doc.cards.find((c) => c.id === c2.cardId)
  assert.equal(c2Doc.keyId, up.newKeyId, 'card reattached to the new keyId')
})

test('⑦ 写盘权限 600（POSIX 断言，win32 跳过）', async () => {
  if (process.platform === 'win32') return // chmod is best-effort no-op on Windows
  const f = path.join(process.env.KHY_DATA_HOME, 'api_keys.json')
  const st = fs.statSync(f)
  const mode = st.mode & 0o777
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})

test('⑳ fetchModels 三分支：成功填充 / 401 标未验证不阻塞 / 协议无目录', async () => {
  const realFetch = globalThis.fetch
  // 成功分支
  globalThis.fetch = async (url, opts) => {
    assert.ok(String(url).includes('/v1/models'))
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-1' }, { id: 'm-2' }] }) }
  }
  const ok = await ks.fetchModels('https://ex.com/v1', 'openai', 'sk-x')
  assert.ok(ok.ok && ok.verified)
  assert.deepEqual(ok.models, ['m-1', 'm-2'])
  // 401 分支：可达但未验证，不阻塞保存
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  const auth = await ks.fetchModels('https://ex.com/v1', 'openai', 'sk-bad')
  assert.ok(auth.ok && !auth.verified, '401 → verified:false but ok:true')
  // 协议无目录分支（anthropic 等）
  const proto = await ks.fetchModels('https://ex.com', 'anthropic', 'sk-x')
  assert.ok(proto.ok && !proto.verified && proto.models.length === 0)
  globalThis.fetch = realFetch
})

test('reveal 限流：60s 内二次 reveal 被拒（E6 语义）', async () => {
  const r = await ks.addKey({ provider: 'rev', key: 'sk-rev-1', endpoint: 'https://r.example/v1' })
  const first = await ks.revealKey('rev', r.keyId)
  assert.ok(first.ok && first.key === 'sk-rev-1')
  const second = await ks.revealKey('rev', r.keyId)
  assert.ok(!second.ok, 'second reveal inside cooldown rejected')
  assert.match(second.error || /cooldown/, /冷却|cooldown/)
  ks._resetRevealWindow()
  const third = await ks.revealKey('rev', r.keyId)
  assert.ok(third.ok, 'after window reset, reveal works')
})

test('importMarkdown：真实 key 入库 + 占位值/public 拒收（§9）', async () => {
  const md = [
    '## 1. TestProv',
    '',
    '| 项目 | 值 |',
    '|------|-----|',
    '| Base URL | `https://testprov.example/v1` |',
    '| API Key | `sk-real-import-key` |',
    '',
    '## 2. PlaceholderProv',
    '',
    '| 项目 | 值 |',
    '| Base URL | `https://p.example/v1` |',
    '| API Key | `<your-api-key>` |',
    ''
  ].join('\n')
  const r = await ks.importMarkdown(md)
  assert.equal(r.added, 1, 'real key imported')
  assert.equal(r.skipped.length, 1, 'placeholder rejected')
  assert.match(r.skipped[0].reason, /占位/)
  const { providers } = await ks.listPool()
  assert.ok(providers.find((p) => p.id === 'testprov'), 'pool entry created')
  // the imported key is also masked in list payloads
  assert.ok(!JSON.stringify(providers).includes('sk-real-import-key'))
})
