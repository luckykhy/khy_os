// proxyStatus — khy 本地网关运行时状态发现（DESIGN-ARCH-094 §4，零硬编码端点）。
//
// 端点唯一来源：dataHome 下 proxy_server_runtime.json（khy 网关启动时动态写入）
// 或 env KHY_PROXY_ENDPOINT 显式覆盖。本模块绝不写死 host:port（契约 C4）。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getDataHome } from './providers.ts'

export const PROXY_RUNTIME_FILE = 'proxy_server_runtime.json'

export interface ProxyStatus {
  running: boolean
  endpoint: string
  port: number
  pid?: number
  startedAt?: string
  source: 'runtime-file' | 'env' | 'absent'
}

/** 读取网关运行时文件（缺失/损坏 → running:false，fail-soft）。 */
export async function proxyStatus(): Promise<ProxyStatus> {
  const envEndpoint = process.env.KHY_PROXY_ENDPOINT
  if (envEndpoint) {
    return { running: true, endpoint: envEndpoint, port: 0, source: 'env' }
  }
  const file = path.join(getDataHome(), PROXY_RUNTIME_FILE)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const doc = JSON.parse(raw) as { running?: boolean; endpoint?: string; port?: number; pid?: number; startedAt?: string }
    const endpoint = doc.endpoint || ''
    const port = Number(doc.port) || 0
    const fresh = doc.startedAt ? Date.now() - Date.parse(doc.startedAt) < 5 * 60_000 : true
    return {
      running: Boolean(doc.running) && endpoint !== '' && fresh,
      endpoint,
      port,
      pid: doc.pid,
      startedAt: doc.startedAt,
      source: 'runtime-file'
    }
  } catch {
    return { running: false, endpoint: '', port: 0, source: 'absent' }
  }
}

/**
 * M1：网关启动不在本应用职责内（khy 后端 SSoT）——返回具体修复指引，
 * 状态透明（规则 2.2）：说明缺什么 + 怎么做，不假装成功。
 */
export async function startProxy(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const status = await proxyStatus()
  if (status.running) {
    return { ok: true, detail: `网关已在运行（端点 ${status.endpoint || '(env)'}，发现源: ${status.source}）` }
  }
  return {
    ok: false,
    error: '本地网关未运行：请在终端执行 khy gateway manage 启动 khy 后端，或设置 env KHY_PROXY_ENDPOINT 指向已运行网关；provider-hub 只读运行时文件发现端口，不代启服务'
  }
}
