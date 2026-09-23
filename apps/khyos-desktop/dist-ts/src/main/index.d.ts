export interface GitStatusResult {
    ok: boolean;
    state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error';
    branch?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    changes?: {
        path: string;
        status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
        staged: boolean;
    }[];
    error?: string;
}
//# sourceMappingURL=index.d.ts.map