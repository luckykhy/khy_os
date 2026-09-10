// keyManagerContract.test.cjs — Key/Endpoint Manager 契约测试
//（DESIGN-ARCH-091 §10.1 ⑯-⑱ + desktopUiContract D6 扩展）。
//
// Run: node --test apps/khyos-desktop/tests/keyManagerContract.test.cjs
//（纯文本契约，无需 strip-types。）

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

const indexSrc = read('src/main/index.ts')
const preloadSrc = read('src/preload/index.ts')
const ipcSrc = read('src/main/keyManager/ipc.ts')
const keyStoreSrc = read('src/main/keyManager/keyStore.ts')
const agentWritersSrc = read('src/main/keyManager/agentWriters.ts')

// ⑯ 所有 keys:*/endpoints:*/agents:*/health:*/proxy:*/cards:*/providers:* 通道
//    在 ipc.ts 注册，且与 preload 方法一一对应
test('⑯ keyManager IPC 通道已在主进程注册', () => {
  assert.ok(ipcSrc.length > 0, 'ipc.ts 缺失')
  const required = [
    'keys:list', 'keys:add', 'keys:update', 'keys:remove', 'keys:toggle', 'keys:reveal', 'keys:import',
    'providers:list', 'providers:add', 'providers:remove',
    'endpoints:presets', 'endpoints:validate', 'models:fetch',
    'cards:list', 'cards:add', 'cards:update', 'cards:remove',
    'agents:matrix', 'agents:apply', 'agents:revert',
    'proxy:status', 'proxy:start',
    'health:probe', 'health:audit-list', 'health:audit-export'
  ]
  for (const ch of required) {
    assert.ok(ipcSrc.includes(`handle('${ch}'`), `通道 ${ch} 未在 ipc.ts 注册`)
  }
})

test('⑯ preload 的 invoke 通道与主进程 handler 对齐（无 API 漂移）', () => {
  const preloadInvokes = [...preloadSrc.matchAll(/invoke\('([a-z-]+:[a-z-]+)'/g)].map((m) => m[1])
  for (const ch of preloadInvokes) {
    const inIpc = ipcSrc.includes(`handle('${ch}'`)
    const inIndex = indexSrc.includes(`handle('${ch}'`)
    assert.ok(inIpc || inIndex, `preload 调用通道 ${ch} 未注册`)
  }
})

test('⑯ index.ts 在 whenReady 注册 KeyManager IPC', () => {
  assert.ok(indexSrc.includes('registerKeyManagerIpc'), 'index.ts 未接入 registerKeyManagerIpc')
})

// D6 扩展：keyManager 通道命名必须 namespace:action
test('D6: keyManager IPC 通道命名符合 namespace:action', () => {
  const channels = [...ipcSrc.matchAll(/handle\('([^']+)'/g)].map((m) => m[1])
  assert.ok(channels.length > 0)
  for (const ch of channels) {
    assert.match(ch, /^[a-z][a-z-]*:[a-z][a-z-]*$/, `${ch} 不符合 namespace:action`)
  }
})

// ⑰ 脱敏不变式：除 keys:reveal 外，任何 IPC 负载不得回传完整 key
test('⑰ 脱敏不变式：plaintext key 只在 keys:reveal 单一出口', () => {
  // 主进程侧：明文 key 的读取点（resolvePoolKey / listPoolEntriesPlain）
  // 只允许出现在 agentWriters（Mode A 直连凭据路径）与 keyStore 内部，
  // ipc.ts 不得把 pool 明文注入任何非 reveal 的返回体。
  const revealHandlers = ipcSrc.match(/revealKey\(/g) || []
  assert.ok(revealHandlers.length >= 1, 'keys:reveal 未接入 revealKey')
  // agents:apply 的 direct 路径经 resolvePoolKey（agentWriters 内部），
  // 返回体只含 detail/targetPath，不含 key 值：
  const applyBlock = ipcSrc.match(/agents:apply[\s\S]{0,900}/)
  assert.ok(applyBlock, 'agents:apply handler 缺失')
  assert.ok(!/return\s+ok\(\{\s*key:/.test(applyBlock[0]), 'agents:apply 不得回传明文 key')
})

test('⑰ keyStore.listPool 输出全部脱敏（mask + fingerprint）', () => {
  assert.ok(keyStoreSrc.includes('maskKey'), 'keyStore 未实现脱敏函数')
  assert.ok(keyStoreSrc.includes('keyFingerprint'), 'keyStore 未实现指纹函数')
  // listPool 返回的 MaskedKey 结构不含 key 字段
  const listPoolBody = keyStoreSrc.match(/export async function listPool\(\)[\s\S]{0,1200}/)
  assert.ok(listPoolBody, 'listPool 缺失')
  assert.ok(!/\bkey:\s*e\.key\b/.test(listPoolBody[0]), 'listPool 泄漏明文 key')
})

// ⑱ 新文件零硬编码：khy 代理端点必须来自 runtime 文件/env，不得写死 host:port。
// 注意：keyStore 的 BUILTIN_PRESETS 是公开参考目录（Ollama 等本地默认端口属
// 公开数据，真源在 backend providerPresets.js），不在本检查范围内。
test('⑱ keyManager 模块零硬编码端点（代理端点来源可审计）', () => {
  const files = [
    agentWritersSrc,
    read('src/main/keyManager/ipc.ts'),
    read('src/main/keyManager/health.ts'),
    read('src/main/keyManager/proxyStatus.ts'),
    read('src/main/keyManager/audit.ts')
  ]
  for (const src of files) {
    if (!src) continue
    // no literal host:port for the khy proxy (ports come from runtime files)
    const bad = src.match(/(localhost|127\.0\.0\.1):\d+/g)
    assert.equal(bad ? bad.length : 0, 0, `硬编码 host:port 字面量: ${(bad || []).join(', ')}`)
  }
  // proxy endpoint derivation must be runtime-file driven
  assert.ok(
    read('src/main/keyManager/proxyStatus.ts').includes('proxy_server_runtime.json') ||
      read('src/main/keyManager/proxyStatus.ts').includes('PROXY_RUNTIME_FILE'),
    '代理端点必须来自 runtime 文件（零硬编码）'
  )
})

test('⑱ agentWriters 四级 backend 解析（env → 仓库 → 便携根 → 内置降级）', () => {
  assert.ok(agentWritersSrc.includes('KHY_BACKEND_SERVICES'), '缺 KHY_BACKEND_SERVICES 一级')
  assert.ok(agentWritersSrc.includes('KHY_PORTABLE_ROOT') || agentWritersSrc.includes('KHYQUANT_PORTABLE_ROOT'), '缺便携根一级')
  assert.ok(agentWritersSrc.includes('backend-resolve-failed'), '缺内置降级审计事件')
})
