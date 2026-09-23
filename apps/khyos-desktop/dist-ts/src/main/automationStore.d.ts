export type ScheduleKind = 'minutes' | 'daily' | 'weekdays';
export interface AutomationRun {
    trigger: 'schedule' | 'manual';
    status: 'running' | 'succeeded' | 'failed' | 'skipped';
    startedAt: number;
    durationMs?: number;
    error?: string;
    resultPreview?: string;
}
export interface Automation {
    id: string;
    title: string;
    prompt: string;
    schedule: {
        kind: ScheduleKind;
        intervalMinutes?: number;
        time?: string;
    };
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    nextRunAt: number | null;
    runCount: number;
    maxRuns?: number;
    runs: AutomationRun[];
}
export declare function computeNextRunAt(a: Automation, from?: number): number | null;
export declare function getAutomations(): Promise<Automation[]>;
export declare function createAutomation(input: {
    title?: string;
    prompt?: string;
    schedule?: unknown;
    maxRuns?: number;
}): Promise<{
    ok: boolean;
    automation?: Automation;
    error?: string;
}>;
export declare function updateAutomation(id: string, patch: {
    title?: string;
    prompt?: string;
    schedule?: unknown;
    enabled?: boolean;
    maxRuns?: number | null;
    nextRunAt?: number | null;
}): Promise<{
    ok: boolean;
    automation?: Automation;
    error?: string;
}>;
export declare function deleteAutomation(id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function recordRunStart(id: string, trigger: AutomationRun['trigger']): Promise<{
    ok: boolean;
    automation?: Automation;
    error?: string;
}>;
export declare function recordRunSkipped(id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function recordRunEnd(id: string, startedAt: number, status: 'succeeded' | 'failed', extra: {
    durationMs: number;
    error?: string;
    resultPreview?: string;
}): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=automationStore.d.ts.map