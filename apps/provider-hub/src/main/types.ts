// types — Provider Card Hub 共享类型（DESIGN-ARCH-094 §4）。
// 卡片 schema 与 services/backend ccSwitch store（DATA_FILE=cc_switch.json,
// SCHEMA_VERSION=1）保持同构：三方（khy CLI / khyos-desktop keyManager /
// provider-hub）读同一文件，字段不得分叉。

export type CardProtocol = 'openai' | 'anthropic' | 'openai_responses' | 'gemini'

export interface Card {
  id: string
  name: string
  baseUrl: string
  /** 密钥池引用（api_keys.json 的 keyId），卡片本身不含凭据 */
  keyId: string
  protocol: CardProtocol | string
  wireApi?: 'chat' | 'responses'
  models: string[]
  defaultModel: string
  apps: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentModeEntry {
  mode: 'proxy' | 'direct'
  cardId: string
  ts: string
}

export interface CcSwitchDoc {
  schemaVersion: number
  cards: Card[]
  /** app → 当前激活卡 cardId（cc-switch「启用」语义） */
  active: Record<string, string>
  /** app → 备卡队列（failover：P1=active，队列按优先级 P2… 排列） */
  failover?: Record<string, string[]>
  apps: Record<string, unknown>
  agentMode?: Record<string, AgentModeEntry>
}

export interface PoolEntry {
  key: string
  endpoint?: string
  priority?: number
  label?: string
  id?: string
  disabled?: boolean
}

export interface MaskedPoolKey {
  keyId: string
  label: string
  endpoint: string
  mask: string
  fingerprint: string
}

export const CC_SWITCH_FILE = 'cc_switch.json'
export const API_KEYS_FILE = 'api_keys.json'
export const AUDIT_FILE = 'provider_hub_audit.jsonl'
export const REVEAL_COOLDOWN_MS = 30_000
