export interface ProxyRuntimeFile {
    http?: {
        enabled?: boolean;
        port?: number;
        host?: string;
        url?: string;
    };
    https?: {
        enabled?: boolean;
        port?: number;
        host?: string;
        url?: string;
    };
}
export interface ProxyStatus {
    running: boolean;
    endpoint: string;
    host: string;
    port: number | null;
    relayFingerprint: string | null;
    detail: string;
}
export declare function readProxyRuntime(): {
    running: boolean;
    endpoint: string;
    host: string;
    port: number | null;
};
export declare function readProxyToken(): string;
export declare function proxyStatus(): Promise<ProxyStatus>;
export declare function _proxyFiles(): {
    runtime: string;
    auth: string;
};
export declare function startProxy(): Promise<{
    ok: boolean;
    error?: string;
    detail?: string;
}>;
//# sourceMappingURL=proxyStatus.d.ts.map