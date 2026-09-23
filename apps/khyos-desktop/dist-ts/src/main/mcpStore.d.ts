export interface McpServer {
    id: string;
    name: string;
    command: string;
    enabled: boolean;
    createdAt: number;
}
export declare function getMcpServers(): Promise<McpServer[]>;
export declare function createMcpServer(input: {
    name?: unknown;
    command?: unknown;
    enabled?: unknown;
}): Promise<{
    ok: boolean;
    server?: McpServer;
    error?: string;
}>;
export declare function setMcpServerEnabled(id: string, enabled: boolean): Promise<{
    ok: boolean;
    server?: McpServer;
    error?: string;
}>;
export declare function deleteMcpServer(id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function importMcpServers(rows: unknown): Promise<{
    ok: boolean;
    created: number;
    skipped: number;
    error?: string;
}>;
//# sourceMappingURL=mcpStore.d.ts.map