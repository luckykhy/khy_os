import type { HealthResult } from './types.ts';
export interface ProbeTarget {
    keyId: string;
    provider: string;
    endpoint: string;
    key: string;
    protocol?: string;
}
export interface ProbeProgress {
    done: number;
    total: number;
    label: string;
}
export declare function statusHint(status: HealthResult['status']): string;
export declare function probeOne(t: ProbeTarget, timeoutMs?: number): Promise<HealthResult>;
export interface ProbeAllOptions {
    onProgress?: (p: ProbeProgress) => void;
    concurrency?: number;
    timeoutMs?: number;
}
export declare function probeAll(targets: ProbeTarget[], opts?: ProbeAllOptions): Promise<HealthResult[]>;
//# sourceMappingURL=health.d.ts.map