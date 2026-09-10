// Typed access to the __KHYOS__ preload surface (KeyManager extension,
// DESIGN-ARCH-091 §6). The preload exposes plain invoke wrappers; this module
// adds the result contracts so renderer code stays type-safe.

export interface MaskedKey {
  keyId: string
  label: string
  endpoint: string
  priority: number
  enabled: boolean
  source: 'pool' | 'env'
  mask: string
  fingerprint: string
}

export interface ProviderView {
  id: string
  keys: MaskedKey[]
}

export interface EnvOverlayView {
  provider: string
  envName: string
  set: boolean
}

export interface Card {
  id: string
  name: string
  baseUrl: string
  keyId: string
  protocol: string
  wireApi?: string
  models: string[]
  defaultModel: string
  apps: string[]
  enabled: boolean
}

export interface Preset {
  id: string
  label: string
  baseUrl: string
  apiFormat: string
  defaultModel: string
  keyField: string
  source: 'backend' | 'builtin-fallback'
}

export interface MatrixRow {
  app: string
  label: string
  writer: string
  mode: 'none' | 'proxy' | 'direct'
  cardId: string
  targetPath: string
  lastApplied: string
  hint: string
}

export interface ProxyState {
  running: boolean
  endpoint: string
  host: string
  port: number | null
  relayFingerprint: string | null
  detail: string
}

export interface HealthResult {
  keyId: string
  provider: string
  endpoint: string
  status: string
  detail: string
  latencyMs: number
}

export interface AuditEntry {
  ts: string
  op: string
  target?: string
  fingerprint?: string
  detail?: string
}

export type KhyOsApi = Record<string, (...args: never[]) => Promise<unknown>> & {
  keysList(): Promise<{ ok: boolean; data?: { providers: ProviderView[]; envOverlay: EnvOverlayView[] }; error?: string }>
  keysAdd(input: { provider: string; label?: string; endpoint?: string; key?: string; priority?: number }): Promise<{
    ok: boolean
    data?: { keyId: string; provider: string }
    error?: string
  }>
  keysUpdate(
    provider: string,
    keyId: string,
    patch: Record<string, unknown>
  ): Promise<{ ok: boolean; data?: { newKeyId: string; reattachedCards: number }; error?: string }>
  keysRemove(provider: string, keyId: string): Promise<{ ok: boolean; error?: string; blockedCards?: string[] }>
  keysToggle(provider: string, keyId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
  keysReveal(provider: string, keyId: string): Promise<{ ok: boolean; data?: { key: string }; error?: string }>
  keysImport(): Promise<{
    ok: boolean
    data?: { added: number; skipped: { name: string; reason: string }[] }
    error?: string
  }>
  providersList(): Promise<{ ok: boolean; data?: unknown[] }>
  providersAdd(p: Record<string, unknown>): Promise<{ ok: boolean }>
  providersRemove(id: string): Promise<{ ok: boolean }>
  endpointsPresets(): Promise<{ ok: boolean; data?: Preset[]; source?: string }>
  endpointsValidate(input: {
    endpoint: string
    protocol?: string
    key?: string
  }): Promise<{ ok: boolean; data?: { reachable: boolean; status?: number; latencyMs: number; error?: string }; error?: string }>
  modelsFetch(input: {
    endpoint: string
    protocol?: string
    key?: string
  }): Promise<{ ok: boolean; data?: { verified: boolean; models: string[]; error?: string }; error?: string }>
  cardsList(): Promise<{
    ok: boolean
    data?: { cards: Card[]; active: Record<string, string>; agentMode?: Record<string, { mode: string; cardId: string; ts: string }> }
  }>
  cardsAdd(input: Record<string, unknown>): Promise<{ ok: boolean; data?: { cardId: string }; error?: string }>
  cardsUpdate(cardId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
  cardsRemove(cardId: string): Promise<{ ok: boolean; error?: string }>
  agentsMatrix(): Promise<{ ok: boolean; data?: MatrixRow[]; apps?: string[]; labels?: Record<string, string> }>
  agentsApply(input: {
    app: string
    cardId: string
    mode: 'proxy' | 'direct'
  }): Promise<{ ok: boolean; data?: { detail?: string; targetPath?: string }; error?: string }>
  agentsRevert(app: string): Promise<{ ok: boolean; data?: { detail?: string }; error?: string }>
  proxyStatus(): Promise<{ ok: boolean; data?: ProxyState }>
  proxyStart(): Promise<{ ok: boolean; data?: { detail?: string }; error?: string }>
  healthProbe(input?: { keyId?: string }): Promise<{
    ok: boolean
    data?: { results: HealthResult[]; fingerprints?: Record<string, string>; masks?: Record<string, string>; timeoutMs?: number }
    error?: string
  }>
  healthAuditList(limit?: number): Promise<{ ok: boolean; data?: AuditEntry[] }>
  healthAuditExport(dest: string): Promise<{ ok: boolean; data?: { count: number }; error?: string }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function khyosApi(): KhyOsApi | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__KHYOS__ as KhyOsApi | null
}
