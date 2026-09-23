import type { Card, CcSwitchDoc, CustomProvider, EnvOverlayView, PoolEntry, PresetView, ProviderView } from './types.ts';
export declare const SETTINGS_FILE = "settings.json";
export declare function resolveRepoRoot(): string | null;
export declare function baseHomeFile(name: string): string;
export declare function getDataHome(): string;
export declare function _resetDataHomeCache(): void;
export declare function dataHomeFile(name: string): string;
export declare function atomicWriteJson(file: string, data: unknown): Promise<void>;
export interface SafeReadResult<T> {
    data: T;
    recovered: boolean;
}
export declare function safeReadJson<T>(file: string, fallback: T): Promise<SafeReadResult<T>>;
export declare function keyFingerprint(key: string): string;
export declare function maskKey(key: string): string;
export declare function keyIdFor(provider: string, key: string): string;
type PoolDoc = Record<string, PoolEntry[]>;
export declare function savePool(doc: PoolDoc): Promise<void>;
export interface PoolListResult {
    providers: ProviderView[];
    envOverlay: EnvOverlayView[];
}
export interface PlainEntry {
    provider: string;
    key: string;
    endpoint: string;
    label: string;
    disabled?: boolean;
}
export declare function listPoolEntriesPlain(): Promise<PlainEntry[]>;
export declare function listPool(): Promise<PoolListResult>;
export interface AddKeyResult {
    ok: boolean;
    keyId?: string;
    provider?: string;
    error?: string;
}
export declare function addKey(input: {
    provider: string;
    label?: string;
    endpoint?: string;
    key?: string;
    priority?: number;
}): Promise<AddKeyResult>;
export interface UpdateKeyResult {
    ok: boolean;
    newKeyId?: string;
    error?: string;
    reattachedCards?: number;
}
export declare function updateKey(provider: string, keyId: string, patch: {
    label?: string;
    endpoint?: string;
    key?: string;
    priority?: number;
}): Promise<UpdateKeyResult>;
export interface RemoveKeyResult {
    ok: boolean;
    error?: string;
    blockedCards?: string[];
}
export declare function removeKey(provider: string, keyId: string): Promise<RemoveKeyResult>;
export declare function toggleKey(provider: string, keyId: string, enabled: boolean): Promise<{
    ok: boolean;
    error?: string;
}>;
export interface RevealResult {
    ok: boolean;
    key?: string;
    error?: string;
}
export declare function revealKey(provider: string, keyId: string): Promise<RevealResult>;
export declare function _resetRevealWindow(): void;
export declare function listCustomProviders(): Promise<CustomProvider[]>;
export declare function addCustomProvider(p: CustomProvider): Promise<{
    ok: boolean;
}>;
export declare function removeCustomProvider(id: string): Promise<{
    ok: boolean;
}>;
export declare function loadCcDoc(): Promise<CcSwitchDoc>;
export declare function saveCcDoc(doc: CcSwitchDoc): Promise<void>;
export interface AddCardResult {
    ok: boolean;
    cardId?: string;
    error?: string;
}
export declare function addCard(input: {
    name: string;
    baseUrl: string;
    keyId: string;
    protocol: Card['protocol'];
    wireApi?: 'chat' | 'responses';
    models?: string[];
    defaultModel?: string;
    apps?: string[];
}): Promise<AddCardResult>;
export declare function updateCard(cardId: string, patch: Partial<Pick<Card, 'name' | 'baseUrl' | 'keyId' | 'protocol' | 'wireApi' | 'models' | 'defaultModel' | 'apps' | 'enabled'>>): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function removeCard(cardId: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export interface ImportResult {
    added: number;
    skipped: {
        name: string;
        reason: string;
    }[];
}
export declare function importMarkdown(markdown: string): Promise<ImportResult>;
export interface FetchModelsResult {
    ok: boolean;
    verified: boolean;
    models: string[];
    error?: string;
}
export declare function fetchModels(endpoint: string, protocol: string, key: string, timeoutMs?: number): Promise<FetchModelsResult>;
export interface ValidateEndpointResult {
    ok: boolean;
    reachable: boolean;
    status?: number;
    latencyMs: number;
    error?: string;
}
export declare function validateEndpoint(endpoint: string, protocol: string, key: string, timeoutMs?: number): Promise<ValidateEndpointResult>;
export declare function auditFilePath(): string;
export declare function loadPresets(force?: boolean): Promise<PresetView[]>;
export declare function _resetPresetCache(): void;
export {};
//# sourceMappingURL=keyStore.d.ts.map