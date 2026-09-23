// usage — 用量账本聚合（DESIGN-ARCH-094 P3 用量图表数据源）。
//
// 数据源：khy SSoT 用量文件 token_usage.json（services/backend
// tokenUsageService 同格式：daily[YYYY-MM-DD] = {inputTokens, outputTokens,
// totalTokens, requests, costUSD}）。候选路径：KHY_DATA_HOME（便携/dataHome）
// → KHY_PORTABLE_ROOT/.khyquant → 用户家目录 ~/.khyquant。
// fail-soft：缺失/损坏均如实回报，绝不抛。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DayUsage {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  costUSD: number
}

export interface UsageSummary {
  available: boolean
  days: DayUsage[]
  /** 数据源文件（可读时回填，便于 UI 标注来源） */
  source?: string
  error?: string
}

type UsageDoc = {
  daily?: Record<string, { inputTokens?: number; outputTokens?: number; totalTokens?: number; requests?: number; costUSD?: number }>
}

function usageCandidates(): string[] {
  // 显式 KHY_DATA_HOME 独占（测试隔离 + 便携确定性）；未设时走回退链
  const dataHome = process.env.KHY_DATA_HOME
  if (dataHome) return [path.join(dataHome, 'token_usage.json')]
  const out: string[] = []
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portable) out.push(path.join(portable, '.khyquant', 'token_usage.json'))
  out.push(path.join(os.homedir(), '.khyquant', 'token_usage.json'))
  return out
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 最近 N 天（含今天）的按日用量；缺日补零。文件缺失/损坏 → available:false。 */
export async function usageSummary(days = 7): Promise<UsageSummary> {
  const n = Math.max(1, Math.min(Number(days) || 7, 90))
  let file = ''
  let doc: UsageDoc | null = null
  for (const cand of usageCandidates()) {
    try {
      const raw = await fs.readFile(cand, 'utf-8')
      file = cand
      doc = JSON.parse(raw) as UsageDoc
      break
    } catch {
      continue
    }
  }
  if (!doc) {
    return {
      available: false,
      days: [],
      error: '无用量数据：token_usage.json 不存在或未记录（动作: 使用 khy 产生用量后重试 目标: dataHome/.khyquant）'
    }
  }
  const daily = doc.daily && typeof doc.daily === 'object' ? doc.daily : {}
  const out: DayUsage[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const key = dateKey(d)
    const e = daily[key] || {}
    out.push({
      date: key,
      inputTokens: num(e.inputTokens),
      outputTokens: num(e.outputTokens),
      totalTokens: num(e.totalTokens),
      requests: num(e.requests),
      costUSD: num(e.costUSD)
    })
  }
  return { available: true, days: out, source: file }
}
