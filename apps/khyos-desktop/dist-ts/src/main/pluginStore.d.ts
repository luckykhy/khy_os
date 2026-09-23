export interface PluginComponents {
    skills: number;
    commands: number;
    hooks: number;
    mcp: number;
    agents: number;
    lsp: number;
}
export interface Plugin {
    id: string;
    name: string;
    version: string;
    description: string;
    source: string;
    enabled: boolean;
    installedAt: number;
    installPath: string;
    updateAvailable?: boolean;
    components: PluginComponents;
}
export declare function installPlugin(input: {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    marketplace?: string;
    components?: unknown;
}): Promise<{
    ok: boolean;
    plugin?: Plugin;
    error?: string;
}>;
export declare function getPlugins(): Promise<Plugin[]>;
export declare function setPluginEnabled(id: string, enabled: boolean): Promise<{
    ok: boolean;
    plugin?: Plugin;
    error?: string;
}>;
export declare function uninstallPlugin(id: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function checkPluginUpdates(): Promise<{
    ok: boolean;
    count: number;
    error?: string;
}>;
//# sourceMappingURL=pluginStore.d.ts.map