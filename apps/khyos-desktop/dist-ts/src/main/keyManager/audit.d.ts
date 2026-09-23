import type { AuditEntry } from './types.ts';
export declare function auditPath(): string;
export declare function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void>;
export declare function listAudit(limit?: number): Promise<AuditEntry[]>;
export declare function exportAudit(destFile: string): Promise<{
    ok: boolean;
    count: number;
    error?: string;
}>;
export declare function _auditFile(): string;
//# sourceMappingURL=audit.d.ts.map