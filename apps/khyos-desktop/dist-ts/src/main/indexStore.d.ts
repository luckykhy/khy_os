export interface CodeIndex {
    id: string;
    name: string;
    root: string;
    fileCount: number;
    totalBytes: number;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
}
export declare function listIndexes(): Promise<{
    ok: boolean;
    indexes?: CodeIndex[];
    error?: string;
}>;
export declare function createIndex(input: unknown): Promise<{
    ok: boolean;
    index?: CodeIndex;
    error?: string;
}>;
export declare function rebuildIndex(id: string): Promise<{
    ok: boolean;
    index?: CodeIndex;
    error?: string;
}>;
export declare function setIndexEnabled(id: string, enabled: boolean): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function deleteIndex(id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=indexStore.d.ts.map