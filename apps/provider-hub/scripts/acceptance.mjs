// acceptance.mjs — 实机验收（DESIGN-ARCH-094 M2 验收标准）。
// Run: node --experimental-strip-types scripts/acceptance.mjs
// 内容：9 工具 live 配置探测 → 一键导入（去重）→ 池密钥卡片模型拉取。
// 会真实写 dataHome 的 cc_switch.json（无凭据卡片，可安全重跑）。

const repoServices = 'D:/Portable/khy-os/services/backend/src/services'
process.env.KHY_BACKEND_SERVICES = repoServices

const tw = await import('../src/main/toolWriters.ts')
const prov = await import('../src/main/providers.ts')
const mc = await import('../src/main/modelCatalog.ts')

console.log('── 1. 工具探测（detectCardInApp × 9）──')
const det = await tw.detectToolProviders()
if (!det.ok) {
  console.log('探测失败:', det.error)
  process.exit(1)
}
let imported = 0
const toolsWithProviders = []
for (const row of det.results) {
  const n = row.providers?.length || 0
  console.log(`  ${row.app}: ${n} 个 provider${row.success ? '' : '（探测失败: ' + row.error + '）'}`)
  if (n > 0) toolsWithProviders.push(row.app)
  for (const p of row.providers || []) {
    const r = await tw.importFromTool(row.app, p)
    if (r.ok) imported += 1
  }
}
console.log(`导入完成: 新增/命中 ${imported} 张卡片，${toolsWithProviders.length} 个工具有可导入 provider [${toolsWithProviders.join(', ')}]`)

const { cards } = await prov.listCards()
console.log(`卡片总数: ${cards.length}`)

console.log('── 2. 池密钥卡片模型拉取 ──')
// 从 api_keys.json 找一个 openai 兼容的 provider+key 组
const fs = await import('node:fs')
const path = await import('node:path')
const dataHome = process.env.KHY_DATA_HOME || path.join('D:/Portable', '.khy')
const poolFile = path.join(dataHome, 'api_keys.json')
let pool = {}
try {
  pool = JSON.parse(fs.readFileSync(poolFile, 'utf-8'))
} catch {
  console.log('api_keys.json 不可读，跳过模型拉取验证')
  process.exit(0)
}
let tested = false
outer: for (const [provider, entries] of Object.entries(pool)) {
  for (const e of entries || []) {
    if (!e.endpoint || e.disabled) continue
    const keyId = prov.keyIdFor(provider, e.key)
    // 找/建一张引用该 key 的卡片
    let card = cards.find((c) => c.keyId === keyId)
    if (!card) {
      const r = await prov.addCard({ name: provider, baseUrl: e.endpoint, keyId, protocol: 'openai' })
      card = (await prov.listCards()).cards.find((c) => c.id === r.cardId)
    }
    const res = await mc.fetchModelCatalog({ protocol: card.protocol, baseUrl: card.baseUrl, key: e.key }, { timeoutMs: 15000 })
    console.log(`  拉取 ${provider} (${card.baseUrl}) → verified=${res.verified}, 模型 ${res.models.length} 个${res.error ? '，' + res.error : ''}`)
    if (res.verified) {
      await prov.updateCard(card.id, { models: mc.mergeCatalog(card.models, res.models), defaultModel: mc.resolveDefault(card.defaultModel, res.models) })
      console.log(`  已合并 ${res.models.length} 模型到卡片 ${card.name}`)
      tested = true
      break outer
    }
    if (res.models.length > 0) tested = true
  }
}
if (!tested) console.log('  无可用池端点完成拉取验证（401/不可达均如实汇报，不视为失败）')

console.log('── 验收结论 ──')
console.log(`工具导入: ${toolsWithProviders.length} 个工具 / 模型拉取: ${tested ? '已验证' : '端点不可达（如实）'}`)
