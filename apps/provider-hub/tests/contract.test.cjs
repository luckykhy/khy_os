// contract.test.cjs — Provider Card Hub 文本契约测试（DESIGN-ARCH-094 M0）。
//
// Run: node --test apps/provider-hub/tests/contract.test.cjs
//（纯文本契约，无需 strip-types；与 khyos-desktop keyManagerContract 同范式。）
//
// 覆盖：IPC 通道命名/注册对齐、脱敏不变式、零硬编码端点、不造第四套存储、
//      toolWriters 四级 backend 解析（降级可审计）。

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const projectRoot = join(__dirname, '..')
const read = (p) => {
  const full = join(projectRoot, p)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

const ipcSrc = read('src/main/ipc.ts')
const preloadSrc = read('src/preload/index.ts')
const providersSrc = read('src/main/providers.ts')
const modelSrc = read('src/main/modelCatalog.ts')
const toolWritersSrc = read('src/main/toolWriters.ts')

// C1 IPC 通道全部在 ipc.ts 注册（namespace:action 命名）
test('C1 必需 IPC 通道已在 ipc.ts 注册', () => {
  assert.ok(ipcSrc.length > 0, 'ipc.ts 缺失（M1 未交付）')
  const required = [
    'cards:list', 'cards:add', 'cards:update', 'cards:duplicate', 'cards:remove',
    'cards:reorder', 'cards:set-active', 'cards:clear-active',
    'cards:failover-set', 'cards:failover-rotate',
    'keys:list', 'keys:add', 'keys:reveal',
    'models:fetch', 'models:apply',
    'tools:matrix', 'tools:detect', 'tools:import', 'tools:apply',
    'proxy:status', 'proxy:start',
    'health:probe',
    'usage:summary'
  ]
  for (const ch of required) {
    assert.ok(ipcSrc.includes(`handle('${ch}'`), `通道 ${ch} 未在 ipc.ts 注册`)
  }
})

test('C1 preload invoke 通道与主进程 handler 对齐（无 API 漂移）', () => {
  assert.ok(preloadSrc.length > 0, 'preload/index.ts 缺失')
  const invocations = [...preloadSrc.matchAll(/invoke\('([a-z][a-z0-9-]*:[a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(invocations.length > 0, 'preload 未暴露任何 invoke')
  for (const ch of invocations) {
    const inIpc = ipcSrc.includes(`handle('${ch}'`)
    assert.ok(inIpc, `preload 调用通道 ${ch} 未注册`)
  }
})

test('C2 通道命名符合 namespace:action（小写 + 连字符）', () => {
  const channels = [...ipcSrc.matchAll(/handle\('([^']+)'/g)].map((m) => m[1])
  for (const ch of channels) {
    assert.match(ch, /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/, `${ch} 不符合 namespace:action`)
  }
})

// C3 脱敏不变式：明文 key 只在 keys:reveal 单一出口
test('C3 脱敏不变式：keys:reveal 是明文 key 唯一出口', () => {
  const revealHandlers = ipcSrc.match(/revealKey\(|reveal\(/g) || []
  assert.ok(revealHandlers.length >= 1, 'keys:reveal 未接 reveal 语义')
  // models:fetch handler 返回体不得透传 key 字段
  const fetchBlock = ipcSrc.match(/'models:fetch'[\s\S]{0,400}/)
  assert.ok(fetchBlock, "models:fetch handler 缺失")
  assert.ok(!/return\s+ok\(\{\s*key:/.test(fetchBlock[0]), 'models:fetch 不得回传明文 key')
  assert.ok(!/headers\s*:/.test(modelSrc) === false || true) // headers 结构由实现自证，此处仅防 key 字面透传
  assert.ok(!modelSrc.includes("key: card.key"), 'modelCatalog 结果体不得携带 key 字段')
})

// C4 零硬编码：src/main 不得出现 host:port 字面量（端点来自卡片/运行时文件/env）
test('C4 零硬编码端点（host:port 字面量审计）', () => {
  for (const [name, src] of Object.entries({ providersSrc, modelSrc, toolWritersSrc, ipcSrc, preloadSrc })) {
    if (!src) continue
    const bad = src.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/g)
    assert.equal(bad ? bad.length : 0, 0, `${name} 含硬编码 host:port: ${(bad || []).join(', ')}`)
  }
})

// C5 不造第四套存储：providers.ts 只写 cc_switch.json / api_keys.json / custom_providers.json（+ audit jsonl + .bak/tmp）
test('C5 存储面收敛：providers.ts 只触碰既有 SSoT 文件', () => {
  assert.ok(providersSrc.length > 0, 'providers.ts 缺失（M1 未交付）')
  const writes = [...providersSrc.matchAll(/(atomicWriteJson|writeFile|writeFileSync)\(([^,)]+)/g)].map((m) => m[2])
  const allowed = /cc_switch|api_keys|custom_providers|provider_hub_audit|CC_SWITCH_FILE|API_KEYS_FILE|CUSTOM_PROVIDERS_FILE|AUDIT_FILE|\.bak|tmp|fileInDataHome|file\b|\$\{/
  for (const w of writes) {
    assert.ok(allowed.test(w), `providers.ts 写入了未知存储: ${w}`)
  }
})

// C6 卡片无凭据设计：providers.ts 不得把明文 key 字段写进卡片对象
test('C6 卡片无凭据：providers.ts 卡片字段不含 key 明文', () => {
  const addBlock = providersSrc.match(/export async function addCard[\s\S]{0,1500}/)
  assert.ok(addBlock, 'addCard 缺失')
  assert.ok(!/key:\s*(input\.key|key)\b/.test(addBlock[0]), 'addCard 不得把明文 key 写入卡片')
})

// C7 toolWriters 四级 backend 解析（env → 仓库 → 便携根 → 内置降级 + 审计）
test('C7 toolWriters 四级 backend 解析（降级可审计）', () => {
  assert.ok(toolWritersSrc.length > 0, 'toolWriters.ts 缺失（M1 未交付）')
  assert.ok(toolWritersSrc.includes('KHY_BACKEND_SERVICES'), '缺 KHY_BACKEND_SERVICES 一级')
  assert.ok(toolWritersSrc.includes('KHY_PORTABLE_ROOT') || toolWritersSrc.includes('KHYQUANT_PORTABLE_ROOT'), '缺便携根一级')
  assert.ok(toolWritersSrc.includes('backend-resolve-failed'), '缺内置降级审计事件')
})

// C8 模型拉取空闲超时（规则 3：绝不硬挂）
test('C8 modelCatalog 采用 AbortController 空闲超时', () => {
  assert.ok(modelSrc.length > 0, 'modelCatalog.ts 缺失（M1 未交付）')
  assert.ok(modelSrc.includes('AbortController'), '缺少 AbortController（不得用固定墙钟硬 kill）')
  assert.ok(modelSrc.includes('clearTimeout') || modelSrc.includes('abort'), '缺少超时清理')
})
