// proxyStatus — khy local proxy (gateway/proxyServer.js) discovery for the
// Key/Endpoint Manager (DESIGN-ARCH-091 §8b.3 Mode B).
//
// Zero hardcoding (repo rule 1): the actual port/host come from
// <dataHome>/proxy_server_runtime.json (written by proxyServer on start); the
// relay credential from <dataHome>/proxy_server_auth.json. A stale runtime
// file with no live listener surfaces as running:false after the /health
// probe, so the UI always shows the truthful state (rule 2).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getDataHome } from './keyStore.ts'
import { PROXY_AUTH_FILE, PROXY_RUNTIME_FILE, VALIDATE_TIMEOUT_MS } from './types.ts'
import { keyFingerprint } from './keyStore.ts'

export interface ProxyRuntimeFile {
  http?: { enabled?: boolean; port?: number; host?: string; url?: string }
  https?: { enabled?: boolean; port?: number; host?: string; url?: string }
}

export interface ProxyStatus {
  running: boolean
  endpoint: string
  host: string
  port: number | null
  relayFingerprint: string | null
  detail: string
}

function runtimeFile(): string {
  return path.join(getDataHome(), PROXY_RUNTIME_FILE)
}

function authFile(): string {
  return path.join(getDataHome(), PROXY_AUTH_FILE)
}

// sync read: callers (IPC) run in the main process where a sync JSON read is
// fine; missing file → not running.
export function readProxyRuntime(): { running: boolean; endpoint: string; host: string; port: number | null } {
  try {
    const raw = readFileSync(runtimeFile(), 'utf-8')
    const rt = JSON.parse(raw) as ProxyRuntimeFile
    const http = rt.http
    if (http?.enabled && http.port) {
      const host = http.host || '127.0.0.1'
      const endpoint = http.url || `http://${host}:${http.port}`
      return { running: true, endpoint, host, port: http.port }
    }
    const https = rt.https
    if (https?.enabled && https.port) {
      const host = https.host || '127.0.0.1'
      const endpoint = https.url || `https://${host}:${https.port}`
      return { running: true, endpoint, host, port: https.port }
    }
  } catch {
    /* no runtime file yet */
  }
  return { running: false, endpoint: '', host: '', port: null }
}

export function readProxyToken(): string {
  try {
    const raw = readFileSync(authFile(), 'utf-8')
    const parsed = JSON.parse(raw) as { authToken?: string }
    return parsed.authToken || ''
  } catch {
    return ''
  }
}

export async function proxyStatus(): Promise<ProxyStatus> {
  const rt = readProxyRuntime()
  const token = readProxyToken()
  if (!rt.running) {
    return {
      running: false,
      endpoint: '',
      host: '',
      port: null,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: 'khy 代理未运行：启动本地网关后重试（动作: 启动本地网关 目标: 127.0.0.1）'
    }
  }
  // liveness probe (short I/O, 3s — handshake exception class)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS)
  let live = false
  try {
    const res = await fetch(`${rt.endpoint.replace(/\/+$/, '')}/health`, { signal: ctrl.signal })
    live = res.status >= 200 && res.status < 500
  } catch {
    live = false
  }
  clearTimeout(timer)
  if (!live) {
    return {
      running: false,
      endpoint: rt.endpoint,
      host: rt.host,
      port: rt.port,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: 'khy 代理运行时文件已过期：端口无响应，请启动本地网关（动作: 重启网关 目标: 127.0.0.1）'
    }
  }
  return {
    running: true,
    endpoint: rt.endpoint,
    host: rt.host,
    port: rt.port,
    relayFingerprint: token ? keyFingerprint(token) : null,
    detail: `khy 代理运行中：${rt.endpoint}（模型/密钥切换为纯 khy 侧操作）`
  }
}

// test seam
export function _proxyFiles(): { runtime: string; auth: string } {
  return { runtime: runtimeFile(), auth: authFile() }
}

// one-click gateway start (spec §5.2: proxy 未运行 → 提供一键启动). Delegates
// to the backend proxyServer module when resolvable; honest fail-soft message
// when the backend is absent (rule 2.2 error template).
export async function startProxy(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const { resolveBackendServicesRoot } = await import('./agentWriters.ts')
  const root = resolveBackendServicesRoot()
  if (!root) {
    return {
      ok: false,
      error: '本地网关启动失败：未找到 backend 服务（env KHY_BACKEND_SERVICES 或仓库内 services/backend），请改用 khy CLI 启动网关'
    }
  }
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(path.join(root, 'noop.js'))
    const proxyServer = req(path.join(root, 'gateway/proxyServer.js'))
    if (proxyServer.isRunning()) {
      return { ok: true, detail: '本地网关已在运行' }
    }
    await proxyServer.start()
    await new Promise((r) => setTimeout(r, 500))
    const st = await proxyStatus()
    return st.running
      ? { ok: true, detail: `本地网关已启动：${st.endpoint}` }
      : { ok: false, error: '本地网关启动中：500ms 后仍未就绪，请查看网关日志（动作: 检查日志 目标: 本地网关）' }
  } catch (e) {
    return { ok: false, error: `本地网关启动失败：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` }
  }
}

