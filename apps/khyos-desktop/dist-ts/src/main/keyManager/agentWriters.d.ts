import type { Card } from './types.ts';
export declare function resolveBackendServicesRoot(): string | null;
export declare function _auditBackendResolution(): Promise<void>;
export declare function agentTargetPath(app: string): string;
export interface PreflightResult {
    ok: boolean;
    reason?: string;
    warning?: string;
}
export declare function preflight(app: string, card: Card, mode: 'proxy' | 'direct'): PreflightResult;
export interface ApplyResult {
    ok: boolean;
    app: string;
    error?: string;
    detail?: string;
    targetPath?: string;
}
export declare function applyProxyMode(app: string, card: Card): Promise<ApplyResult>;
export declare function applyDirectMode(app: string, card: Card): Promise<ApplyResult>;
export declare function revertAgent(app: string): Promise<ApplyResult>;
export interface MatrixRow {
    app: string;
    label: string;
    writer: 'builtin';
    mode: 'none' | 'proxy' | 'direct';
    cardId: string;
    targetPath: string;
    lastApplied: string;
    hint: string;
}
export declare function agentMatrix(): Promise<MatrixRow[]>;
//# sourceMappingURL=agentWriters.d.ts.map