// indexStore — file-backed code index registry for the 设置→索引库 page
// (ZC-ALIGN-001 P13). Registers workspace index snapshots with real stats
// read from disk at creation time (file count + total bytes via a single
// bounded walk). Deletion removes the registry entry; re-index recomputes
// stats. No background indexing service is claimed — the page honestly says
// 索引已停用 when an entry is disabled.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { dataHomeFile } from './keyManager/keyStore';
const INDEX_FILE = 'code_indexes.json';
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
]);
const TEXT_EXTS = new Set([
    '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.vue', '.css',
    '.html', '.yml', '.yaml', '.toml', '.ini', '.sh', '.bat', '.ps1', '.py', '.cjs', '.mjs',
]);
// Bounded single walk (Rule 3 spirit): one traversal, no long-running task.
// Depth/entry caps keep the create/re-index scan fast even on huge trees.
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;
function indexPath() {
    return dataHomeFile(INDEX_FILE);
}
async function ensureDir() {
    const dir = path.dirname(indexPath());
    if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
    }
}
async function loadDoc() {
    try {
        const raw = await fs.readFile(indexPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.indexes))
            return parsed;
    }
    catch {
        // Missing or invalid file → empty registry.
    }
    return { indexes: [] };
}
async function persist(doc) {
    await ensureDir();
    const tmpPath = indexPath() + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(doc, null, 2), 'utf-8');
    await fs.rename(tmpPath, indexPath());
}
// Single bounded traversal collecting text-file stats for a workspace root.
async function scanWorkspace(root) {
    let fileCount = 0;
    let totalBytes = 0;
    let entries = 0;
    const queue = [{ dir: root, depth: 0 }];
    try {
        await fs.access(root);
    }
    catch {
        return { error: `目录不可读（${root}）：请确认路径存在后重试` };
    }
    while (queue.length > 0 && entries < MAX_ENTRIES) {
        const { dir, depth } = queue.shift();
        if (depth >= MAX_DEPTH)
            continue;
        let dirents;
        try {
            dirents = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of dirents) {
            entries += 1;
            if (entries >= MAX_ENTRIES)
                break;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name))
                    queue.push({ dir: full, depth: depth + 1 });
            }
            else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
                try {
                    const stat = await fs.stat(full);
                    fileCount += 1;
                    totalBytes += stat.size;
                }
                catch {
                    // Unstatable file: don't count, don't abort the scan.
                }
            }
        }
    }
    return { fileCount, totalBytes };
}
export async function listIndexes() {
    const doc = await loadDoc();
    const indexes = [...doc.indexes].sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, indexes: indexes.map((ix) => ({ ...ix })) };
}
// 新建索引 — indexes the current workspace (process.cwd()), the only root
// this app can honestly claim; custom roots are a future picker away.
export async function createIndex(input) {
    const row = (input || {});
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : '当前工作区';
    const root = typeof row.root === 'string' && row.root.trim() ? path.resolve(row.root) : process.cwd();
    const doc = await loadDoc();
    if (doc.indexes.some((ix) => ix.root === root)) {
        return { ok: false, error: '该工作区已有索引：请在列表中选择「重建」刷新统计，或删除后重新创建' };
    }
    const scan = await scanWorkspace(root);
    if ('error' in scan)
        return { ok: false, error: scan.error };
    const now = Date.now();
    const index = {
        id: `index_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        root,
        fileCount: scan.fileCount,
        totalBytes: scan.totalBytes,
        enabled: true,
        createdAt: now,
        updatedAt: now,
    };
    doc.indexes.push(index);
    await persist(doc);
    return { ok: true, index };
}
// 重建 — rescan the same root, refreshing stats (真实重扫，非假装刷新).
export async function rebuildIndex(id) {
    const doc = await loadDoc();
    const ix = doc.indexes.find((x) => x.id === id);
    if (!ix) {
        return { ok: false, error: '未找到该索引，可能已被删除' };
    }
    const scan = await scanWorkspace(ix.root);
    if ('error' in scan)
        return { ok: false, error: scan.error };
    ix.fileCount = scan.fileCount;
    ix.totalBytes = scan.totalBytes;
    ix.updatedAt = Date.now();
    await persist(doc);
    return { ok: true, index: ix };
}
export async function setIndexEnabled(id, enabled) {
    const doc = await loadDoc();
    const ix = doc.indexes.find((x) => x.id === id);
    if (!ix) {
        return { ok: false, error: '未找到该索引，可能已被删除' };
    }
    ix.enabled = !!enabled;
    ix.updatedAt = Date.now();
    await persist(doc);
    return { ok: true };
}
export async function deleteIndex(id) {
    const doc = await loadDoc();
    const idx = doc.indexes.findIndex((x) => x.id === id);
    if (idx === -1) {
        return { ok: false, error: '未找到该索引，可能已被删除' };
    }
    doc.indexes.splice(idx, 1);
    await persist(doc);
    return { ok: true };
}
