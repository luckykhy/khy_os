// agentWriters.test.mjs — Mode B 一键激活单测（DESIGN-ARCH-091 §10.1 ⑧-⑫⑲㉑）。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/agentWriters.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// isolate dataHome + fake HOME/XDG BEFORE import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-writers-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYOS_DESKTOP_REPO_ROOT = path.join(tmp, 'repo') // empty repo root → backend unresolved
fs.mkdirSync(path.join(process.env.KHYOS_DESKTOP_REPO_ROOT, 'services', 'backend', 'src', 'services'), { recursive: true })
// no providerPresets.js in that fake services dir → backend resolution fails → built-in writers
process.env.HOME = path.join(tmp, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg')
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.OPENCODE_CONFIG
delete process.env.OPENCODE_CONFIG_DIR
delete process.env.KHY_ENV_FILE

const ks = await import('../src/main/keyManager/keyStore.ts')
const aw = await import('../src/main/keyManager/agentWriters.ts')
const ps = await import('../src/main/keyManager/proxyStatus.ts')

// shared fixture: proxy runtime + auth (relay sentinel, NOT a real provider key)
function makeProxyFiles(endpoint = 'http://127.0.0.1:31288') {
  const files = ps._proxyFiles()
  fs.mkdirSync(path.dirname(files.runtime), { recursive: true })
  fs.writeFileSync(
    files.runtime,
    JSON.stringify({ http: { enabled: true, port: Number(endpoint.split(':').pop()), host: '127.0.0.1', url: endpoint } }),
    'utf-8'
  )
  fs.writeFileSync(files.auth, JSON.stringify({ authToken: 'RELAY-SENTINEL-TOKEN' }), 'utf-8')
}

test('⑧ claude-code Mode B：settings.json env 块正确 + 无关字段保留', async () => {
  makeProxyFiles()
  // pre-existing unrelated config must survive the merge-write
  const claudeDir = path.join(process.env.HOME, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const cfg = path.join(claudeDir, 'settings.json')
  fs.writeFileSync(cfg, JSON.stringify({ env: { MY_UNRELATED: 'keep-me' }, permissions: { allow: ['Read'] } }), 'utf-8')

  const key = await ks.addKey({ provider: 'agnes', key: 'sk-REAL-PROVIDER-KEY', endpoint: 'https://apihub.agnes-ai.com/v1' })
  const card = await ks.addCard({
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    keyId: key.keyId,
    protocol: 'openai',
    defaultModel: 'agnes-2.5-flash',
    apps: ['claude-code']
  })
  const r = await aw.applyProxyMode('claude-code', (await ks.loadCcDoc()).cards.find((c) => c.id === card.cardId))
  assert.ok(r.ok, r.error)
  const written = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
  assert.equal(written.env.MY_UNRELATED, 'keep-me', 'unrelated fields preserved')
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:31288', 'points at khy proxy root')
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'RELAY-SENTINEL-TOKEN', 'relay token, not the provider key')
  assert.equal(written.env.ANTHROPIC_MODEL, 'agnes-2.5-flash')
  assert.ok(fs.existsSync(`${cfg}.pre-khy.bak`), 'backup taken before mutation')
})

test('⑨ opencode Mode B：provider 树 merge 正确（便携 XDG 路径）', async () => {
  makeProxyFiles('http://127.0.0.1:31288')
  const ocDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  fs.mkdirSync(ocDir, { recursive: true })
  const cfg = path.join(ocDir, 'opencode.json')
  fs.writeFileSync(cfg, JSON.stringify({ provider: { deepseek: { name: 'DeepSeek', options: { baseURL: 'https://api.deepseek.com/v1' } } } }), 'utf-8')

  const card = (await ks.loadCcDoc()).cards.find((c) => c.name === 'Agnes')
  const r = await aw.applyProxyMode('opencode', card)
  assert.ok(r.ok, r.error)
  const written = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
  assert.ok(written.provider.deepseek, 'existing provider preserved')
  assert.ok(written.provider.khy, 'khy aggregate provider written')
  assert.equal(written.provider.khy.npm, '@ai-sdk/openai-compatible')
  assert.equal(written.provider.khy.options.apiKey, 'RELAY-SENTINEL-TOKEN')
  assert.equal(written.model, 'khy/agnes-2.5-flash', 'top-level default model = provider/model')
})

test('⑲ Mode B 产物不含真实 provider key 明文（grep 不变式）', async () => {
  makeProxyFiles()
  const claudeCfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude', 'settings.json'), 'utf-8'))
  const ocCfg = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf-8'))
  for (const doc of [claudeCfg, ocCfg]) {
    const text = JSON.stringify(doc)
    assert.ok(!text.includes('sk-REAL-PROVIDER-KEY'), 'real provider key leaked into agent config')
    assert.ok(text.includes('RELAY-SENTINEL-TOKEN'), 'relay sentinel present instead')
  }
})

test('⑩ preflight：协议不匹配 → 拒绝且不落盘', async () => {
  const geminiCard = {
    id: 'c_g',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyId: '',
    protocol: 'gemini',
    models: ['gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-pro',
    apps: ['opencode'],
    enabled: true
  }
  const pre = aw.preflight('opencode', geminiCard, 'direct')
  assert.ok(!pre.ok, 'gemini protocol rejected for opencode')
  assert.match(pre.reason || '', /OpenCode 支持 openai\/anthropic/)
  const ocCfg = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
  const text = fs.readFileSync(ocCfg, 'utf-8')
  assert.ok(!text.includes('generativelanguage'), 'rejected preflight must not touch the file')
})

test('⑫ backend 不可解析 → 内置 writer 接管 + 审计记录降级事件', async () => {
  const root = aw.resolveBackendServicesRoot()
  assert.equal(root, null, 'no backend services in fake repo root')
  await aw._auditBackendResolution()
  const audit = fs.readFileSync(ks.dataHomeFile('key_manager_audit.jsonl'), 'utf-8')
  assert.ok(audit.includes('backend-resolve-failed'), 'degrade event audited')
})

test('㉑ qodercli 门控：proxy 未运行 → 激活给出诚实错误，不写 .env', async () => {
  // remove the proxy runtime file to simulate "not running"
  const files = ps._proxyFiles()
  fs.rmSync(files.runtime, { force: true })
  const card = (await ks.loadCcDoc()).cards[0]
  const r = await aw.applyProxyMode('qodercli', card)
  assert.ok(!r.ok, 'qoder activation must fail when proxy is down')
  assert.match(r.error || '', /khy 代理未运行/)
  // and no .env was touched
  const envFile = aw.agentTargetPath('qodercli')
  assert.ok(!fs.existsSync(envFile) || !fs.readFileSync(envFile, 'utf-8').includes('KHY_QODER_PROXY'))
})

test('㉑b qodercli 门控（proxy 运行）：.env 写 KHY_QODER_PROXY=true + 端点回填', async () => {
  makeProxyFiles('http://127.0.0.1:31288')
  const card = (await ks.loadCcDoc()).cards[0]
  const r = await aw.applyProxyMode('qodercli', card)
  assert.ok(r.ok, r.error)
  const envFile = aw.agentTargetPath('qodercli')
  const text = fs.readFileSync(envFile, 'utf-8')
  assert.ok(text.includes('KHY_QODER_PROXY=true'))
  assert.ok(text.includes('QODER_PROXY_ENDPOINT=http://127.0.0.1:31288'))
  // revert restores the .env backup
  const rev = await aw.revertAgent('qodercli')
  assert.ok(rev.ok)
})

test('agents:revert：claude-code 回滚 .pre-khy.bak 逐字节一致（E4 语义）', async () => {
  const cfg = path.join(process.env.HOME, '.claude', 'settings.json')
  const bak = fs.readFileSync(`${cfg}.pre-khy.bak`, 'utf-8')
  const r = await aw.revertAgent('claude-code')
  assert.ok(r.ok)
  assert.equal(fs.readFileSync(cfg, 'utf-8'), bak, 'byte-identical restore')
})
