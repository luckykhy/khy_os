// mcpStore — file-backed user-defined MCP server registry for the main
// process, powering the settings MCP page (ZC-ALIGN-003 §2, a11y s-32).
// Mirrors pluginStore/automationStore: JSON file under the BASE data home,
// atomic .tmp+rename writes, defaults on read, in-memory cache on write.
//
// Plugin-hosted servers are NOT stored here — they are derived live from
// pluginStore entries with components.mcp > 0 (the host provides them, so
// the MCP page only renders their status, read-only). This registry holds
// only user-installed servers (新建/导入 entries), and all writes go through
// the main IPC 正门 (Rule: never write the state file directly).
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { baseHomeFile } from './keyManager/keyStore';
const MCP_FILE = 'mcp_servers.json';
function mcpPath() {
    return baseHomeFile(MCP_FILE);
}
async function ensureDir() {
    const dir = path.dirname(mcpPath());
    if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
    }
}
let cache = null;
async function load() {
    if (cache)
        return cache;
    let stored = [];
    try {
        const raw = await fs.readFile(mcpPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.servers))
            stored = parsed.servers;
    }
    catch {
        stored = [];
    }
    cache = stored;
    return cache;
}
async function persist(list) {
    await ensureDir();
    const tmpPath = mcpPath() + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify({ servers: list }, null, 2), 'utf-8');
    await fs.rename(tmpPath, mcpPath());
    cache = list;
}
export async function getMcpServers() {
    // Shallow copy so callers cannot mutate the cache in place.
    return [...(await load())];
}
// 新建 MCP 服务器 — validates name + transport, writes through the registry.
export async function createMcpServer(input) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!name) {
        return { ok: false, error: '服务器名称不能为空：请填写名称后保存' };
    }
    if (!command) {
        return { ok: false, error: '启动命令/URL 不能为空：请填写 stdio 命令或 http(s) URL 后保存' };
    }
    const isUrl = /^https?:\/\//i.test(command);
    const looksLikeCommand = command.split(/\s+/).length >= 1 && /^[A-Za-z0-9_\-./\\:"']/.test(command);
    if (!isUrl && !looksLikeCommand) {
        return { ok: false, error: '启动命令无效：请填写可执行的 stdio 命令（例如 npx -y xxx）或 http(s) URL' };
    }
    const list = await load();
    if (list.some((s) => s.name === name)) {
        return { ok: false, error: `名称「${name}」已被使用：请换一个名称，或先删除同名服务器` };
    }
    const server = {
        id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        command,
        enabled: input.enabled !== false,
        createdAt: Date.now(),
    };
    list.push(server);
    await persist(list);
    return { ok: true, server };
}
// 启用/停用 per-row toggle (user-installed servers only).
export async function setMcpServerEnabled(id, enabled) {
    const list = await load();
    const s = list.find((x) => x.id === id);
    if (!s) {
        return { ok: false, error: '未找到该 MCP 服务器，可能已被删除' };
    }
    s.enabled = !!enabled;
    await persist(list);
    return { ok: true, server: s };
}
// 删除 — registry entry removal (ZCode MCP row 删除 confirm).
export async function deleteMcpServer(id) {
    const list = await load();
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) {
        return { ok: false, error: '未找到该 MCP 服务器，可能已被删除' };
    }
    list.splice(idx, 1);
    await persist(list);
    return { ok: true };
}
// 导入 — bulk-create from a parsed JSON payload (clipboard import). Skips
// invalid/duplicate rows, reports created/skipped counts honestly.
export async function importMcpServers(rows) {
    if (!Array.isArray(rows)) {
        return { ok: false, error: '剪贴板内容不是 JSON 数组：请复制 [{name, command}] 形式后重试' };
    }
    const list = await load();
    let created = 0;
    let skipped = 0;
    for (const row of rows) {
        const r = row;
        const name = typeof r.name === 'string' ? r.name.trim() : '';
        const command = typeof r.command === 'string' ? r.command.trim() : '';
        if (!name || !command || list.some((s) => s.name === name)) {
            skipped += 1;
            continue;
        }
        list.push({
            id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            command,
            enabled: r.enabled !== false,
            createdAt: Date.now(),
        });
        created += 1;
    }
    await persist(list);
    return { ok: true, created, skipped };
}
