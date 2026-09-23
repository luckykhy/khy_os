export declare const AGENT_ITEM_KINDS: Set<string>;
export interface AgentItem {
    id: string;
    kind: string;
    name: string;
    description: string;
    content: string;
    enabled: boolean;
    source: string;
    createdAt: number;
    updatedAt: number;
}
export declare function listItems(kind: string): Promise<{
    ok: boolean;
    items?: AgentItem[];
    error?: string;
}>;
export declare function createItem(kind: string, input: unknown): Promise<{
    ok: boolean;
    item?: AgentItem;
    error?: string;
}>;
export declare function setItemEnabled(kind: string, id: string, enabled: boolean): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function deleteItem(kind: string, id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function importItems(kind: string, rows: unknown): Promise<{
    ok: boolean;
    created?: number;
    skipped?: number;
    error?: string;
}>;
export interface MigrationSection {
    dir: string;
    kind: string;
    label: string;
}
export interface MigrationSource {
    id: string;
    label: string;
    homeDir: string;
    sections: MigrationSection[];
}
export declare function scanMigrations(): Promise<{
    ok: boolean;
    sources?: Array<{
        id: string;
        label: string;
        found: boolean;
        counts: Array<{
            label: string;
            count: number;
        }>;
    }>;
    error?: string;
}>;
export declare function importMigration(sourceId: string): Promise<{
    ok: boolean;
    created?: number;
    skipped?: number;
    error?: string;
}>;
export declare function migrationDataHome(): string;
//# sourceMappingURL=agentItemStore.d.ts.map