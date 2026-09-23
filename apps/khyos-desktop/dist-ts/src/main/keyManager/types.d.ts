export interface PoolEntry {
    key: string;
    endpoint: string;
    priority: number;
    label: string;
    id?: string;
    disabled?: boolean;
}
export interface MaskedKey {
    keyId: string;
    label: string;
    endpoint: string;
    priority: number;
    enabled: boolean;
    source: 'pool' | 'env';
    mask: string;
    fingerprint: string;
}
export interface ProviderView {
    id: string;
    keys: MaskedKey[];
}
export interface EnvOverlayView {
    provider: string;
    envName: string;
    set: boolean;
}
export interface Card {
    id: string;
    name: string;
    baseUrl: string;
    keyId: string;
    protocol: 'openai' | 'anthropic' | 'openai_responses' | 'gemini';
    wireApi?: 'chat' | 'responses';
    models: string[];
    defaultModel: string;
    apps: string[];
    enabled: boolean;
    createdAt?: string;
    updatedAt?: string;
}
export interface CcSwitchDoc {
    schemaVersion: number;
    cards: Card[];
    active: Record<string, string>;
    apps: Record<string, Record<string, unknown>>;
    agentMode?: Record<string, {
        mode: 'proxy' | 'direct';
        cardId: string;
        ts: string;
    }>;
}
export interface CustomProvider {
    id: string;
    name: string;
    endpoint: string;
    defaultModel?: string;
    protocol?: string;
    models?: string[];
}
export interface PresetView {
    id: string;
    label: string;
    baseUrl: string;
    apiFormat: string;
    defaultModel: string;
    keyField: string;
    source: 'backend' | 'builtin-fallback';
}
export interface AgentMatrixRow {
    app: string;
    label: string;
    writer: 'builtin' | 'ccswitch';
    mode: 'none' | 'proxy' | 'direct';
    cardId: string;
    targetPath: string;
    lastApplied: string;
    hint: string;
}
export interface HealthResult {
    keyId: string;
    provider: string;
    endpoint: string;
    status: 'ok' | 'auth' | 'rate' | 'upstream' | 'timeout' | 'reachable';
    detail: string;
    latencyMs: number;
}
export interface AuditEntry {
    ts: string;
    op: 'reveal' | 'reveal-rejected' | 'apply' | 'revert' | 'import' | 'add' | 'update' | 'remove' | 'toggle' | 'backend-resolve-failed' | 'backend-resolve-ok' | 'proxy-start' | 'error';
    target?: string;
    fingerprint?: string;
    detail?: string;
}
export declare const ENV_PROVIDER_MAP: Record<string, {
    keyEnv: string;
    endpointEnv: string;
}>;
export declare const P1_APPS: readonly ["claude-code", "opencode", "qodercli"];
export type P1App = (typeof P1_APPS)[number];
export declare const APP_LABELS: Record<string, string>;
export declare const REVEAL_COOLDOWN_MS = 60000;
export declare const PROBE_TIMEOUT_MS = 10000;
export declare const VALIDATE_TIMEOUT_MS = 3000;
export declare const PROBE_CONCURRENCY = 4;
export declare const PROXY_RUNTIME_FILE = "proxy_server_runtime.json";
export declare const PROXY_AUTH_FILE = "proxy_server_auth.json";
export declare const API_KEYS_FILE = "api_keys.json";
export declare const CUSTOM_PROVIDERS_FILE = "custom_providers.json";
export declare const CC_SWITCH_FILE = "cc_switch.json";
export declare const AUDIT_FILE = "key_manager_audit.jsonl";
//# sourceMappingURL=types.d.ts.map