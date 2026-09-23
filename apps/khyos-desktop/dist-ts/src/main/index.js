import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFile, fork } from 'child_process';
import { openKeyManagerWindow } from './keyManagerWindow';
import { registerKeyManagerIpc } from './keyManager/ipc';
import { getSettingsStore, setSetting, getTheme, setTheme } from './settingsStore';
import { getDataHome, baseHomeFile, _resetDataHomeCache } from './keyManager/keyStore';
import { getAutomations, createAutomation, updateAutomation, deleteAutomation, recordRunStart, recordRunSkipped, recordRunEnd, } from './automationStore';
import { getPlugins, installPlugin, setPluginEnabled, uninstallPlugin, checkPluginUpdates, } from './pluginStore';
import { getMcpServers, createMcpServer, setMcpServerEnabled, deleteMcpServer, importMcpServers, } from './mcpStore';
import { listItems, createItem, setItemEnabled, deleteItem, importItems, scanMigrations, importMigration, migrationDataHome, } from './agentItemStore';
import { listIndexes, createIndex, rebuildIndex, setIndexEnabled, deleteIndex, } from './indexStore';
// ZCode has a frameless window with NO native menu bar: all actions live in a
// custom top-right "窗口菜单" dropdown (ZC-ALIGN-002 L 区实测 12 项). The native
// application menu is therefore unset; accelerators (Ctrl+N/O) move to renderer.
const nodeRequire = createRequire(import.meta.url);
// Suppress GPU disk-cache errors on Windows (ACCESS_DENIED when cache dir is
// read-only or locked).  These flags are also passed via CLI args in package.json
// to ensure they take effect before Chromium spawns the GPU process.
// `disable-gpu` alone does NOT fully silence the shared-context warnings
// (gpu_channel_manager "Failed to create shared context for virtualization"),
// so we add `disable-gpu-sandbox` + `disable-gpu-compositing` and point the
// disk-cache to a writable, per-app directory to avoid the ACCESS_DENIED lock.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-gpu-compositing');
// CacheDir default is the user profile; when running from a read-only / portable
// drive the cache files can be locked → GPUCache ACCESS_DENIED. Point the disk
// cache at a per-app dir under OS temp (always writable, no lock-on-open risk).
// os/path already imported at module top as node:fs/node:path — reuse via import.meta.
app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'KhyOS-Desktop', 'GPUCache'));
// Phase 0a + 0b + 0c: 最小主进程 + IPC handler + host 进程
// KeyManager (DESIGN-ARCH-091 P1): standalone key/endpoint manager window
let hostProcess = null;
// Pending ai.generate requests: id → resolver, answered by host messages.
const pendingAi = new Map();
// Pending session.list requests: id → resolver.
const pendingSessionList = new Map();
// Pending session.create requests: id → resolver.
const pendingSessionCreate = new Map();
// Pending token.usage requests: id → resolver.
const pendingTokenUsage = new Map();
// Pending usage.history requests: id → resolver.
const pendingUsageHistory = new Map();
// Pending context.size requests: id → resolver.
const pendingContextSize = new Map();
// In-flight automation runs: host request id → { automationId, startedAt }.
// A run settles only on ai.result or host process exit — no wall-clock kill
// (Rule 3: the gateway owns its own HTTP timeouts).
const pendingAutomationRuns = new Map();
// One run per automation at a time (ZCode: runNowAlreadyRunning)
const runningAutomationIds = new Set();
let aiSeq = 0;
const AUTOMATION_HOST_PREFIX = 'auto_';
function parseGitStatus(stdout) {
    const entries = stdout.split('\0').filter((s) => s.length > 0);
    const branchEntry = entries.find((s) => s.startsWith('## '));
    const changes = [];
    let branch;
    let upstream;
    let ahead;
    let behind;
    if (branchEntry) {
        const header = branchEntry.slice(3);
        const m = header.match(/^([^.\s]+(?:\/[^.\s]+)?)?(\.{2,3}(\S+))?\s*(\[ahead (\d+)(?:, )?(?:behind (\d+))?\]|\[behind (\d+)\])?/);
        branch = m?.[1] || (header.includes('HEAD') ? 'HEAD' : header.split(/\s|\.{2,3}/)[0] || undefined);
        upstream = m?.[3];
        const aheadStr = m?.[5];
        const behindStr = m?.[6] || m?.[7];
        if (aheadStr)
            ahead = Number(aheadStr);
        if (behindStr)
            behind = Number(behindStr);
    }
    // XY status codes → panel kind. X = staged, Y = worktree. Rename entries end
    // with \0<oldPath> in -z mode (handled below via the 2-entry peek).
    const entriesNoBranch = entries.filter((s) => !s.startsWith('## '));
    for (let i = 0; i < entriesNoBranch.length; i++) {
        const entry = entriesNoBranch[i];
        if (entry.length < 4)
            continue;
        const xy = entry.slice(0, 2);
        const rawPath = entry.slice(3);
        let status;
        if (xy === '??') {
            status = 'untracked';
        }
        else if (xy[0] === 'R' || xy[1] === 'R') {
            // -z rename format: `XY new\0old` — the next NUL entry holds the old path
            if (i + 1 < entriesNoBranch.length)
                i++;
            status = 'renamed';
        }
        else if (xy[0] === 'A' || xy[1] === 'A') {
            status = 'added';
        }
        else if (xy[0] === 'D' || xy[1] === 'D') {
            status = 'deleted';
        }
        else {
            status = 'modified';
        }
        // X (staged column) non-blank = staged; '?'/'untracked' never staged
        const staged = xy !== '??' && xy[0] !== ' ';
        changes.push({ path: rawPath, status, staged });
    }
    return { ok: true, state: 'ok', branch, upstream, ahead, behind, changes };
}
// After 'ready', detach host-side sockets from the main event loop: a
// long-lived in-flight AI call must not block app exit (sockets unref'd).
function unrefSockets(proc) {
    try {
        for (const s of [proc.stdout, proc.stderr]) {
            const unref = s?.unref;
            if (typeof unref === 'function')
                unref.call(s);
        }
    }
    catch {
        /* best effort */
    }
}
function handleHostMessage(msg) {
    const m = msg;
    if (!m || typeof m !== 'object')
        return;
    if (m.type === 'session.listResult' && m.id) {
        const entry = pendingSessionList.get(m.id);
        if (entry) {
            pendingSessionList.delete(m.id);
            entry.resolve(m);
        }
        return;
    }
    if (m.type === 'session.createResult' && m.id) {
        const entry = pendingSessionCreate.get(m.id);
        if (entry) {
            pendingSessionCreate.delete(m.id);
            entry.resolve(m);
        }
        return;
    }
    if (m.type === 'token.usageResult' && m.id) {
        const entry = pendingTokenUsage.get(m.id);
        if (entry) {
            pendingTokenUsage.delete(m.id);
            entry.resolve(m);
        }
        return;
    }
    if (m.type === 'usage.historyResult' && m.id) {
        const entry = pendingUsageHistory.get(m.id);
        if (entry) {
            pendingUsageHistory.delete(m.id);
            entry.resolve(m);
        }
        return;
    }
    if (m.type === 'context.sizeResult' && m.id) {
        const entry = pendingContextSize.get(m.id);
        if (entry) {
            pendingContextSize.delete(m.id);
            entry.resolve(m);
        }
        return;
    }
    // Automation runs ride the same host ai.generate channel; results settle the
    // run history entry instead of being forwarded to a renderer window.
    if (m.type === 'ai.result' && m.id && String(m.id).startsWith(AUTOMATION_HOST_PREFIX)) {
        void settleAutomationRun(m.id, m);
        return;
    }
    if ((m.type === 'ai.chunk' || m.type === 'ai.result') && m.id) {
        const entry = pendingAi.get(m.id);
        if (m.type === 'ai.result')
            pendingAi.delete(m.id);
        // Guard every hop: the sender window may be gone before the reply lands.
        const wc = entry?.win;
        if (wc && !wc.isDestroyed()) {
            try {
                wc.webContents.send(m.type, m);
            }
            catch (err) {
                console.log('[host] send to renderer failed:', String(err));
            }
        }
        if (m.type === 'ai.result') {
            try {
                entry?.resolve(m);
            }
            catch (err) {
                console.log('[host] resolve failed:', String(err));
            }
        }
        return;
    }
    // Detach host sockets from the event loop on ready: a long-lived in-flight
    // AI call must not block app exit. Runs settle via ai.result / host exit /
    // app quit — not via the pipe.
    if (m.type === 'ready') {
        console.log('[host] ready:', JSON.stringify(m));
        unrefSockets(hostProcess);
        return;
    }
    console.log('[host] message:', JSON.stringify(m));
}
const KEY_MANAGER_STANDALONE = process.argv.includes('--key-manager');
// Fire one automation run through the host bridge (CH-2). One run per
// automation at a time; manual triggers while busy fail with ZCode's copy,
// schedule triggers while busy record a skipped history entry.
async function fireAutomation(id, trigger) {
    if (!hostProcess || !hostProcess.connected) {
        return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
    }
    const list = await getAutomations();
    const a = list.find((x) => x.id === id);
    if (!a) {
        return { ok: false, error: '未找到该定时任务，可能已被删除' };
    }
    if (runningAutomationIds.has(id)) {
        if (trigger === 'manual') {
            return { ok: false, error: '上一条正在运行中，请稍后再试' };
        }
        await recordRunSkipped(id);
        return { ok: true, skipped: true };
    }
    const started = await recordRunStart(id, trigger);
    if (!started.ok || !started.automation) {
        return { ok: false, error: started.error || '触发运行失败' };
    }
    const hostReqId = `${AUTOMATION_HOST_PREFIX}${Date.now().toString(36)}_${++aiSeq}`;
    runningAutomationIds.add(id);
    pendingAutomationRuns.set(hostReqId, { automationId: id, startedAt: Date.now() });
    hostProcess.send({ type: 'ai.generate', id: hostReqId, prompt: a.prompt, options: {} });
    return { ok: true };
}
async function settleAutomationRun(hostReqId, result) {
    const entry = pendingAutomationRuns.get(hostReqId);
    pendingAutomationRuns.delete(hostReqId);
    if (!entry)
        return;
    runningAutomationIds.delete(entry.automationId);
    const durationMs = Date.now() - entry.startedAt;
    const okFlag = result.ok !== false && typeof result.text === 'string' && result.text.length > 0;
    await recordRunEnd(entry.automationId, entry.startedAt, okFlag ? 'succeeded' : 'failed', {
        durationMs,
        error: okFlag ? undefined : (result.error || '模型无输出：可能端点错误/模型名无效/额度不足，运行 khy gateway status 检查'),
        resultPreview: okFlag && typeof result.text === 'string' ? result.text.slice(0, 400) : undefined,
    }).catch((e) => {
        console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    });
}
// Scheduler tick: fire every enabled automation whose nextRunAt is due.
// Periodic poll, not a task deadline — Rule 3 compliant (no kill path; runs
// settle on ai.result or host exit only).
const AUTOMATION_TICK_MS = 30_000;
let automationTimer = null;
async function runDueAutomations() {
    const list = await getAutomations();
    for (const a of list) {
        if (a.enabled && a.nextRunAt !== null && a.nextRunAt <= Date.now()) {
            const r = await fireAutomation(a.id, 'schedule');
            if (!r.ok)
                console.log(`[automation] 调度触发失败 (${a.title}): ${r.error}`);
        }
    }
}
function startAutomationScheduler() {
    if (automationTimer)
        return;
    automationTimer = setInterval(() => {
        void runDueAutomations();
    }, AUTOMATION_TICK_MS);
    automationTimer.unref?.();
}
// Host died mid-run: settle every in-flight automation run as failed so the
// history never shows a forever-进行中 entry.
function failAllAutomationRuns(reason) {
    for (const [hostReqId, entry] of pendingAutomationRuns) {
        pendingAutomationRuns.delete(hostReqId);
        runningAutomationIds.delete(entry.automationId);
        void recordRunEnd(entry.automationId, entry.startedAt, 'failed', {
            durationMs: Date.now() - entry.startedAt,
            error: reason,
        }).catch((e) => {
            console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
}
// App quitting (window-all-closed / tray exit) while a run is in flight:
// settle as failed so a restart never inherits a dangling 进行中 entry.
function settleAutomationRunsOnQuit() {
    if (pendingAutomationRuns.size === 0)
        return;
    failAllAutomationRuns('应用已退出，运行中断');
    // recordRunEnd is async fs — give it a beat before the event loop can end
    setTimeout(() => { }, 500);
}
function startHostProcess() {
    const hostPath = path.join(__dirname, '../host/index.js');
    hostProcess = fork(hostPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    // EPIPE guard: writing to a closed stdout/stderr pipe throws EPIPE
    // (uncaught in the main process = crash). Wrap every relayed line so a
    // host exit mid-stream degrades to a logged note instead of a kill.
    const logSafe = (tag, write) => (data) => {
        const text = data.toString();
        try {
            write(text);
        }
        catch (err) {
            console.log(`[host] ${tag} 输出管道已关闭，停止转发: ${String(err)}`);
        }
    };
    hostProcess.stdout?.on('data', logSafe('stdout', (s) => console.log(`[host] ${s}`)));
    hostProcess.stderr?.on('data', logSafe('stderr', (s) => console.error(`[host] ${s}`)));
    hostProcess.on('message', handleHostMessage);
    hostProcess.on('exit', (code) => {
        console.log(`[host] 进程退出, code=${code}`);
        hostProcess = null;
        failAllAutomationRuns(`host 进程退出 (code=${code})，运行中断`);
    });
}
// Resolve the refined app icon (deep-space blue rounded square + white K) for
// the taskbar / window chrome. The .ico ships in several places depending on
// how the app is launched (repo source tree vs electron-builder packaged run),
// so probe known locations and use the first that exists; if none, start
// without a custom icon rather than break launch.
function resolveAppIcon() {
    const candidates = [
        // electron-builder packaged resources (win.icon in package.json build block)
        path.join(process.resourcesPath, 'icon', 'icon.ico'),
        path.join(process.resourcesPath, 'icon.ico'),
        // Repo / portable source tree (public dir next to the main entry's out/)
        path.join(__dirname, '../../public/icon.ico'),
        path.join(__dirname, '../renderer/icon.ico'),
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c))
                return c;
        }
        catch {
            /* ignore */
        }
    }
    return undefined;
}
async function createWindow() {
    // Restore last window geometry from settings.json (desktopWindowSize,
    // ZC-ALIGN-003 backend wiring) — falls back to ZCode's 1216×808 default.
    const settings = await getSettingsStore();
    const size = settings.desktopWindowSize || {};
    const width = typeof size.width === 'number' && size.width >= 800 ? size.width : 1216;
    const height = typeof size.height === 'number' && size.height >= 600 ? size.height : 808;
    const win = new BrowserWindow({
        width,
        height,
        minWidth: 800,
        minHeight: 600,
        frame: false,
        show: false,
        // Refined KhyOS app icon on the taskbar / window chrome (deep-space blue
        // rounded square + white K). Resolved from known locations; undefined when
        // none exist so launch never breaks.
        ...(resolveAppIcon() ? { icon: resolveAppIcon() } : {}),
        webPreferences: {
            // Preload is built as CJS (electron.vite.config.ts forces format:'cjs')
            // because sandboxed preloads cannot be ESM — see P0-6 in ZC-ALIGN-001.
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Browser tab (BrowserPane) embeds live pages via <webview> — ZCode uses
            // a guest view for its side-panel browser; webview is the Electron
            // equivalent (back/forward/reload + did-navigate/did-fail-load events).
            webviewTag: true
        }
    });
    // Persist window geometry on close so the next launch restores it.
    const persistGeometry = () => {
        if (win.isDestroyed())
            return;
        // getNormalBounds returns the restored size even while maximized
        const bounds = win.getNormalBounds();
        setSetting('desktopWindowSize', {
            width: bounds.width,
            height: bounds.height,
            maximized: win.isMaximized(),
        }).catch((e) => {
            console.log(`[settings] 窗口尺寸保存失败: ${e instanceof Error ? e.message : String(e)}`);
        });
    };
    win.on('close', persistGeometry);
    // dev-server URL from env (electron-vite injects VITE_DEV_SERVER_URL); the
    // port falls back to a variable (zero-hardcoding exemption class)
    const devPort = process.env.VITE_DEV_PORT || '5173';
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`;
    if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
        win.loadURL(devServerUrl);
    }
    else {
        win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
    win.once('ready-to-show', () => {
        win.show();
        // Re-maximize if the last session closed while maximized
        if (size.maximized === true)
            win.maximize();
    });
    // 窗口控制
    ipcMain.handle('window:minimize', () => win.minimize());
    ipcMain.handle('window:maximize', () => {
        if (win.isMaximized())
            win.unmaximize();
        else
            win.maximize();
    });
    ipcMain.handle('window:close', () => win.close());
    ipcMain.handle('app:version', () => app.getVersion());
    // Real workspace root: the cwd the app was launched from (the open
    // workspace), replacing the previous hardcoded demo path (Rule 1).
    ipcMain.handle('app:workspacePath', () => process.cwd());
    // 设置读写（持久化到 baseHome/settings.json）
    ipcMain.handle('settings:get', async () => {
        return getSettingsStore();
    });
    ipcMain.handle('settings:set', async (_e, key, value) => {
        await setSetting(key, value);
        return true;
    });
    // 数据存储路径变更：复制现有数据到 <newPath>/.khy，然后写指针。
    // 迁移采用「复制而非移动」——base home 的 settings.json（存指针的文件）
    // 不迁移，旧数据保留，用户可手动清理（可逆、零数据丢失）。
    ipcMain.handle('settings:setDataPath', async (_e, newPath) => {
        if (typeof newPath !== 'string' || !newPath.trim()) {
            return { ok: false, error: '路径为空：请选择或输入有效的数据存储路径' };
        }
        const target = path.resolve(newPath.trim());
        const baseSettings = baseHomeFile('settings.json');
        const currentHome = getDataHome();
        const newHome = path.join(target, '.khy');
        if (newHome === currentHome) {
            return { ok: true, moved: false, home: newHome };
        }
        try {
            const fs = await import('node:fs');
            // fs.cp recursive copy of the current data home (skips settings.json
            // via filter — the pointer file stays in the base home)
            await fs.promises.cp(currentHome, newHome, {
                recursive: true,
                force: true,
                filter: (src) => path.resolve(src) !== path.resolve(baseSettings),
            });
            await setSetting('dataPath', target);
            // Switch the running process to the new home immediately
            _resetDataHomeCache();
            return { ok: true, moved: true, home: newHome };
        }
        catch (err) {
            return {
                ok: false,
                error: `数据迁移失败：${err instanceof Error ? err.message : String(err)}，已保留原路径，请检查目标磁盘可写后重试`,
            };
        }
    });
    // 主题（持久化到 settings.json 的 theme 字段）
    ipcMain.handle('theme:get', async () => {
        return getTheme();
    });
    ipcMain.handle('theme:set', async (_e, mode) => {
        await setTheme(mode);
        // 通知所有渲染窗口更新主题 class
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('theme:changed', mode);
            }
        }
        return true;
    });
    // 界面缩放：clamped 0.5–2.0, applied to the sender window only (ZCode
    // account-menu 界面缩放 submenu: 放大/缩小/实际大小). Returns the applied
    // factor so callers can update any local UI state.
    ipcMain.handle('zoom:set', async (e, factor) => {
        const clamped = Math.min(2, Math.max(0.5, Number(factor)));
        const wc = e.sender;
        if (!Number.isFinite(clamped)) {
            throw new Error('缩放值无效：请传入 0.5–2.0 之间的数字');
        }
        wc.setZoomFactor(clamped);
        return clamped;
    });
    // 文件系统
    ipcMain.handle('fs:openDirectory', async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('fs:readFile', async (e, filePath) => {
        const fs = await import('fs/promises');
        return fs.readFile(filePath, 'utf-8');
    });
    ipcMain.handle('fs:writeFile', async (e, filePath, content) => {
        const fs = await import('fs/promises');
        await fs.writeFile(filePath, content, 'utf-8');
        return true;
    });
    // ── 代码查看（codeViewer.* 文案）— 只读预览通道，四态契约 ──
    // ok（文本内容）/ tooLarge（>256KB 预览上限）/ binary（NUL 字节检测）/
    // missing / empty。只读短 I/O，无长任务截止，Rule 3 无涉。
    ipcMain.handle('codeViewer:read', async (_e, filePath) => {
        const PREVIEW_LIMIT = 256 * 1024;
        try {
            if (typeof filePath !== 'string' || !filePath.trim()) {
                return { ok: false, state: 'missing' };
            }
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) {
                return { ok: false, state: 'missing' };
            }
            if (stat.size > PREVIEW_LIMIT) {
                return { ok: false, state: 'tooLarge', size: stat.size };
            }
            const buf = await fs.promises.readFile(filePath);
            if (buf.length === 0) {
                return { ok: false, state: 'empty' };
            }
            // Binary heuristic: a NUL byte in the first 8KB means not previewable text
            const probe = buf.subarray(0, Math.min(buf.length, 8192));
            if (probe.includes(0)) {
                return { ok: false, state: 'binary' };
            }
            return { ok: true, state: 'ok', content: buf.toString('utf-8'), size: buf.length };
        }
        catch {
            return { ok: false, state: 'missing' };
        }
    });
    // ── 打开文件（sidePane.openFile）：workspace 文件索引，仅返回文本类文件 ──
    // 深度/数量有界（Rule 3 精神：单次遍历，无长任务）；忽略 node_modules 等噪声目录。
    ipcMain.handle('workspace:listFiles', async (_e, query) => {
        const root = process.cwd();
        const SKIP_DIRS = new Set([
            'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
        ]);
        const TEXT_EXTS = new Set([
            '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.vue', '.css',
            '.html', '.yml', '.yaml', '.toml', '.ini', '.sh', '.bat', '.ps1', '.py', '.cjs', '.mjs',
        ]);
        const MAX_FILES = 5000;
        const results = [];
        const q = (query || '').trim().toLowerCase();
        try {
            const walk = (dir, depth) => {
                if (results.length >= MAX_FILES || depth > 8)
                    return;
                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                }
                catch {
                    return; // unreadable subdir: skip, don't fail the whole index
                }
                for (const ent of entries) {
                    if (results.length >= MAX_FILES)
                        return;
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        if (!SKIP_DIRS.has(ent.name.toLowerCase()) && !ent.name.startsWith('.')) {
                            walk(full, depth + 1);
                        }
                    }
                    else if (ent.isFile()) {
                        const ext = path.extname(ent.name).toLowerCase();
                        if (!TEXT_EXTS.has(ext))
                            continue;
                        if (q && !full.toLowerCase().includes(q))
                            continue;
                        results.push({ path: full, name: ent.name });
                    }
                }
            };
            walk(root, 0);
            return { ok: true, root, files: results };
        }
        catch (err) {
            return { ok: false, error: `工作区文件索引失败：${err instanceof Error ? err.message : String(err)}，请检查工作区目录权限` };
        }
    });
    // AI 网关 — 转发给 host 进程，host 动态 require KhyOS 后端 aiGateway（CH-2）
    ipcMain.handle('ai:send', (e, payload) => {
        const prompt = payload?.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return { ok: false, error: '请求缺少 prompt：请输入要发送的内容后重试' };
        }
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `ai_${Date.now()}_${++aiSeq}`;
        const senderWin = BrowserWindow.fromWebContents(e.sender);
        if (!senderWin || senderWin.isDestroyed()) {
            return { ok: false, error: '发送窗口已关闭：请重试' };
        }
        return new Promise((resolve) => {
            pendingAi.set(id, { resolve: resolve, win: senderWin });
            hostProcess.send({ type: 'ai.generate', id, prompt, options: payload?.options || {} });
            // Guard: host died mid-request
            setTimeout(() => {
                if (pendingAi.has(id)) {
                    pendingAi.delete(id);
                    resolve({ ok: false, error: 'host 进程响应超时：请查看导出日志排查 host 状态' });
                }
            }, 300000);
        });
    });
    ipcMain.handle('ai:stream', async (e, payload) => {
        console.log('[ai] stream (streaming flows through ai:send + ai:chunk)', payload);
        return { ok: true };
    });
    // 会话 — 转发给 host 进程，host 动态 require KhyOS 后端 sessionPersistence（CH-2），
    // 读本地 .khy/sessions 真源（与 `khy` CLI 同源），替代旧的静态 [] stub。
    ipcMain.handle('session:list', async (e, limit) => {
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, sessions: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `sess_list_${Date.now()}_${++aiSeq}`;
        const senderWin = BrowserWindow.fromWebContents(e.sender);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingSessionList.delete(id);
                resolve({ ok: false, sessions: [], error: '会话列表读取超时：请查看导出日志排查 host 状态' });
            }, 15000);
            pendingSessionList.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
            });
            hostProcess.send({ type: 'session.list', id, limit: typeof limit === 'number' ? limit : 50 });
        });
    });
    // 新建会话 — 同 session:list 链路：host 直调 sessionPersistence.persistSession
    // （CH-2），空消息 + cwd/projectDir 元数据落盘，返回新 sessionId。
    ipcMain.handle('session:create', async (e, workspacePath) => {
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `sess_create_${Date.now()}_${++aiSeq}`;
        const cwd = typeof workspacePath === 'string' && workspacePath ? workspacePath : process.cwd();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingSessionCreate.delete(id);
                resolve({ ok: false, error: '会话创建超时：请查看导出日志排查 host 状态' });
            }, 15000);
            pendingSessionCreate.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
            });
            hostProcess.send({ type: 'session.create', id, cwd });
        });
    });
    // host 进程状态
    ipcMain.handle('host:status', async () => {
        return { running: !!hostProcess, pid: hostProcess?.pid };
    });
    // Token 用量 — 转发给 host 进程，host 动态 require KhyOS 后端
    // tokenUsageService（CH-2），替代 UI 侧的自造假数据（ZC-ALIGN-001 P3-3）。
    ipcMain.handle('token:usage', async (e) => {
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, usage: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `token_usage_${Date.now()}_${++aiSeq}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingTokenUsage.delete(id);
                resolve({ ok: false, usage: null, error: 'Token 用量读取超时：请查看导出日志排查 host 状态' });
            }, 15000);
            pendingTokenUsage.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
            });
            hostProcess.send({ type: 'token.usage', id });
        });
    });
    // 用量历史（近 N 日 + 按模型分桶）— 转发给 host，host 读后端
    // tokenUsageService.getUsageHistory/getModelUsage（CH-2），替代使用统计页的
    // 自造假数据（ZC-ALIGN-001 P13）。
    ipcMain.handle('usage:history', async (_e, days) => {
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, history: null, models: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `usage_history_${Date.now()}_${++aiSeq}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingUsageHistory.delete(id);
                resolve({ ok: false, history: null, models: null, error: '用量历史读取超时：请查看导出日志排查 host 状态' });
            }, 15000);
            pendingUsageHistory.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
            });
            hostProcess.send({ type: 'usage.history', id, days: typeof days === 'number' && days > 0 ? Math.floor(days) : 30 });
        });
    });
    // 上下文窗口估算 — 转发给 host，host 用后端 tokenUsageService.estimateTokens
    // （与 /cost 同源启发式）估算当前会话 token 数 + 上下文窗口上限（ZC-ALIGN-001 P3-5/P3-6）。
    ipcMain.handle('context:size', async (_e, text) => {
        if (!hostProcess || !hostProcess.connected) {
            return { ok: false, estimate: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' };
        }
        const id = `ctx_size_${Date.now()}_${++aiSeq}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingContextSize.delete(id);
                resolve({ ok: false, estimate: null, error: '上下文估算超时：请查看导出日志排查 host 状态' });
            }, 15000);
            pendingContextSize.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
            });
            hostProcess.send({ type: 'context.size', id, text: typeof text === 'string' ? text : '' });
        });
    });
    // ── 自动化（定时任务）— store 落盘 + 调度 tick + 经 host ai.generate 执行 ──
    ipcMain.handle('automation:list', async () => {
        return { ok: true, automations: await getAutomations() };
    });
    ipcMain.handle('automation:create', (_e, input) => createAutomation(input || {}));
    ipcMain.handle('automation:update', (_e, id, patch) => updateAutomation(id, patch || {}));
    ipcMain.handle('automation:delete', (_e, id) => deleteAutomation(id));
    ipcMain.handle('automation:runNow', (_e, id) => fireAutomation(id, 'manual'));
    // ── 插件设置页 — pluginStore 落盘（registry + 启用态 + 卸载 + 检查更新）──
    ipcMain.handle('plugin:list', async () => {
        return { ok: true, plugins: await getPlugins() };
    });
    ipcMain.handle('plugin:install', (_e, input) => installPlugin(input || {}));
    ipcMain.handle('plugin:setEnabled', (_e, id, enabled) => setPluginEnabled(id, enabled));
    ipcMain.handle('plugin:uninstall', (_e, id) => uninstallPlugin(id));
    ipcMain.handle('plugin:checkUpdates', async () => checkPluginUpdates());
    // ── MCP 设置页 — mcpStore 落盘（用户自建服务器：新建/启用/删除/导入）──
    // 插件宿主区不在此列：宿主服务器由 plugin:list 按 components.mcp>0 派生（只读）。
    ipcMain.handle('mcp:list', async () => {
        return { ok: true, servers: await getMcpServers() };
    });
    ipcMain.handle('mcp:create', (_e, input) => createMcpServer(input || {}));
    ipcMain.handle('mcp:setEnabled', (_e, id, enabled) => setMcpServerEnabled(id, enabled));
    ipcMain.handle('mcp:delete', (_e, id) => deleteMcpServer(id));
    ipcMain.handle('mcp:import', (_e, rows) => importMcpServers(rows));
    // ── Agent 扩展条目（命令/钩子/技能/子智能体/记忆）— agentItemStore 正门 ──
    // 列表页 Pattern-B 六页的 CRUD + 导入；kind 由 preload 传入（command/hook/
    // skill/subagent/memory），store 侧白名单校验。
    ipcMain.handle('agent:list', (_e, kind) => listItems(kind));
    ipcMain.handle('agent:create', (_e, kind, input) => createItem(kind, input));
    ipcMain.handle('agent:setEnabled', (_e, kind, id, enabled) => setItemEnabled(kind, id, enabled));
    ipcMain.handle('agent:delete', (_e, kind, id) => deleteItem(kind, id));
    ipcMain.handle('agent:import', (_e, kind, rows) => importItems(kind, rows));
    // ── 索引库页 — indexStore（真实磁盘扫描统计）──
    ipcMain.handle('index:list', async () => listIndexes());
    ipcMain.handle('index:create', (_e, input) => createIndex(input));
    ipcMain.handle('index:rebuild', (_e, id) => rebuildIndex(id));
    ipcMain.handle('index:setEnabled', (_e, id, enabled) => setIndexEnabled(id, enabled));
    ipcMain.handle('index:delete', (_e, id) => deleteIndex(id));
    // ── 外部 Agent 迁移（引导弹窗「数据迁移向导」，D5/s-8）— 只读扫描 +
    //    导入到 agent_items.json；数据根路径只读查询（Rule 1：不硬编码路径）──
    ipcMain.handle('migration:scan', async () => scanMigrations());
    ipcMain.handle('migration:import', (_e, sourceId) => importMigration(sourceId));
    ipcMain.handle('app:dataHome', () => migrationDataHome());
    // ── 审查面板（Git 状态）— 只读 git status -z --branch，作用于当前工作区 cwd ──
    // 结果四态：ok（含改动）/ notRepository / gitUnavailable（本机无 git.exe，
    // 诚实呈现 git.empty.gitUnavailable* 文案）/ error。只读短 I/O 超时属 Rule 3
    // 合法例外（防挂死的探测调用，非长任务截止）。
    ipcMain.handle('git:status', async () => {
        const cwd = process.cwd();
        try {
            const stdout = await new Promise((resolve, reject) => {
                execFile('git', ['status', '--porcelain=v1', '-z', '--branch'], { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
                    if (err)
                        reject(err);
                    else
                        resolve(out);
                });
            });
            return parseGitStatus(stdout);
        }
        catch (err) {
            const e = err;
            // spawn ENOENT: no git binary on this machine — distinct from not-a-repo
            if (e.code === 'ENOENT') {
                return { ok: false, state: 'gitUnavailable' };
            }
            // fatal: not a git repository (or any of the parent directories)
            if (typeof e.stderr === 'string' && /not a git repository/i.test(e.stderr)) {
                return { ok: false, state: 'notRepository' };
            }
            // 128 with the repo detection phrase is the same not-a-repo outcome
            if (e.code === '128' && typeof e.message === 'string' && /not a git repository/i.test(e.message)) {
                return { ok: false, state: 'notRepository' };
            }
            return { ok: false, state: 'error', error: e.stderr?.trim() || e.message || 'git status 执行失败' };
        }
    });
    // ── 窗口菜单动作（L 区对齐：自绘下拉，替代原生菜单栏）──
    ipcMain.handle('app:openExternal', async (_e, url) => {
        if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
            return { ok: false, error: '仅允许 https 链接：已拒绝非 https 的外部打开请求' };
        }
        await shell.openExternal(url);
        return { ok: true };
    });
    ipcMain.handle('app:openPath', async (_e, dir) => {
        if (typeof dir !== 'string' || !dir.trim()) {
            return { ok: false, error: '路径为空：请先选择工作区' };
        }
        const err = shell.openPath(dir);
        return err ? { ok: false, error: `无法打开目录 ${dir}：${err}` } : { ok: true };
    });
    // First-party URLs come from servicesDefaults (single truth source); main
    // resolves it via KHY_OS_DIR / relative fallback, same as the host bridge.
    ipcMain.handle('app:brandingLinks', async () => {
        try {
            const root = process.env.KHY_OS_DIR
                ? path.resolve(process.env.KHY_OS_DIR)
                : path.resolve(__dirname, '..', '..', '..');
            const sd = nodeRequire(path.join(root, 'services', 'backend', 'src', 'constants', 'serviceDefaults.js'));
            const host = sd.CLOUD_DEFAULT_HOST || '';
            return {
                ok: true,
                cloudHost: host,
                feedback: host ? `https://${host}/feedback` : '',
                docs: host ? `https://${host}/docs` : '',
                community: host ? `https://${host}/community` : '',
                issues: host ? `https://${host}/issues` : '',
            };
        }
        catch (err) {
            return { ok: false, error: `品牌链接真源不可用：${String(err?.message || err)}` };
        }
    });
    // 停止等待：放弃 pending 请求（底层 HTTP 无法中断，UI 立即恢复并如实说明）
    ipcMain.handle('ai:abort', async (e) => {
        let aborted = 0;
        for (const [id, entry] of pendingAi) {
            if (entry.win === BrowserWindow.fromWebContents(e.sender)) {
                pendingAi.delete(id);
                entry.resolve({ ok: false, error: '已停止等待回复：底层请求可能仍在后台执行，结果将被丢弃' });
                aborted++;
            }
        }
        return { ok: true, aborted };
    });
    return win;
}
app.whenReady().then(() => {
    // Key/Endpoint Manager IPC (DESIGN-ARCH-091 §6) — global, registered once
    registerKeyManagerIpc(ipcMain);
    if (KEY_MANAGER_STANDALONE) {
        // standalone entry: `npm run dev -- --key-manager` — only the manager
        // window is created, no main window / host process (spec §5.1 入口③)
        openKeyManagerWindow({ standalone: true });
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0)
                openKeyManagerWindow({ standalone: true });
        });
        return;
    }
    startHostProcess();
    // 自动化调度：先算一次 nextRunAt（老数据可能缺该字段），再启动周期 tick
    void (async () => {
        const list = await getAutomations();
        for (const a of list) {
            if (a.enabled && a.nextRunAt === null) {
                await updateAutomation(a.id, {});
            }
        }
    })();
    startAutomationScheduler();
    void createWindow();
    // Frameless, no native menu bar — actions live in the TitleBar 窗口菜单
    // dropdown (L 区对齐). Menu items fire via IPC (menu:new-task etc.) which
    // createWindow registers on every window.
    Menu.setApplicationMenu(null);
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        settleAutomationRunsOnQuit();
        app.quit();
    }
});
app.on('will-quit', settleAutomationRunsOnQuit);
