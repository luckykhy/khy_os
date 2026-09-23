// settingsStore — file-backed settings persistence for the main process.
//
// Stores all app settings (locale, theme, data path, toggles, proxy, terminal,
// etc.) in a single settings.json under the BASE dataHome (env/portable/repo/
// homedir chain from keyStore — never the dataPath-diverted effective home:
// settings.json holds the dataPath pointer itself, so it must stay findable at
// boot before the effective home is known). Atomic write + defaults merge; read
// is cached in-memory after first load and invalidated on write.
//
// This replaces the stub handlers in index.ts (ZC-ALIGN-003: "backend wired").
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { baseHomeFile, SETTINGS_FILE } from './keyManager/keyStore';
function settingsPath() {
    // Base home, NOT the dataPath-diverted effective home (see file header):
    // settings.json holds the dataPath pointer itself, so it must stay findable
    // at boot before the effective home is known.
    return baseHomeFile(SETTINGS_FILE);
}
async function ensureDir() {
    const dir = path.dirname(settingsPath());
    if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
    }
}
// Default settings — mirrors the stub return + ZCode v3.11.2 a11y defaults
const DEFAULTS = {
    locale: 'system',
    theme: 'dark',
    dataPath: '',
    archiveRetention: '7d',
    autoArchive: true,
    groupFileChanges: true,
    groupTerminalCommands: true,
    groupExploreTools: true,
    showTodo: false,
    showReasoning: true,
    keepFullModelIO: false,
    autoContinueQuestions: true,
    interactionBehavior: 'queue',
    preventIdleSleep: false,
    hideToTray: false,
    notificationSound: true,
    taskNotifications: true,
    autoUpdate: false,
    prereleaseUpdates: false,
    hardwareAcceleration: true,
    customCert: '',
    noProxy: '',
    httpProxy: '',
    enhancedFindGrep: false,
    terminalShell: 'auto',
    terminalFont: '',
    inheritTerminalProfile: true,
    optInExperience: false,
    // Appearance: message body font size consumed via --khy-message-font-size
    // CSS var on <html> (MarkdownRenderer); CUA dispatch interval in ms.
    messageFontSize: '14',
    cuaActionInterval: '500',
    // Window geometry
    desktopWindowSize: { width: 1216, height: 808, maximized: false },
};
let cache = null;
export async function getSettingsStore() {
    if (cache)
        return cache;
    try {
        const raw = await fs.readFile(settingsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        // Merge: defaults ← stored (stored wins)
        cache = { ...DEFAULTS, ...parsed };
    }
    catch {
        // File missing or invalid → use defaults
        cache = { ...DEFAULTS };
    }
    return cache;
}
export async function setSetting(key, value) {
    const current = await getSettingsStore();
    current[key] = value;
    cache = current;
    await ensureDir();
    // Atomic write: write to .tmp then rename
    const tmpPath = settingsPath() + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), 'utf-8');
    await fs.rename(tmpPath, settingsPath());
}
export async function getTheme() {
    const settings = await getSettingsStore();
    return settings.theme || 'dark';
}
export async function setTheme(mode) {
    await setSetting('theme', mode);
}
