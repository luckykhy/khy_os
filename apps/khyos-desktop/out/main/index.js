import { BrowserWindow, app, Menu, ipcMain, dialog, shell } from "electron";
import path$1 from "node:path";
import os from "node:os";
import fs, { promises, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fork, execFile } from "child_process";
import path from "path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function openKeyManagerWindow(opts = {}) {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    show: false,
    title: "KhyOS 密钥与端点管理",
    webPreferences: {
      // Preload built as CJS — see src/main/index.ts / electron.vite.config.ts (P0-6)
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const devPort = process.env.VITE_DEV_PORT || "5173";
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`;
  const useDev = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === "development";
  if (useDev) {
    win.loadURL(`${devServerUrl}#/key-manager`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.webContents.once("did-stop-loading", () => {
      win.webContents.executeJavaScript(`location.hash = 'key-manager'`).catch(() => {
      });
    });
  }
  win.once("ready-to-show", () => win.show());
  if (opts.standalone) {
    win.on("closed", () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  }
  return win;
}
const ENV_PROVIDER_MAP = {
  openai: { keyEnv: "OPENAI_API_KEY", endpointEnv: "OPENAI_BASE_URL" },
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", endpointEnv: "ANTHROPIC_BASE_URL" },
  deepseek: { keyEnv: "DEEPSEEK_API_KEY", endpointEnv: "DEEPSEEK_API_ENDPOINT" },
  agnes: { keyEnv: "AGNES_API_KEY", endpointEnv: "AGNES_API_ENDPOINT" },
  sensenova: { keyEnv: "SENSENOVA_API_KEY", endpointEnv: "SENSENOVA_API_ENDPOINT" },
  qwen: { keyEnv: "QWEN_API_KEY", endpointEnv: "QWEN_API_ENDPOINT" },
  glm: { keyEnv: "GLM_API_KEY", endpointEnv: "GLM_API_ENDPOINT" },
  doubao: { keyEnv: "DOUBAO_API_KEY", endpointEnv: "DOUBAO_API_ENDPOINT" },
  wenxin: { keyEnv: "WENXIN_API_KEY", endpointEnv: "WENXIN_API_ENDPOINT" },
  trae: { keyEnv: "TRAE_API_KEY", endpointEnv: "TRAE_API_ENDPOINT" },
  openrouter: { keyEnv: "OPENROUTER_API_KEY", endpointEnv: "OPENROUTER_BASE_URL" },
  relay: { keyEnv: "RELAY_API_KEY", endpointEnv: "RELAY_API_ENDPOINT" }
};
const REVEAL_COOLDOWN_MS = 6e4;
const PROBE_TIMEOUT_MS = 1e4;
const VALIDATE_TIMEOUT_MS = 3e3;
const PROBE_CONCURRENCY = 4;
const PROXY_RUNTIME_FILE = "proxy_server_runtime.json";
const PROXY_AUTH_FILE = "proxy_server_auth.json";
const API_KEYS_FILE = "api_keys.json";
const CUSTOM_PROVIDERS_FILE = "custom_providers.json";
const CC_SWITCH_FILE = "cc_switch.json";
const AUDIT_FILE = "key_manager_audit.jsonl";
function auditPath() {
  return path$1.join(getDataHome(), AUDIT_FILE);
}
async function appendAudit(entry) {
  const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry });
  const file = auditPath();
  await promises.mkdir(path$1.dirname(file), { recursive: true });
  await promises.appendFile(file, `${line}
`, "utf-8");
  try {
    if (process.platform !== "win32") await promises.chmod(file, 384);
  } catch {
  }
}
async function listAudit(limit = 200) {
  const file = auditPath();
  let raw;
  try {
    raw = await promises.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0).slice(-limit);
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
    }
  }
  return out;
}
async function exportAudit(destFile) {
  const entries = await listAudit(1e4);
  try {
    await promises.mkdir(path$1.dirname(path$1.resolve(destFile)), { recursive: true });
    await promises.writeFile(destFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return { ok: true, count: entries.length };
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
let _dataHome = null;
const SETTINGS_FILE = "settings.json";
function resolveRepoRoot() {
  const explicit = process.env.KHYOS_DESKTOP_REPO_ROOT;
  if (explicit) return explicit;
  const here = path$1.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i += 1) {
    try {
      if (fsSyncExists(path$1.join(dir, ".portable"))) return dir;
    } catch {
      break;
    }
    const parent = path$1.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function fsSyncExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function resolveBaseDataHome() {
  const envHome = process.env.KHY_DATA_HOME;
  if (envHome) return path$1.resolve(envHome);
  const portableRoot = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portableRoot) return path$1.join(portableRoot, ".khy");
  const repoRoot = resolveRepoRoot();
  if (repoRoot) return path$1.join(repoRoot, ".khy");
  return path$1.join(os.homedir(), ".khy");
}
function baseHomeFile(name) {
  return path$1.join(resolveBaseDataHome(), name);
}
function readDataPathPointer() {
  try {
    const raw = readFileSync(baseHomeFile(SETTINGS_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    const dp = parsed?.dataPath;
    return typeof dp === "string" && dp.trim() ? dp.trim() : "";
  } catch {
    return "";
  }
}
function getDataHome() {
  if (_dataHome) return _dataHome;
  let home = resolveBaseDataHome();
  if (!process.env.KHY_DATA_HOME) {
    const pointer = readDataPathPointer();
    const pointed = pointer ? path$1.join(pointer, ".khy") : "";
    if (pointed && pointed !== home && fsSyncExists(pointed)) {
      home = pointed;
    }
  }
  _dataHome = home;
  return _dataHome;
}
function _resetDataHomeCache() {
  _dataHome = null;
}
function fileInDataHome(name) {
  return path$1.join(getDataHome(), name);
}
function dataHomeFile(name) {
  return fileInDataHome(name);
}
let _tmpSeq = 0;
async function atomicWriteJson(file, data) {
  const dir = path$1.dirname(file);
  await promises.mkdir(dir, { recursive: true });
  try {
    await promises.copyFile(file, `${file}.bak`);
  } catch {
  }
  const tmp = `${dir}/${path$1.basename(file)}.tmp-${process.pid}-${_tmpSeq++}`;
  await promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await promises.rename(tmp, file);
      break;
    } catch (e) {
      const code = e.code;
      if (code !== "EPERM" && code !== "EBUSY") throw e;
      if (attempt === 4) {
        await promises.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
        await promises.unlink(tmp).catch(() => {
        });
      } else {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  }
  await tryChmod600(file);
}
async function tryChmod600(file) {
  try {
    if (process.platform !== "win32") await promises.chmod(file, 384);
  } catch {
  }
}
async function safeReadJson(file, fallback) {
  let raw = null;
  try {
    raw = await promises.readFile(file, "utf-8");
  } catch {
    return { data: fallback, recovered: false };
  }
  try {
    return { data: JSON.parse(raw), recovered: false };
  } catch {
    try {
      const bak = await promises.readFile(`${file}.bak`, "utf-8");
      const parsed = JSON.parse(bak);
      const tmp = `${file}.heal-${process.pid}`;
      await promises.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf-8");
      await promises.rename(tmp, file);
      return { data: parsed, recovered: true };
    } catch {
    }
    return { data: fallback, recovered: false };
  }
}
function keyFingerprint(key) {
  return createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 8);
}
function maskKey(key) {
  if (!key) return "(empty)";
  if (key.length <= 8) return `${key.slice(0, 1)}…${key.slice(-2)}`;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
function keyIdFor(provider, key) {
  return createHash("md5").update(`${provider}:${key}`, "utf-8").digest("hex").slice(0, 12);
}
function emptyPool() {
  return {};
}
async function loadPool() {
  const { data, recovered } = await safeReadJson(fileInDataHome(API_KEYS_FILE), emptyPool());
  if (recovered) appendAudit({ op: "error", target: API_KEYS_FILE, detail: "pool .bak 自愈恢复" });
  return data;
}
async function savePool(doc) {
  await atomicWriteJson(fileInDataHome(API_KEYS_FILE), doc);
}
async function listPoolEntriesPlain() {
  const doc = await loadPool();
  const out = [];
  for (const [provider, entries] of Object.entries(doc)) {
    for (const e of entries || []) {
      out.push({ provider, key: e.key, endpoint: e.endpoint || "", label: e.label || provider, disabled: e.disabled });
    }
  }
  return out;
}
async function listPool() {
  const doc = await loadPool();
  const providers = [];
  for (const [provider, entries] of Object.entries(doc)) {
    const keys = (entries || []).map((e) => ({
      keyId: keyIdFor(provider, e.key),
      label: e.label || "",
      endpoint: e.endpoint || "",
      priority: e.priority ?? 0,
      enabled: !e.disabled,
      source: "pool",
      mask: maskKey(e.key),
      fingerprint: keyFingerprint(e.key)
    }));
    providers.push({ id: provider, keys });
  }
  const envOverlay = Object.entries(ENV_PROVIDER_MAP).map(([provider, m]) => ({
    provider,
    envName: m.keyEnv,
    set: Boolean(process.env[m.keyEnv])
  }));
  return { providers, envOverlay };
}
async function addKey(input) {
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!provider) return { ok: false, error: "provider 必填" };
  const key = String(input.key || "").trim();
  const endpoint = String(input.endpoint || "").trim();
  const doc = await loadPool();
  const entries = Array.isArray(doc[provider]) ? doc[provider] : [];
  const dup = key ? entries.find((e) => e.key === key) : void 0;
  if (dup) {
    dup.endpoint = endpoint || dup.endpoint;
    dup.label = input.label || dup.label;
    dup.priority = input.priority ?? dup.priority ?? 0;
    dup.disabled = false;
  } else {
    entries.push({
      key: key || "(endpoint-only)",
      endpoint,
      priority: input.priority ?? 0,
      label: input.label || provider,
      id: key ? keyIdFor(provider, key) : void 0
    });
  }
  doc[provider] = entries;
  await savePool(doc);
  const keyId = key ? keyIdFor(provider, key) : "";
  await appendAudit({ op: "add", target: provider, fingerprint: key ? keyFingerprint(key) : "" });
  return { ok: true, keyId, provider };
}
async function updateKey(provider, keyId, patch) {
  const doc = await loadPool();
  const entries = doc[provider] || [];
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId);
  if (idx < 0) return { ok: false, error: "密钥不存在 (keyId 已变更或条目被移除)" };
  const entry = entries[idx];
  if (patch.label !== void 0) entry.label = patch.label;
  if (patch.endpoint !== void 0) entry.endpoint = patch.endpoint;
  if (patch.priority !== void 0) entry.priority = patch.priority;
  let newKeyId = keyId;
  if (patch.key !== void 0 && patch.key !== entry.key) {
    entry.key = patch.key;
    newKeyId = keyIdFor(provider, patch.key);
    const cc = await loadCcDoc();
    let reattached = 0;
    for (const card of cc.cards) {
      if (card.keyId === keyId) {
        card.keyId = newKeyId;
        reattached += 1;
      }
    }
    if (reattached > 0) await saveCcDoc(cc);
    const result = { ok: true, newKeyId, reattachedCards: reattached };
    await appendAudit({ op: "update", target: provider, fingerprint: keyFingerprint(entry.key) });
    return result;
  }
  doc[provider] = entries;
  await savePool(doc);
  await appendAudit({ op: "update", target: provider, fingerprint: keyFingerprint(entry.key) });
  return { ok: true, newKeyId };
}
async function removeKey(provider, keyId) {
  const doc = await loadPool();
  const entries = doc[provider] || [];
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId);
  if (idx < 0) return { ok: false, error: "密钥不存在" };
  const cc = await loadCcDoc();
  const blocked = cc.cards.filter((c) => c.keyId === keyId && c.enabled).map((c) => c.id);
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `被 ${blocked.length} 张启用卡片引用，先移除或换绑卡片`,
      blockedCards: blocked
    };
  }
  entries.splice(idx, 1);
  if (entries.length === 0) delete doc[provider];
  else doc[provider] = entries;
  await savePool(doc);
  const fp = keyFingerprint(entries[idx]?.key || "");
  await appendAudit({ op: "remove", target: provider, fingerprint: fp });
  return { ok: true };
}
async function toggleKey(provider, keyId, enabled) {
  const doc = await loadPool();
  const entries = doc[provider] || [];
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId);
  if (idx < 0) return { ok: false, error: "密钥不存在" };
  entries[idx].disabled = !enabled;
  doc[provider] = entries;
  await savePool(doc);
  await appendAudit({ op: "toggle", target: provider, detail: enabled ? "enable" : "disable" });
  return { ok: true };
}
const _revealWindow = /* @__PURE__ */ new Map();
async function revealKey(provider, keyId) {
  const now = Date.now();
  const last = _revealWindow.get(keyId) || 0;
  if (now - last < REVEAL_COOLDOWN_MS) {
    await appendAudit({ op: "reveal-rejected", target: provider, detail: "cooldown" });
    return { ok: false, error: `reveal 冷却中：请 ${Math.ceil((REVEAL_COOLDOWN_MS - (now - last)) / 1e3)}s 后重试` };
  }
  _revealWindow.set(keyId, now);
  const doc = await loadPool();
  const entry = (doc[provider] || []).find((e) => keyIdFor(provider, e.key) === keyId);
  if (!entry) return { ok: false, error: "密钥不存在" };
  await appendAudit({ op: "reveal", target: provider, fingerprint: keyFingerprint(entry.key) });
  return { ok: true, key: entry.key };
}
async function listCustomProviders() {
  const { data } = await safeReadJson(fileInDataHome(CUSTOM_PROVIDERS_FILE), []);
  return Array.isArray(data) ? data : [];
}
async function addCustomProvider(p) {
  const list = await listCustomProviders();
  const exists = list.some((x) => x.id === p.id);
  if (exists) list.splice(list.findIndex((x) => x.id === p.id), 1);
  list.push(p);
  await atomicWriteJson(fileInDataHome(CUSTOM_PROVIDERS_FILE), list);
  await appendAudit({ op: "add", target: `custom:${p.id}` });
  return { ok: true };
}
async function removeCustomProvider(id) {
  const list = await listCustomProviders();
  const next = list.filter((x) => x.id !== id);
  await atomicWriteJson(fileInDataHome(CUSTOM_PROVIDERS_FILE), next);
  await appendAudit({ op: "remove", target: `custom:${id}` });
  return { ok: true };
}
function emptyCc() {
  return { schemaVersion: 1, cards: [], active: {}, apps: {} };
}
async function loadCcDoc() {
  const { data, recovered } = await safeReadJson(fileInDataHome(CC_SWITCH_FILE), emptyCc());
  const doc = {
    schemaVersion: 1,
    cards: Array.isArray(data.cards) ? data.cards : [],
    active: data.active && typeof data.active === "object" ? data.active : {},
    apps: data.apps && typeof data.apps === "object" ? data.apps : {},
    agentMode: data.agentMode && typeof data.agentMode === "object" ? data.agentMode : void 0
  };
  if (recovered) appendAudit({ op: "error", target: CC_SWITCH_FILE, detail: "cards .bak 自愈恢复" });
  return doc;
}
async function saveCcDoc(doc) {
  await atomicWriteJson(fileInDataHome(CC_SWITCH_FILE), doc);
}
async function addCard(input) {
  const name = String(input.name || "").trim();
  const baseUrl = String(input.baseUrl || "").trim();
  if (!name || !baseUrl) return { ok: false, error: "卡片名称与端点必填" };
  const doc = await loadCcDoc();
  const id = `c_${createHash("md5").update(`${name}:${baseUrl}:${Date.now()}`).digest("hex").slice(0, 10)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  doc.cards.push({
    id,
    name,
    baseUrl,
    keyId: input.keyId || "",
    protocol: input.protocol || "openai",
    wireApi: input.wireApi,
    models: input.models || [],
    defaultModel: input.defaultModel || input.models?.[0] || "",
    apps: input.apps || [],
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
  await saveCcDoc(doc);
  await appendAudit({ op: "add", target: `card:${id}` });
  return { ok: true, cardId: id };
}
async function updateCard(cardId, patch) {
  const doc = await loadCcDoc();
  const card = doc.cards.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: "卡片不存在" };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== void 0) card[k] = v;
  }
  card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await saveCcDoc(doc);
  await appendAudit({ op: "update", target: `card:${cardId}` });
  return { ok: true };
}
async function removeCard(cardId) {
  const doc = await loadCcDoc();
  const idx = doc.cards.findIndex((c) => c.id === cardId);
  if (idx < 0) return { ok: false, error: "卡片不存在" };
  doc.cards.splice(idx, 1);
  for (const [app2, activeId] of Object.entries(doc.active)) {
    if (activeId === cardId) delete doc.active[app2];
  }
  if (doc.agentMode) {
    for (const [app2, m] of Object.entries(doc.agentMode)) {
      if (m.cardId === cardId) delete doc.agentMode[app2];
    }
  }
  await saveCcDoc(doc);
  await appendAudit({ op: "remove", target: `card:${cardId}` });
  return { ok: true };
}
async function importMarkdown(markdown) {
  const result = { added: 0, skipped: [] };
  const sections = markdown.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const nameLine = sec.split("\n")[0] || "";
    const name = nameLine.replace(/^\d+\.\s*/, "").trim();
    if (!name) continue;
    const cell = (label) => {
      const m = sec.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|]+)\\|`));
      return m ? m[1].trim().replace(/^`|`$/g, "") : "";
    };
    const key = cell("API Key");
    const endpoint = cell("Base URL");
    if (!key || !endpoint) {
      result.skipped.push({ name, reason: "缺少 API Key 或 Base URL 行" });
      continue;
    }
    if (/^<.*>$/.test(key) || key === "public" || key.startsWith("{env:")) {
      result.skipped.push({ name, reason: "占位值/环境引用，非真实密钥，拒收" });
      continue;
    }
    const r = await addKey({ provider: slug(name), label: name, endpoint, key, priority: 0 });
    if (r.ok) result.added += 1;
    else result.skipped.push({ name, reason: r.error || "写入失败" });
  }
  if (result.added > 0) await appendAudit({ op: "import", detail: `${result.added} 条入库` });
  return result;
}
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function fetchModels(endpoint, protocol, key, timeoutMs = 1e4) {
  if (protocol !== "openai") {
    return { ok: true, verified: false, models: [], error: "该协议无公开模型目录，请手工填写模型 id" };
  }
  const base = String(endpoint || "").trim().replace(/\/v1\/?$/, "");
  const url = `${base}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: key ? { authorization: `Bearer ${key}` } : {}
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: true, verified: false, models: [], error: "鉴权失败 (401/403)，端点可达但未验证" };
    }
    if (!res.ok) {
      return { ok: true, verified: false, models: [], error: `模型目录不可用 (${res.status})，可手工填写` };
    }
    const body = await res.json();
    const models = (body.data || []).map((m) => m.id);
    return { ok: true, verified: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: true, verified: false, models: [], error: `端点不可达 (${msg.slice(0, 80)})，可手工填写` };
  } finally {
    clearTimeout(timer);
  }
}
async function validateEndpoint(endpoint, protocol, key, timeoutMs = 3e3) {
  const base = String(endpoint || "").trim().replace(/\/v1\/?$/, "");
  const url = `${base}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  const authHeaders = {};
  if (key) {
    if (protocol === "anthropic") authHeaders["x-api-key"] = key;
    else authHeaders.authorization = `Bearer ${key}`;
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: authHeaders
    });
    return { ok: true, reachable: true, status: res.status, latencyMs: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: true, reachable: false, latencyMs: Date.now() - t0, error: msg.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}
const BUILTIN_PRESETS = [
  { id: "openai", label: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", apiFormat: "openai", defaultModel: "gpt-4o-mini", keyField: "authorization_bearer" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", apiFormat: "anthropic", defaultModel: "claude-sonnet-4-5", keyField: "x-api-key" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini", defaultModel: "gemini-2.5-pro", keyField: "x-goog-api-key" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiFormat: "openai", defaultModel: "deepseek-chat", keyField: "authorization_bearer" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai", defaultModel: "", keyField: "authorization_bearer" }
];
let _presetCache = null;
async function loadPresets(force = false) {
  if (!force && _presetCache && Date.now() - _presetCache.at < 3e5) return _presetCache.presets;
  try {
    const { resolveBackendServicesRoot: resolveBackendServicesRoot2 } = await Promise.resolve().then(() => agentWriters);
    const root = resolveBackendServicesRoot2();
    if (root) {
      const { createRequire: createRequire2 } = await import("node:module");
      const req = createRequire2(path$1.join(root, "noop.js"));
      const presets = req(path$1.join(root, "gateway/providerPresets.js")).getProviderPresets();
      if (Array.isArray(presets) && presets.length > 0) {
        const mapped = presets.map((p) => ({
          id: p.id,
          label: p.label || p.id,
          baseUrl: p.baseUrl || "",
          apiFormat: p.apiFormat || "openai",
          defaultModel: p.defaultModel || "",
          keyField: p.keyField || "authorization_bearer",
          source: "backend"
        }));
        _presetCache = { at: Date.now(), presets: mapped, source: "backend" };
        return mapped;
      }
    }
  } catch {
  }
  _presetCache = { at: Date.now(), presets: BUILTIN_PRESETS.map((p) => ({ ...p, source: "builtin-fallback" })), source: "builtin-fallback" };
  return _presetCache.presets;
}
const keyStore = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  SETTINGS_FILE,
  _resetDataHomeCache,
  addCard,
  addCustomProvider,
  addKey,
  atomicWriteJson,
  baseHomeFile,
  dataHomeFile,
  fetchModels,
  getDataHome,
  importMarkdown,
  keyFingerprint,
  keyIdFor,
  listCustomProviders,
  listPool,
  listPoolEntriesPlain,
  loadCcDoc,
  loadPresets,
  maskKey,
  removeCard,
  removeCustomProvider,
  removeKey,
  resolveRepoRoot,
  revealKey,
  safeReadJson,
  saveCcDoc,
  savePool,
  toggleKey,
  updateCard,
  updateKey,
  validateEndpoint
}, Symbol.toStringTag, { value: "Module" }));
function runtimeFile() {
  return path$1.join(getDataHome(), PROXY_RUNTIME_FILE);
}
function authFile() {
  return path$1.join(getDataHome(), PROXY_AUTH_FILE);
}
function readProxyRuntime() {
  try {
    const raw = readFileSync(runtimeFile(), "utf-8");
    const rt = JSON.parse(raw);
    const http = rt.http;
    if (http?.enabled && http.port) {
      const host = http.host || "127.0.0.1";
      const endpoint = http.url || `http://${host}:${http.port}`;
      return { running: true, endpoint, host, port: http.port };
    }
    const https = rt.https;
    if (https?.enabled && https.port) {
      const host = https.host || "127.0.0.1";
      const endpoint = https.url || `https://${host}:${https.port}`;
      return { running: true, endpoint, host, port: https.port };
    }
  } catch {
  }
  return { running: false, endpoint: "", host: "", port: null };
}
function readProxyToken() {
  try {
    const raw = readFileSync(authFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.authToken || "";
  } catch {
    return "";
  }
}
async function proxyStatus() {
  const rt = readProxyRuntime();
  const token = readProxyToken();
  if (!rt.running) {
    return {
      running: false,
      endpoint: "",
      host: "",
      port: null,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: "khy 代理未运行：启动本地网关后重试（动作: 启动本地网关 目标: 127.0.0.1）"
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  let live = false;
  try {
    const res = await fetch(`${rt.endpoint.replace(/\/+$/, "")}/health`, { signal: ctrl.signal });
    live = res.status >= 200 && res.status < 500;
  } catch {
    live = false;
  }
  clearTimeout(timer);
  if (!live) {
    return {
      running: false,
      endpoint: rt.endpoint,
      host: rt.host,
      port: rt.port,
      relayFingerprint: token ? keyFingerprint(token) : null,
      detail: "khy 代理运行时文件已过期：端口无响应，请启动本地网关（动作: 重启网关 目标: 127.0.0.1）"
    };
  }
  return {
    running: true,
    endpoint: rt.endpoint,
    host: rt.host,
    port: rt.port,
    relayFingerprint: token ? keyFingerprint(token) : null,
    detail: `khy 代理运行中：${rt.endpoint}（模型/密钥切换为纯 khy 侧操作）`
  };
}
async function startProxy() {
  const { resolveBackendServicesRoot: resolveBackendServicesRoot2 } = await Promise.resolve().then(() => agentWriters);
  const root = resolveBackendServicesRoot2();
  if (!root) {
    return {
      ok: false,
      error: "本地网关启动失败：未找到 backend 服务（env KHY_BACKEND_SERVICES 或仓库内 services/backend），请改用 khy CLI 启动网关"
    };
  }
  try {
    const { createRequire: createRequire2 } = await import("node:module");
    const req = createRequire2(path$1.join(root, "noop.js"));
    const proxyServer = req(path$1.join(root, "gateway/proxyServer.js"));
    if (proxyServer.isRunning()) {
      return { ok: true, detail: "本地网关已在运行" };
    }
    await proxyServer.start();
    await new Promise((r) => setTimeout(r, 500));
    const st = await proxyStatus();
    return st.running ? { ok: true, detail: `本地网关已启动：${st.endpoint}` } : { ok: false, error: "本地网关启动中：500ms 后仍未就绪，请查看网关日志（动作: 检查日志 目标: 本地网关）" };
  } catch (e) {
    return { ok: false, error: `本地网关启动失败：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}
let _backendRoot = "unresolved";
let _backendAudited = false;
function resolveBackendServicesRoot() {
  if (_backendRoot !== "unresolved") return _backendRoot;
  const candidates = [];
  const explicit = process.env.KHY_BACKEND_SERVICES;
  if (explicit) candidates.push(path$1.resolve(explicit));
  const repoRoot = resolveRepoRoot();
  if (repoRoot) candidates.push(path$1.join(repoRoot, "services", "backend", "src", "services"));
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portable) candidates.push(path$1.join(portable, "khy-os", "services", "backend", "src", "services"));
  if (portable) candidates.push(path$1.join(portable, "services", "backend", "src", "services"));
  for (const c of candidates) {
    try {
      if (existsSync(path$1.join(c, "gateway", "providerPresets.js"))) {
        _backendRoot = c;
        return c;
      }
    } catch {
      continue;
    }
  }
  _backendRoot = null;
  return null;
}
async function _auditBackendResolution() {
  const root = resolveBackendServicesRoot();
  if (_backendAudited) return;
  _backendAudited = true;
  if (root) await appendAudit({ op: "backend-resolve-ok", target: root });
  else await appendAudit({ op: "backend-resolve-failed", detail: "use built-in writers" });
}
function expandHome(p) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path$1.join(home, p.slice(2));
  return p;
}
function agentTargetPath(app2) {
  switch (app2) {
    case "claude-code":
      return path$1.join(expandHome(process.env.CLAUDE_CONFIG_DIR || "~/.claude"), "settings.json");
    case "opencode": {
      if (process.env.OPENCODE_CONFIG) {
        const p = expandHome(process.env.OPENCODE_CONFIG);
        if (path$1.extname(p) === ".json") return p;
      }
      const dir = process.env.OPENCODE_CONFIG_DIR ? expandHome(process.env.OPENCODE_CONFIG_DIR) : process.env.XDG_CONFIG_HOME ? path$1.join(expandHome(process.env.XDG_CONFIG_HOME), "opencode") : path$1.join(expandHome("~"), ".config", "opencode");
      return path$1.join(dir, "opencode.json");
    }
    case "qodercli":
      return process.env.KHY_ENV_FILE || path$1.join(getRepoRootForEnvFile(), "services", "backend", ".env");
    default:
      return "";
  }
}
function getRepoRootForEnvFile() {
  const repoRoot = resolveRepoRoot();
  if (repoRoot) return repoRoot;
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portable) return path$1.join(portable, "khy-os");
  return process.cwd();
}
function preflight(app2, card, mode) {
  if (!card || !card.name) return { ok: false, reason: "卡片无效（缺少名称）" };
  if (mode === "proxy") {
    return { ok: true };
  }
  switch (app2) {
    case "claude-code":
      if (card.protocol === "anthropic") return { ok: true };
      return {
        ok: true,
        warning: "卡片为 OpenAI 线，Claude Code 需经 khy 代理转 anthropic 线（建议 Mode B 聚合模式）"
      };
    case "opencode":
      if (card.protocol === "openai" || card.protocol === "anthropic") return { ok: true };
      return { ok: false, reason: `OpenCode 支持 openai/anthropic 线，卡片为 ${card.protocol}` };
    case "qodercli":
      return { ok: true };
    default:
      return { ok: false, reason: `${app2} 的 writer 在 P2 交付（本期 P1 覆盖 claude-code/opencode/qodercli）` };
  }
}
async function backupLive(file) {
  try {
    await promises.copyFile(file, `${file}.pre-khy.bak`);
  } catch {
  }
}
async function readJsonSafe(file) {
  try {
    const raw = await promises.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function writeJsonAtomic(file, doc) {
  await promises.mkdir(path$1.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await promises.writeFile(tmp, JSON.stringify(doc, null, 2), "utf-8");
  await promises.rename(tmp, file);
}
async function applyProxyMode(app2, card) {
  const proxy = readProxyRuntime();
  if (!proxy.running || !proxy.endpoint) {
    return {
      ok: false,
      app: app2,
      error: "khy 代理未运行：启动本地网关后重试（动作: 启动本地网关 目标: 127.0.0.1）"
    };
  }
  const relay = readProxyToken();
  const model = card.defaultModel || card.models[0] || "";
  switch (app2) {
    case "claude-code": {
      const file = agentTargetPath("claude-code");
      await backupLive(file);
      const doc = await readJsonSafe(file);
      const env = doc.env && typeof doc.env === "object" ? doc.env : {};
      const root = proxy.endpoint.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
      env.ANTHROPIC_BASE_URL = root;
      env.ANTHROPIC_AUTH_TOKEN = relay;
      if (model) env.ANTHROPIC_MODEL = model;
      doc.env = env;
      await writeJsonAtomic(file, doc);
      await recordMode(app2, "proxy", card.id);
      await appendAudit({ op: "apply", target: app2, detail: `proxy ${root} model=${model || "(card default)"}` });
      return { ok: true, app: app2, targetPath: file, detail: `已写入 ${file}（khy 聚合 → ${root}，模型 ${model || "card 默认"}）` };
    }
    case "opencode": {
      const file = agentTargetPath("opencode");
      await backupLive(file);
      const doc = await readJsonSafe(file);
      const provider = doc.provider && typeof doc.provider === "object" ? doc.provider : {};
      const base = proxy.endpoint;
      provider["khy"] = {
        npm: "@ai-sdk/openai-compatible",
        name: "KhyOS 聚合网关",
        options: { baseURL: base.endsWith("/v1") ? base : `${base}/v1`, apiKey: relay },
        models: model ? { [model]: { name: model } } : {}
      };
      doc.provider = provider;
      if (model) doc.model = `khy/${model}`;
      await writeJsonAtomic(file, doc);
      await recordMode(app2, "proxy", card.id);
      await appendAudit({ op: "apply", target: app2, detail: `proxy ${base} model=${model || "(card default)"}` });
      return { ok: true, app: app2, targetPath: file, detail: `已写入 ${file}（provider.khy → ${base}，模型 ${model || "card 默认"}）` };
    }
    case "qodercli": {
      const file = agentTargetPath("qodercli");
      await backupLive(file);
      await patchEnvFile(file, {
        KHY_QODER_PROXY: "true",
        QODER_PROXY_ENDPOINT: proxy.endpoint.replace(/\/v1\/?$/, "").replace(/\/+$/, "")
      });
      await recordMode(app2, "proxy", card.id);
      await appendAudit({ op: "apply", target: app2, detail: `qoder-proxy → ${proxy.endpoint}` });
      return { ok: true, app: app2, targetPath: file, detail: `已写入 ${file}（KHY_QODER_PROXY=true，端点 ${proxy.endpoint}）` };
    }
    default:
      return { ok: false, app: app2, error: preflight(app2, card, "proxy").reason || "该 app 的 Mode B writer 未在 P1 交付" };
  }
}
async function applyDirectMode(app2, card) {
  switch (app2) {
    case "claude-code": {
      const pre = preflight(app2, card, "direct");
      if (!pre.ok) return { ok: false, app: app2, error: pre.reason };
      const entry = await resolveKeyEntry(card.keyId);
      if (!entry) return { ok: false, app: app2, error: "卡片引用的 key 在池中不存在 (keyId 失效)" };
      const file = agentTargetPath("claude-code");
      await backupLive(file);
      const doc = await readJsonSafe(file);
      const env = doc.env && typeof doc.env === "object" ? doc.env : {};
      const root = (entry.endpoint || card.baseUrl).replace(/\/v1\/?$/, "").replace(/\/+$/, "");
      env.ANTHROPIC_BASE_URL = root;
      if (card.protocol === "anthropic") env.ANTHROPIC_API_KEY = entry.key;
      else env.ANTHROPIC_AUTH_TOKEN = entry.key;
      const model = card.defaultModel || card.models[0] || "";
      if (model) env.ANTHROPIC_MODEL = model;
      doc.env = env;
      await writeJsonAtomic(file, doc);
      recordMode(app2, "direct", card.id);
      await appendAudit({ op: "apply", target: app2, detail: `direct ${root} model=${model || "(card default)"}` });
      return { ok: true, app: app2, targetPath: file, detail: pre.warning ? `${pre.warning}。已写入 ${file}` : `已写入 ${file}（直连 ${root}）` };
    }
    case "opencode": {
      const pre = preflight(app2, card, "direct");
      if (!pre.ok) return { ok: false, app: app2, error: pre.reason };
      const entry = await resolveKeyEntry(card.keyId);
      if (!entry) return { ok: false, app: app2, error: "卡片引用的 key 在池中不存在 (keyId 失效)" };
      const file = agentTargetPath("opencode");
      await backupLive(file);
      const doc = await readJsonSafe(file);
      const provider = doc.provider && typeof doc.provider === "object" ? doc.provider : {};
      const slug2 = card.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
      const model = card.defaultModel || card.models[0] || "";
      provider[slug2] = {
        npm: card.protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        name: card.name,
        options: { baseURL: entry.endpoint || card.baseUrl, apiKey: entry.key },
        models: model ? { [model]: { name: model } } : {}
      };
      doc.provider = provider;
      if (model) doc.model = `${slug2}/${model}`;
      await writeJsonAtomic(file, doc);
      recordMode(app2, "direct", card.id);
      await appendAudit({ op: "apply", target: app2, detail: `direct ${entry.endpoint || card.baseUrl}` });
      return { ok: true, app: app2, targetPath: file, detail: `已写入 ${file}（provider.${slug2} → ${entry.endpoint || card.baseUrl}）` };
    }
    default:
      return { ok: false, app: app2, error: preflight(app2, card, "direct").reason || "该 app 的 Mode A writer 未在 P1 交付" };
  }
}
async function recordMode(app2, mode, cardId) {
  const doc = await loadCcDoc();
  doc.agentMode = doc.agentMode || {};
  doc.agentMode[app2] = { mode, cardId, ts: (/* @__PURE__ */ new Date()).toISOString() };
  await saveCcDoc(doc);
}
async function resolveKeyEntry(keyId) {
  if (!keyId) return null;
  const doc = (await safeReadJson(
    path$1.join(getDataHome(), API_KEYS_FILE),
    {}
  )).data;
  for (const [provider, entries] of Object.entries(doc)) {
    for (const e of entries || []) {
      if (keyIdFor(provider, e.key) === keyId) return { key: e.key, endpoint: e.endpoint || "" };
    }
  }
  return null;
}
async function patchEnvFile(file, patch) {
  let lines = [];
  try {
    lines = (await promises.readFile(file, "utf-8")).split(/\r?\n/);
  } catch {
    lines = [];
  }
  const out = [];
  const consumed = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && patch[m[1]] !== void 0) {
      out.push(`${m[1]}=${patch[m[1]]}`);
      consumed.add(m[1]);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!consumed.has(k)) out.push(`${k}=${v}`);
  }
  await writeEnvAtomic(file, out);
}
async function writeEnvAtomic(file, lines) {
  await promises.mkdir(path$1.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await promises.writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  await promises.rename(tmp, file);
}
async function revertAgent(app2) {
  const file = agentTargetPath(app2);
  if (app2 === "qodercli") {
    await patchEnvFile(file, { KHY_QODER_PROXY: "false" });
    const doc2 = await loadCcDoc();
    if (doc2.agentMode && doc2.agentMode[app2]) {
      delete doc2.agentMode[app2];
      await saveCcDoc(doc2);
    }
    await appendAudit({ op: "revert", target: app2, detail: `gate off ${file}` });
    return { ok: true, app: app2, targetPath: file, detail: `已撤销 ${app2}（KHY_QODER_PROXY=false，门控关闭）` };
  }
  const bak = `${file}.pre-khy.bak`;
  if (!existsSync(bak)) {
    return { ok: false, app: app2, error: "无 .pre-khy.bak 备份：该 Agent 从未被 KeyManager 激活过" };
  }
  await promises.copyFile(bak, file);
  await promises.unlink(bak).catch(() => {
  });
  const doc = await loadCcDoc();
  if (doc.agentMode && doc.agentMode[app2]) {
    delete doc.agentMode[app2];
    await saveCcDoc(doc);
  }
  await appendAudit({ op: "revert", target: app2, detail: file });
  return { ok: true, app: app2, targetPath: file, detail: `已恢复 ${file}（.pre-khy.bak）` };
}
async function agentMatrix() {
  const doc = await loadCcDoc();
  const apps = ["claude-code", "opencode", "qodercli"];
  const labels = {
    "claude-code": "Claude Code",
    opencode: "OpenCode",
    qodercli: "Qoder CLI"
  };
  const rows = [];
  for (const app2 of apps) {
    const am = doc.agentMode?.[app2];
    rows.push({
      app: app2,
      label: labels[app2] || app2,
      writer: "builtin",
      mode: am ? am.mode : "none",
      cardId: am ? am.cardId : doc.active[app2] || "",
      targetPath: agentTargetPath(app2),
      lastApplied: am ? am.ts : "",
      hint: am ? am.mode === "proxy" ? "khy 聚合：换模型/换 key 纯 khy 侧操作，Agent 零改动" : "直连：换 key/端点需重新激活" : "未激活"
    });
  }
  return rows;
}
const agentWriters = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  _auditBackendResolution,
  agentMatrix,
  agentTargetPath,
  applyDirectMode,
  applyProxyMode,
  preflight,
  resolveBackendServicesRoot,
  revertAgent
}, Symbol.toStringTag, { value: "Module" }));
function classify(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  if (status >= 500) return "upstream";
  return "ok";
}
const STATUS_HINT = {
  ok: "可用",
  auth: "认证失败 (401/403)：密钥无效或过期，请在 Provider 页更新",
  rate: "限流 (429)：请求过多，稍后重试",
  upstream: "上游异常 (5xx)：模型服务暂不可用，请稍后重试",
  timeout: "请求超时：网络或服务响应慢，请稍后重试",
  reachable: "端点可达"
};
function statusHint(status) {
  return STATUS_HINT[status];
}
function shortHost(endpoint) {
  try {
    const u = new URL(String(endpoint || "").replace(/\/v1\/?$/, "") || "http://(empty)");
    return u.host;
  } catch {
    return "(invalid endpoint)";
  }
}
async function probeOne(t, timeoutMs = PROBE_TIMEOUT_MS) {
  const base = String(t.endpoint || "").trim().replace(/\/v1\/?$/, "");
  const url = `${base}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  const headers = {};
  if (t.key) {
    if (t.protocol === "anthropic") headers["x-api-key"] = t.key;
    else headers.authorization = `Bearer ${t.key}`;
  }
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, headers });
    const status = classify(res.status);
    return {
      keyId: t.keyId,
      provider: t.provider,
      endpoint: t.endpoint,
      status,
      detail: statusHint(status),
      latencyMs: Date.now() - t0
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      keyId: t.keyId,
      provider: t.provider,
      endpoint: t.endpoint,
      status: aborted ? "timeout" : "upstream",
      detail: aborted ? STATUS_HINT.timeout : "网络连接失败：请检查网络代理设置",
      latencyMs: Date.now() - t0
    };
  } finally {
    clearTimeout(timer);
  }
}
async function probeAll(targets, opts = {}) {
  const limit = opts.concurrency || PROBE_CONCURRENCY;
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const results = new Array(targets.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < targets.length) {
      const idx = next;
      next += 1;
      const t = targets[idx];
      results[idx] = await probeOne(t, timeoutMs);
      done += 1;
      opts.onProgress?.({
        done,
        total: targets.length,
        label: `探测 ${done}/${targets.length}：${t.provider} (${shortHost(t.endpoint)})`
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, () => worker()));
  return results;
}
function ok(data) {
  return { ok: true, data };
}
function err(error, extra) {
  return { ok: false, error, ...extra };
}
function registerKeyManagerIpc(ipc, repoRootOverride) {
  _auditBackendResolution().catch(() => {
  });
  const repoRoot = () => resolveRepoRoot();
  ipc.handle("keys:list", async () => ok(await listPool()));
  ipc.handle("keys:add", async (_e, input) => {
    const r = await addKey(input || {});
    return r.ok ? ok({ keyId: r.keyId, provider: r.provider }) : err(r.error || "add failed");
  });
  ipc.handle("keys:update", async (_e, provider, keyId, patch) => {
    const r = await updateKey(provider, keyId, patch || {});
    return r.ok ? ok({ newKeyId: r.newKeyId, reattachedCards: r.reattachedCards || 0 }) : err(r.error || "update failed");
  });
  ipc.handle("keys:remove", async (_e, provider, keyId) => {
    const r = await removeKey(provider, keyId);
    return r.ok ? ok({}) : err(r.error || "remove failed", { blockedCards: r.blockedCards });
  });
  ipc.handle("keys:toggle", async (_e, provider, keyId, enabled) => {
    const r = await toggleKey(provider, keyId, enabled);
    return r.ok ? ok({}) : err(r.error || "toggle failed");
  });
  ipc.handle("keys:reveal", async (_e, provider, keyId) => {
    const r = await revealKey(provider, keyId);
    return r.ok ? ok({ key: r.key }) : err(r.error || "reveal failed");
  });
  ipc.handle("keys:import", async () => {
    const root = repoRoot();
    if (!root) return err("仓库根未解析：设置 env KHYOS_DESKTOP_REPO_ROOT 后重试");
    const { readFileSync: readFileSync2 } = await import("node:fs");
    const { join } = await import("node:path");
    let md = "";
    try {
      md = readFileSync2(join(root, "docs", "opencode-provider-keys.md"), "utf-8");
    } catch {
      return err("导入源不存在：docs/opencode-provider-keys.md（动作: 检查文档 目标: docs/）");
    }
    const r = await importMarkdown(md);
    return ok({ added: r.added, skipped: r.skipped });
  });
  ipc.handle("providers:list", async () => ok(await listCustomProviders()));
  ipc.handle("providers:add", async (_e, p) => ok(await addCustomProvider(p)));
  ipc.handle("providers:remove", async (_e, id) => ok(await removeCustomProvider(id)));
  ipc.handle("endpoints:presets", async () => ok(await loadPresets()));
  ipc.handle(
    "endpoints:validate",
    async (_e, input) => ok(await validateEndpoint(input?.endpoint || "", input?.protocol || "openai", input?.key || ""))
  );
  ipc.handle(
    "models:fetch",
    async (_e, input) => ok(await fetchModels(input?.endpoint || "", input?.protocol || "openai", input?.key || ""))
  );
  ipc.handle("cards:list", async () => {
    const doc = await loadCcDoc();
    return ok({ cards: doc.cards, active: doc.active, agentMode: doc.agentMode || {} });
  });
  ipc.handle("cards:add", async (_e, input) => {
    const r = await addCard(input);
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || "card add failed");
  });
  ipc.handle("cards:update", async (_e, cardId, patch) => {
    const r = await updateCard(cardId, patch);
    return r.ok ? ok({}) : err(r.error || "card update failed");
  });
  ipc.handle("cards:remove", async (_e, cardId) => {
    const r = await removeCard(cardId);
    return r.ok ? ok({}) : err(r.error || "card remove failed");
  });
  ipc.handle("agents:matrix", async () => ok(await agentMatrix()));
  ipc.handle("agents:apply", async (_e, input) => {
    const app2 = input?.app || "";
    const cardId = input?.cardId || "";
    const mode = input?.mode === "direct" ? "direct" : "proxy";
    const doc = await loadCcDoc();
    const card = doc.cards.find((c) => c.id === cardId);
    if (!card) return err("卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: 端点预设）");
    const r = mode === "proxy" ? await applyProxyMode(app2, card) : await applyDirectMode(app2, card);
    if (!r.ok) return err(r.error || "apply failed");
    await appendAudit({ op: "apply", target: app2, detail: `${mode} card=${card.id}` });
    return ok({ detail: r.detail, targetPath: r.targetPath, mode, cardId: card.id });
  });
  ipc.handle("agents:revert", async (_e, app2) => {
    const r = await revertAgent(app2);
    return r.ok ? ok({ detail: r.detail, targetPath: r.targetPath }) : err(r.error || "revert failed");
  });
  ipc.handle("proxy:status", async () => ok(await proxyStatus()));
  ipc.handle("proxy:start", async () => {
    const r = await startProxy();
    return r.ok ? ok({ detail: r.detail }) : err(r.error || "proxy start failed");
  });
  ipc.handle("health:probe", async (_e, input) => {
    const plain = await listPoolEntriesPlain();
    let targets = plain.map((e) => ({
      keyId: keyIdFor(e.provider, e.key),
      provider: e.provider,
      endpoint: e.endpoint,
      key: e.key,
      protocol: "openai"
    }));
    if (input?.keyId) targets = targets.filter((t) => t.keyId === input.keyId);
    const results = await probeAll(targets);
    const { maskKey: maskKey2, keyFingerprint: keyFingerprint2 } = await Promise.resolve().then(() => keyStore);
    return ok({
      results: results.map((r) => ({ ...r, detail: `${r.detail} [${r.keyId}]` })),
      fingerprints: Object.fromEntries(targets.map((t) => [t.keyId, keyFingerprint2(t.key)])),
      masks: Object.fromEntries(targets.map((t) => [t.keyId, maskKey2(t.key)])),
      timeoutMs: PROBE_TIMEOUT_MS
    });
  });
  ipc.handle("health:audit-list", async (_e, limit) => ok(await listAudit(limit || 200)));
  ipc.handle("health:audit-export", async (_e, dest) => ok(await exportAudit(dest)));
}
function settingsPath() {
  return baseHomeFile(SETTINGS_FILE);
}
async function ensureDir$5() {
  const dir = path$1.dirname(settingsPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
const DEFAULTS = {
  locale: "system",
  theme: "dark",
  dataPath: "",
  archiveRetention: "7d",
  autoArchive: true,
  groupFileChanges: true,
  groupTerminalCommands: true,
  groupExploreTools: true,
  showTodo: false,
  showReasoning: true,
  keepFullModelIO: false,
  autoContinueQuestions: true,
  interactionBehavior: "queue",
  preventIdleSleep: false,
  hideToTray: false,
  notificationSound: true,
  taskNotifications: true,
  autoUpdate: false,
  prereleaseUpdates: false,
  hardwareAcceleration: true,
  customCert: "",
  noProxy: "",
  httpProxy: "",
  enhancedFindGrep: false,
  terminalShell: "auto",
  terminalFont: "",
  inheritTerminalProfile: true,
  optInExperience: false,
  // Appearance: message body font size consumed via --khy-message-font-size
  // CSS var on <html> (MarkdownRenderer); CUA dispatch interval in ms.
  messageFontSize: "14",
  cuaActionInterval: "500",
  // Model selection (P3-7②): option id (`<provider>` or `<provider>/<model>`)
  // persisted by the renderer via setSetting; empty string = no selection yet.
  selectedModel: "",
  // Workspace root chosen via 窗口菜单 → 打开工作区 / 侧栏 添加项目. Empty
  // string = no explicit choice yet, main falls back to process.cwd()
  // (getWorkspaceRoot in index.ts). Single source for the workspace chip, the
  // file tree and workspace:listFiles — one value, no divergent copies.
  desktopWorkspacePath: "",
  // 最近打开的工作空间（[DESIGN-ARCH-125] P-02）：MRU 候选集，上限 8。
  // 它**不是**第二个真源 —— 「当前是哪个工作空间」仍只由 desktopWorkspacePath
  // 回答，本字段只回答「可以切到哪几个」，供卡片/标题栏的选择器列出最近目录，
  // 免去每次切换都弹系统目录框。读取侧（workspace:list）会过滤掉已不存在的
  // 路径：列出来的项必须真的能切过去，不做死链陈列。
  desktopRecentWorkspaces: [],
  // Agent 模式（Composer 工具行「切换模式」选择器，i18n mode.label.glm.*）：
  // 'confirm' | 'autoEdit' | 'plan' | 'fullAccess'
  // P3-9①：默认对齐 ZCode 实测「完全访问」（mode.label.glm.yolo）；
  // 用户显式切换后经 setSetting 落盘覆盖此默认值。
  desktopAgentMode: "fullAccess",
  // Editor binary for 在编辑器中打开 (e.g. "code"). Empty = fall back to
  // KHY_EDITOR env; both empty → the action reports how to configure it.
  desktopEditor: "",
  // Window geometry
  desktopWindowSize: { width: 1216, height: 808, maximized: false }
};
let cache$3 = null;
async function getSettingsStore() {
  if (cache$3) return cache$3;
  try {
    const raw = await promises.readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    cache$3 = { ...DEFAULTS, ...parsed };
  } catch {
    cache$3 = { ...DEFAULTS };
  }
  return cache$3;
}
async function setSetting(key, value) {
  const current = await getSettingsStore();
  current[key] = value;
  cache$3 = current;
  await ensureDir$5();
  const tmpPath = settingsPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify(current, null, 2), "utf-8");
  await promises.rename(tmpPath, settingsPath());
}
async function getTheme() {
  const settings = await getSettingsStore();
  return settings.theme || "dark";
}
async function setTheme(mode) {
  await setSetting("theme", mode);
}
const AUTOMATIONS_FILE = "automations.json";
const MAX_RUN_HISTORY = 20;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
function automationsPath() {
  return baseHomeFile(AUTOMATIONS_FILE);
}
async function ensureDir$4() {
  const dir = path$1.dirname(automationsPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
let cache$2 = null;
let seq = 0;
async function load$2() {
  if (cache$2) return cache$2;
  try {
    const raw = await promises.readFile(automationsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    cache$2 = Array.isArray(parsed.automations) ? parsed.automations : [];
  } catch {
    cache$2 = [];
  }
  let healed = false;
  for (const a of cache$2) {
    for (const r of a.runs) {
      if (r.status === "running") {
        r.status = "failed";
        r.error = "进程异常退出，运行未完成";
        r.durationMs = Date.now() - r.startedAt;
        healed = true;
      }
    }
  }
  if (healed) await persist$4(cache$2);
  return cache$2;
}
async function persist$4(list) {
  await ensureDir$4();
  const tmpPath = automationsPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify({ automations: list }, null, 2), "utf-8");
  await promises.rename(tmpPath, automationsPath());
  cache$2 = list;
}
function computeNextRunAt(a, from = Date.now()) {
  if (!a.enabled) return null;
  if (typeof a.maxRuns === "number" && a.runCount >= a.maxRuns) return null;
  const s = a.schedule;
  if (s.kind === "minutes") {
    const interval = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, s.intervalMinutes || 60));
    return from + interval * 6e4;
  }
  const [hh, mm] = (s.time || "09:00").split(":").map((v) => Number(v));
  const d = new Date(from);
  d.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  if (s.kind === "weekdays") {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}
function normalizeSchedule(input) {
  const s = input || {};
  if (s.kind === "minutes") {
    const n = Math.round(Number(s.intervalMinutes));
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      return { error: `间隔分钟数无效：请输入 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数` };
    }
    return { schedule: { kind: "minutes", intervalMinutes: n } };
  }
  if (s.kind === "daily" || s.kind === "weekdays") {
    if (typeof s.time !== "string" || !/^\d{2}:\d{2}$/.test(s.time)) {
      return { error: "运行时间无效：请按 HH:mm 格式填写（例如 09:00）" };
    }
    return { schedule: { kind: s.kind, time: s.time } };
  }
  return { error: "调度类型无效：请选择 每 N 分钟 / 每天 / 每工作日" };
}
async function getAutomations() {
  return [...await load$2()];
}
async function createAutomation(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: "指令为空：请填写每次运行时这个任务要做什么" };
  }
  const norm = normalizeSchedule(input.schedule);
  if (norm.error || !norm.schedule) {
    return { ok: false, error: norm.error || "调度配置无效：请检查调度设置" };
  }
  let maxRuns;
  if (input.maxRuns !== void 0 && input.maxRuns !== null) {
    const n = Math.round(Number(input.maxRuns));
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: "最大运行次数无效：请填写 1 以上的整数，或留空表示无限重复" };
    }
    maxRuns = n;
  }
  const list = await load$2();
  const now = Date.now();
  const a = {
    id: `auto_${now.toString(36)}_${++seq}`,
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "未命名定时任务",
    prompt,
    schedule: norm.schedule,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    runCount: 0,
    ...maxRuns !== void 0 ? { maxRuns } : {},
    runs: []
  };
  a.nextRunAt = computeNextRunAt(a, now);
  list.unshift(a);
  await persist$4(list);
  return { ok: true, automation: a };
}
async function updateAutomation(id, patch) {
  const list = await load$2();
  const a = list.find((x) => x.id === id);
  if (!a) {
    return { ok: false, error: "未找到该定时任务，可能已被删除" };
  }
  if (typeof patch.title === "string" && patch.title.trim()) a.title = patch.title.trim();
  if (typeof patch.prompt === "string" && patch.prompt.trim()) a.prompt = patch.prompt.trim();
  if (patch.schedule !== void 0) {
    const norm = normalizeSchedule(patch.schedule);
    if (norm.error || !norm.schedule) {
      return { ok: false, error: norm.error || "调度配置无效：请检查调度设置" };
    }
    a.schedule = norm.schedule;
  }
  if (patch.enabled !== void 0) {
    a.enabled = !!patch.enabled;
  }
  if (patch.maxRuns !== void 0) {
    if (patch.maxRuns === null) {
      delete a.maxRuns;
    } else {
      const n = Math.round(Number(patch.maxRuns));
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, error: "最大运行次数无效：请填写 1 以上的整数，或留空表示无限重复" };
      }
      a.maxRuns = n;
    }
  }
  a.updatedAt = Date.now();
  a.nextRunAt = computeNextRunAt(a, a.updatedAt);
  await persist$4(list);
  return { ok: true, automation: a };
}
async function deleteAutomation(id) {
  const list = await load$2();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) {
    return { ok: false, error: "未找到该定时任务，可能已被删除" };
  }
  list.splice(idx, 1);
  await persist$4(list);
  return { ok: true };
}
async function recordRunStart(id, trigger) {
  const list = await load$2();
  const a = list.find((x) => x.id === id);
  if (!a) {
    return { ok: false, error: "未找到该定时任务，可能已被删除" };
  }
  a.runCount += 1;
  a.runs.unshift({ trigger, status: "running", startedAt: Date.now() });
  if (a.runs.length > MAX_RUN_HISTORY) a.runs.length = MAX_RUN_HISTORY;
  a.updatedAt = Date.now();
  a.nextRunAt = computeNextRunAt(a, a.updatedAt);
  await persist$4(list);
  return { ok: true, automation: a };
}
async function recordRunSkipped(id) {
  const list = await load$2();
  const a = list.find((x) => x.id === id);
  if (!a) return { ok: false, error: "未找到该定时任务，可能已被删除" };
  a.runs.unshift({ trigger: "schedule", status: "skipped", startedAt: Date.now(), error: "上一条正在运行中，本次调度已跳过" });
  if (a.runs.length > MAX_RUN_HISTORY) a.runs.length = MAX_RUN_HISTORY;
  a.nextRunAt = computeNextRunAt(a, Date.now());
  await persist$4(list);
  return { ok: true };
}
async function recordRunEnd(id, startedAt, status, extra) {
  const list = await load$2();
  const a = list.find((x) => x.id === id);
  if (!a) return { ok: false, error: "未找到该定时任务，可能已被删除" };
  const run = a.runs.find((r) => r.startedAt === startedAt && r.status === "running");
  if (!run) return { ok: false, error: "未找到进行中的运行记录：可能已被清理" };
  run.status = status;
  run.durationMs = extra.durationMs;
  if (extra.error) run.error = extra.error;
  if (extra.resultPreview) run.resultPreview = extra.resultPreview;
  await persist$4(list);
  return { ok: true };
}
const PLUGINS_FILE = "plugins.json";
function pluginsPath() {
  return baseHomeFile(PLUGINS_FILE);
}
async function ensureDir$3() {
  const dir = path$1.dirname(pluginsPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
function builtinInstallPath(id) {
  return path$1.join(path$1.dirname(pluginsPath()), "plugins", id);
}
function builtinSeeds() {
  const now = Date.now();
  const mk = (id, name, version, description, components) => ({
    id,
    name,
    version,
    description,
    source: "builtin",
    enabled: true,
    installedAt: now,
    installPath: builtinInstallPath(id),
    components: {
      skills: components.skills ?? 0,
      commands: components.commands ?? 0,
      hooks: components.hooks ?? 0,
      mcp: components.mcp ?? 0,
      agents: components.agents ?? 0,
      lsp: components.lsp ?? 0
    }
  });
  return [
    mk("zcode-anthropic", "zcode-anthropic", "1.0.4", "ZCode 官方插件，提供基础能力与默认配置。", {
      commands: 14,
      agents: 1
    }),
    mk("khyos-quant", "khyos-quant", "1.2.0", "KhyOS 内置的 khyquant 量化终端能力包：行情命令、回测工具与 MCP 服务器。", {
      skills: 3,
      commands: 8,
      hooks: 1,
      mcp: 1
    }),
    mk("khyos-docs", "khyos-docs", "0.9.1", "仓库文档导航技能：按 docs/ 两轴规范检索设计文档。", {
      skills: 1,
      commands: 2
    })
  ];
}
let cache$1 = null;
async function load$1() {
  if (cache$1) return cache$1;
  let stored = [];
  try {
    const raw = await promises.readFile(pluginsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.plugins)) stored = parsed.plugins;
  } catch {
    stored = [];
  }
  const seen = new Set(stored.filter((p) => p.source === "builtin").map((p) => p.id));
  const tombstones = new Set(
    stored.filter((p) => p.source === "__uninstalled__" && p.builtinId).map((p) => p.builtinId)
  );
  const result = [...stored.filter((p) => p.source !== "__uninstalled__")];
  for (const seed of builtinSeeds()) {
    if (!seen.has(seed.id) && !tombstones.has(seed.id)) result.push(seed);
  }
  cache$1 = result;
  return cache$1;
}
async function persist$3(list) {
  await ensureDir$3();
  const tmpPath = pluginsPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify({ plugins: list }, null, 2), "utf-8");
  await promises.rename(tmpPath, pluginsPath());
  cache$1 = list;
}
function normalizeComponents(input) {
  const c = input || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  return {
    skills: num(c.skills),
    commands: num(c.commands),
    hooks: num(c.hooks),
    mcp: num(c.mcp),
    agents: num(c.agents),
    lsp: num(c.lsp)
  };
}
async function installPlugin(input) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!id || !name) {
    return { ok: false, error: "插件信息无效：缺少插件 ID 或名称，请重新选择后安装" };
  }
  const marketplace = typeof input.marketplace === "string" && input.marketplace.trim() ? input.marketplace.trim() : "官方市场";
  const list = await load$1();
  if (list.some((p) => p.id === id)) {
    return { ok: false, error: "插件已存在：请先卸载同名插件，或直接使用已安装版本" };
  }
  const plugin = {
    id,
    name,
    version: typeof input.version === "string" && input.version.trim() ? input.version.trim() : "0.1.0",
    description: typeof input.description === "string" ? input.description : "",
    source: marketplace,
    enabled: true,
    installedAt: Date.now(),
    installPath: builtinInstallPath(id),
    components: normalizeComponents(input.components)
  };
  list.push(plugin);
  await persist$3(list);
  return { ok: true, plugin };
}
async function getPlugins() {
  return [...await load$1()];
}
async function setPluginEnabled(id, enabled) {
  const list = await load$1();
  const p = list.find((x) => x.id === id);
  if (!p) {
    return { ok: false, error: "未找到该插件，可能已被卸载" };
  }
  p.enabled = !!enabled;
  await persist$3(list);
  return { ok: true, plugin: p };
}
async function uninstallPlugin(id) {
  const list = await load$1();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) {
    return { ok: false, error: "未找到该插件，可能已被卸载" };
  }
  const target = list[idx];
  list.splice(idx, 1);
  if (target.source === "builtin") {
    list.push({ ...target, source: "__uninstalled__", enabled: false });
  }
  try {
    await promises.rm(target.installPath, { recursive: true, force: true });
  } catch {
  }
  await persist$3(list);
  return { ok: true };
}
async function checkPluginUpdates() {
  const list = await load$1();
  let count = 0;
  const newer = (() => {
    try {
      return JSON.parse(process.env.KHY_PLUGIN_UPDATES || "{}");
    } catch {
      return {};
    }
  })();
  for (const p of list) {
    const latest = newer[p.id];
    if (latest && latest !== p.version) {
      p.updateAvailable = true;
      count += 1;
    } else {
      p.updateAvailable = false;
    }
  }
  await persist$3(list);
  return { ok: true, count };
}
const MCP_FILE = "mcp_servers.json";
function mcpPath() {
  return baseHomeFile(MCP_FILE);
}
async function ensureDir$2() {
  const dir = path$1.dirname(mcpPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
let cache = null;
async function load() {
  if (cache) return cache;
  let stored = [];
  try {
    const raw = await promises.readFile(mcpPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.servers)) stored = parsed.servers;
  } catch {
    stored = [];
  }
  cache = stored;
  return cache;
}
async function persist$2(list) {
  await ensureDir$2();
  const tmpPath = mcpPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify({ servers: list }, null, 2), "utf-8");
  await promises.rename(tmpPath, mcpPath());
  cache = list;
}
async function getMcpServers() {
  return [...await load()];
}
async function createMcpServer(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!name) {
    return { ok: false, error: "服务器名称不能为空：请填写名称后保存" };
  }
  if (!command) {
    return { ok: false, error: "启动命令/URL 不能为空：请填写 stdio 命令或 http(s) URL 后保存" };
  }
  const isUrl = /^https?:\/\//i.test(command);
  const looksLikeCommand = command.split(/\s+/).length >= 1 && /^[A-Za-z0-9_\-./\\:"']/.test(command);
  if (!isUrl && !looksLikeCommand) {
    return { ok: false, error: "启动命令无效：请填写可执行的 stdio 命令（例如 npx -y xxx）或 http(s) URL" };
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
    createdAt: Date.now()
  };
  list.push(server);
  await persist$2(list);
  return { ok: true, server };
}
async function setMcpServerEnabled(id, enabled) {
  const list = await load();
  const s = list.find((x) => x.id === id);
  if (!s) {
    return { ok: false, error: "未找到该 MCP 服务器，可能已被删除" };
  }
  s.enabled = !!enabled;
  await persist$2(list);
  return { ok: true, server: s };
}
async function deleteMcpServer(id) {
  const list = await load();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) {
    return { ok: false, error: "未找到该 MCP 服务器，可能已被删除" };
  }
  list.splice(idx, 1);
  await persist$2(list);
  return { ok: true };
}
async function importMcpServers(rows) {
  if (!Array.isArray(rows)) {
    return { ok: false, error: "剪贴板内容不是 JSON 数组：请复制 [{name, command}] 形式后重试" };
  }
  const list = await load();
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const r = row;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const command = typeof r.command === "string" ? r.command.trim() : "";
    if (!name || !command || list.some((s) => s.name === name)) {
      skipped += 1;
      continue;
    }
    list.push({
      id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      command,
      enabled: r.enabled !== false,
      createdAt: Date.now()
    });
    created += 1;
  }
  await persist$2(list);
  return { ok: true, created, skipped };
}
const ITEMS_FILE = "agent_items.json";
const AGENT_ITEM_KINDS = /* @__PURE__ */ new Set(["command", "hook", "skill", "subagent", "memory"]);
function itemsPath() {
  return dataHomeFile(ITEMS_FILE);
}
async function ensureDir$1() {
  const dir = path$1.dirname(itemsPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
async function loadDoc$1() {
  try {
    const raw = await promises.readFile(itemsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items)) return parsed;
  } catch {
  }
  return { items: [] };
}
async function persist$1(doc) {
  await ensureDir$1();
  const tmpPath = itemsPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify(doc, null, 2), "utf-8");
  await promises.rename(tmpPath, itemsPath());
}
function kindError(kind) {
  if (!AGENT_ITEM_KINDS.has(kind)) {
    return `未知的条目类型「${kind}」：请通过设置页重试，或重启应用`;
  }
  return null;
}
function normalizeRow(input) {
  const row = input || {};
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  return {
    name,
    description: typeof row.description === "string" ? row.description : "",
    content: typeof row.content === "string" ? row.content : ""
  };
}
function newId(kind) {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
async function listItems(kind) {
  const err2 = kindError(kind);
  if (err2) return { ok: false, error: err2 };
  const doc = await loadDoc$1();
  const items = doc.items.filter((it) => it.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, items: items.map((it) => ({ ...it })) };
}
async function createItem(kind, input) {
  const err2 = kindError(kind);
  if (err2) return { ok: false, error: err2 };
  const row = normalizeRow(input);
  if (!row) {
    return { ok: false, error: "条目信息无效：名称不能为空，请填写名称后保存" };
  }
  const doc = await loadDoc$1();
  if (doc.items.some((it) => it.kind === kind && it.name === row.name)) {
    return { ok: false, error: `名称「${row.name}」已被使用：请换一个名称，或先删除同名条目` };
  }
  const now = Date.now();
  const item = {
    id: newId(kind),
    kind,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: true,
    source: "user",
    createdAt: now,
    updatedAt: now
  };
  doc.items.push(item);
  await persist$1(doc);
  return { ok: true, item };
}
async function setItemEnabled(kind, id, enabled) {
  const err2 = kindError(kind);
  if (err2) return { ok: false, error: err2 };
  const doc = await loadDoc$1();
  const item = doc.items.find((it) => it.kind === kind && it.id === id);
  if (!item) {
    return { ok: false, error: "未找到该条目，可能已被删除" };
  }
  item.enabled = !!enabled;
  item.updatedAt = Date.now();
  await persist$1(doc);
  return { ok: true };
}
async function deleteItem(kind, id) {
  const err2 = kindError(kind);
  if (err2) return { ok: false, error: err2 };
  const doc = await loadDoc$1();
  const idx = doc.items.findIndex((it) => it.kind === kind && it.id === id);
  if (idx === -1) {
    return { ok: false, error: "未找到该条目，可能已被删除" };
  }
  doc.items.splice(idx, 1);
  await persist$1(doc);
  return { ok: true };
}
async function importItems(kind, rows) {
  const err2 = kindError(kind);
  if (err2) return { ok: false, error: err2 };
  if (!Array.isArray(rows)) {
    return { ok: false, error: "导入内容不是 JSON 数组：请复制 [{name, content}] 形式后重试" };
  }
  const doc = await loadDoc$1();
  const now = Date.now();
  let created = 0;
  let skipped = 0;
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row || doc.items.some((it) => it.kind === kind && it.name === row.name)) {
      skipped += 1;
      continue;
    }
    doc.items.push({
      id: newId(kind),
      kind,
      name: row.name,
      description: row.description,
      content: row.content,
      enabled: true,
      source: "user",
      createdAt: now,
      updatedAt: now
    });
    created += 1;
  }
  if (created > 0) await persist$1(doc);
  return { ok: true, created, skipped };
}
const MIGRATION_SOURCES = [
  {
    id: "claude-code",
    label: "Claude Code",
    homeDir: ".claude",
    sections: [
      { dir: "commands", kind: "command", label: "命令" },
      { dir: "skills", kind: "skill", label: "技能" }
    ]
  },
  {
    id: "cursor",
    label: "Cursor",
    homeDir: ".cursor",
    sections: [{ dir: "rules", kind: "skill", label: "规则" }]
  },
  {
    id: "codex",
    label: "Codex CLI",
    homeDir: ".codex",
    sections: [{ dir: "prompts", kind: "command", label: "提示词" }]
  }
];
async function countDefinitionFiles(dir) {
  try {
    const entries = await promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}
async function scanMigrations() {
  const home = os.homedir();
  const sources = [];
  for (const src of MIGRATION_SOURCES) {
    const configDir = path$1.join(home, src.homeDir);
    let found = false;
    const counts = [];
    try {
      await promises.access(configDir);
      found = true;
    } catch {
      found = false;
    }
    if (found) {
      for (const section of src.sections) {
        const count = await countDefinitionFiles(path$1.join(configDir, section.dir));
        counts.push({ label: section.label, count });
      }
    }
    sources.push({ id: src.id, label: src.label, found, counts });
  }
  return { ok: true, sources };
}
async function importMigration(sourceId) {
  const src = MIGRATION_SOURCES.find((s) => s.id === sourceId);
  if (!src) {
    return { ok: false, error: `未知的迁移来源「${sourceId}」：请重新检测后导入` };
  }
  const home = os.homedir();
  const configDir = path$1.join(home, src.homeDir);
  try {
    await promises.access(configDir);
  } catch {
    return { ok: false, error: `未找到 ${src.label} 的配置目录（${src.homeDir}）：请确认已安装后重试` };
  }
  const doc = await loadDoc$1();
  const now = Date.now();
  let created = 0;
  let skipped = 0;
  for (const section of src.sections) {
    const sectionDir = path$1.join(configDir, section.dir);
    let files = [];
    try {
      files = (await promises.readdir(sectionDir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch {
      continue;
    }
    for (const file of files) {
      const name = path$1.basename(file, ".md");
      if (doc.items.some((it) => it.kind === section.kind && it.name === name)) {
        skipped += 1;
        continue;
      }
      try {
        const content = await promises.readFile(path$1.join(sectionDir, file), "utf-8");
        const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
        doc.items.push({
          id: newId(section.kind),
          kind: section.kind,
          name,
          description: firstLine ? firstLine.slice(0, 80) : "",
          content,
          enabled: true,
          source: `imported:${src.id}`,
          createdAt: now,
          updatedAt: now
        });
        created += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  if (created > 0) await persist$1(doc);
  return { ok: true, created, skipped };
}
function migrationDataHome() {
  return getDataHome();
}
const INDEX_FILE = "code_indexes.json";
const SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".khy",
  "coverage",
  ".next",
  ".turbo"
]);
const TEXT_EXTS = /* @__PURE__ */ new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".sh",
  ".bat",
  ".ps1",
  ".py",
  ".cjs",
  ".mjs"
]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5e3;
function indexPath() {
  return dataHomeFile(INDEX_FILE);
}
async function ensureDir() {
  const dir = path$1.dirname(indexPath());
  if (!existsSync(dir)) {
    await promises.mkdir(dir, { recursive: true });
  }
}
async function loadDoc() {
  try {
    const raw = await promises.readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.indexes)) return parsed;
  } catch {
  }
  return { indexes: [] };
}
async function persist(doc) {
  await ensureDir();
  const tmpPath = indexPath() + ".tmp";
  await promises.writeFile(tmpPath, JSON.stringify(doc, null, 2), "utf-8");
  await promises.rename(tmpPath, indexPath());
}
async function scanWorkspace(root) {
  let fileCount = 0;
  let totalBytes = 0;
  let entries = 0;
  const queue = [{ dir: root, depth: 0 }];
  try {
    await promises.access(root);
  } catch {
    return { error: `目录不可读（${root}）：请确认路径存在后重试` };
  }
  while (queue.length > 0 && entries < MAX_ENTRIES) {
    const { dir, depth } = queue.shift();
    if (depth >= MAX_DEPTH) continue;
    let dirents;
    try {
      dirents = await promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirents) {
      entries += 1;
      if (entries >= MAX_ENTRIES) break;
      const full = path$1.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && TEXT_EXTS.has(path$1.extname(e.name).toLowerCase())) {
        try {
          const stat = await promises.stat(full);
          fileCount += 1;
          totalBytes += stat.size;
        } catch {
        }
      }
    }
  }
  return { fileCount, totalBytes };
}
async function listIndexes() {
  const doc = await loadDoc();
  const indexes = [...doc.indexes].sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, indexes: indexes.map((ix) => ({ ...ix })) };
}
async function createIndex(input) {
  const row = input || {};
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "当前工作区";
  const root = typeof row.root === "string" && row.root.trim() ? path$1.resolve(row.root) : process.cwd();
  const doc = await loadDoc();
  if (doc.indexes.some((ix) => ix.root === root)) {
    return { ok: false, error: "该工作区已有索引：请在列表中选择「重建」刷新统计，或删除后重新创建" };
  }
  const scan = await scanWorkspace(root);
  if ("error" in scan) return { ok: false, error: scan.error };
  const now = Date.now();
  const index = {
    id: `index_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    root,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  doc.indexes.push(index);
  await persist(doc);
  return { ok: true, index };
}
async function rebuildIndex(id) {
  const doc = await loadDoc();
  const ix = doc.indexes.find((x) => x.id === id);
  if (!ix) {
    return { ok: false, error: "未找到该索引，可能已被删除" };
  }
  const scan = await scanWorkspace(ix.root);
  if ("error" in scan) return { ok: false, error: scan.error };
  ix.fileCount = scan.fileCount;
  ix.totalBytes = scan.totalBytes;
  ix.updatedAt = Date.now();
  await persist(doc);
  return { ok: true, index: ix };
}
async function setIndexEnabled(id, enabled) {
  const doc = await loadDoc();
  const ix = doc.indexes.find((x) => x.id === id);
  if (!ix) {
    return { ok: false, error: "未找到该索引，可能已被删除" };
  }
  ix.enabled = !!enabled;
  ix.updatedAt = Date.now();
  await persist(doc);
  return { ok: true };
}
async function deleteIndex(id) {
  const doc = await loadDoc();
  const idx = doc.indexes.findIndex((x) => x.id === id);
  if (idx === -1) {
    return { ok: false, error: "未找到该索引，可能已被删除" };
  }
  doc.indexes.splice(idx, 1);
  await persist(doc);
  return { ok: true };
}
const nodeRequire = createRequire(import.meta.url);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disk-cache-dir", path$1.join(os.tmpdir(), "KhyOS-Desktop", "GPUCache"));
let hostProcess = null;
let schedulerProcess = null;
async function getWorkspaceRoot() {
  try {
    const settings = await getSettingsStore();
    const configured = settings.desktopWorkspacePath;
    if (typeof configured === "string" && configured.trim()) {
      const resolved = path$1.resolve(configured.trim());
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    }
  } catch {
  }
  return process.cwd();
}
const RECENT_WORKSPACES_MAX = 8;
async function readRecentWorkspaces() {
  try {
    const settings = await getSettingsStore();
    const raw = settings.desktopRecentWorkspaces;
    if (!Array.isArray(raw)) return [];
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const entry of raw) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const resolved = path$1.resolve(entry.trim());
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ path: resolved, name: path$1.basename(resolved) || resolved });
    }
    return out;
  } catch {
    return [];
  }
}
async function switchWorkspace(rawPath) {
  const resolved = path$1.resolve(rawPath);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `该路径不是可用目录：${resolved}` };
    }
  } catch (err2) {
    return { ok: false, error: `无法访问该路径：${String(err2)}` };
  }
  await setSetting("desktopWorkspacePath", resolved);
  const settings = await getSettingsStore();
  const prev = Array.isArray(settings.desktopRecentWorkspaces) ? settings.desktopRecentWorkspaces : [];
  const next = [resolved, ...prev.filter((p) => typeof p === "string" && path$1.resolve(p) !== resolved)].slice(0, RECENT_WORKSPACES_MAX);
  await setSetting("desktopRecentWorkspaces", next);
  return { ok: true, path: resolved };
}
const pendingAi = /* @__PURE__ */ new Map();
const pendingSessionList = /* @__PURE__ */ new Map();
const pendingSessionCreate = /* @__PURE__ */ new Map();
const pendingSessionMessages = /* @__PURE__ */ new Map();
const pendingTokenUsage = /* @__PURE__ */ new Map();
const pendingUsageHistory = /* @__PURE__ */ new Map();
const pendingContextSize = /* @__PURE__ */ new Map();
const pendingModelList = /* @__PURE__ */ new Map();
const pendingDesktopGate = /* @__PURE__ */ new Map();
const pendingBackgroundStatus = /* @__PURE__ */ new Map();
const pendingAutomationRuns = /* @__PURE__ */ new Map();
const runningAutomationIds = /* @__PURE__ */ new Set();
let aiSeq = 0;
const AUTOMATION_HOST_PREFIX = "auto_";
function parseGitStatus(stdout) {
  const entries = stdout.split("\0").filter((s) => s.length > 0);
  const branchEntry = entries.find((s) => s.startsWith("## "));
  const changes = [];
  let branch;
  let upstream;
  let ahead;
  let behind;
  if (branchEntry) {
    const header = branchEntry.slice(3);
    const m = header.match(/^([^.\s]+(?:\/[^.\s]+)?)?(\.{2,3}(\S+))?\s*(\[ahead (\d+)(?:, )?(?:behind (\d+))?\]|\[behind (\d+)\])?/);
    branch = m?.[1] || (header.includes("HEAD") ? "HEAD" : header.split(/\s|\.{2,3}/)[0] || void 0);
    upstream = m?.[3];
    const aheadStr = m?.[5];
    const behindStr = m?.[6] || m?.[7];
    if (aheadStr) ahead = Number(aheadStr);
    if (behindStr) behind = Number(behindStr);
  }
  const entriesNoBranch = entries.filter((s) => !s.startsWith("## "));
  for (let i = 0; i < entriesNoBranch.length; i++) {
    const entry = entriesNoBranch[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rawPath = entry.slice(3);
    let status;
    if (xy === "??") {
      status = "untracked";
    } else if (xy[0] === "R" || xy[1] === "R") {
      if (i + 1 < entriesNoBranch.length) i++;
      status = "renamed";
    } else if (xy[0] === "A" || xy[1] === "A") {
      status = "added";
    } else if (xy[0] === "D" || xy[1] === "D") {
      status = "deleted";
    } else {
      status = "modified";
    }
    const staged = xy !== "??" && xy[0] !== " ";
    changes.push({ path: rawPath, status, staged });
  }
  return { ok: true, state: "ok", branch, upstream, ahead, behind, changes };
}
function unrefSockets(proc) {
  try {
    for (const s of [proc.stdout, proc.stderr]) {
      const unref = s?.unref;
      if (typeof unref === "function") unref.call(s);
    }
  } catch {
  }
}
function handleHostMessage(msg) {
  const m = msg;
  if (!m || typeof m !== "object") return;
  if (m.type === "session.listResult" && m.id) {
    const entry = pendingSessionList.get(m.id);
    if (entry) {
      pendingSessionList.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "session.createResult" && m.id) {
    const entry = pendingSessionCreate.get(m.id);
    if (entry) {
      pendingSessionCreate.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "session.messagesResult" && m.id) {
    const entry = pendingSessionMessages.get(m.id);
    if (entry) {
      pendingSessionMessages.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "token.usageResult" && m.id) {
    const entry = pendingTokenUsage.get(m.id);
    if (entry) {
      pendingTokenUsage.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "usage.historyResult" && m.id) {
    const entry = pendingUsageHistory.get(m.id);
    if (entry) {
      pendingUsageHistory.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "context.sizeResult" && m.id) {
    const entry = pendingContextSize.get(m.id);
    if (entry) {
      pendingContextSize.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "models.listResult" && m.id) {
    const entry = pendingModelList.get(m.id);
    if (entry) {
      pendingModelList.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if ((m.type === "desktopGate.setResult" || m.type === "desktopGate.getResult") && m.id) {
    const entry = pendingDesktopGate.get(m.id);
    if (entry) {
      pendingDesktopGate.delete(m.id);
      entry.resolve(m);
      return;
    }
    console.log("[host] desktopGate:", JSON.stringify(m));
    return;
  }
  if (m.type === "background.statusResult" && m.id) {
    const entry = pendingBackgroundStatus.get(m.id);
    if (entry) {
      pendingBackgroundStatus.delete(m.id);
      entry.resolve(m);
    }
    return;
  }
  if (m.type === "ai.result" && m.id && String(m.id).startsWith(AUTOMATION_HOST_PREFIX)) {
    void settleAutomationRun(m.id, m);
    return;
  }
  if ((m.type === "ai.chunk" || m.type === "ai.toolCall" || m.type === "ai.toolResult" || m.type === "ai.controlRequest" || m.type === "ai.result") && m.id) {
    const entry = pendingAi.get(m.id);
    if (m.type === "ai.result") pendingAi.delete(m.id);
    const wc = entry?.win;
    if (wc && !wc.isDestroyed()) {
      try {
        wc.webContents.send(m.type, m);
      } catch (err2) {
        console.log("[host] send to renderer failed:", String(err2));
      }
    }
    if (m.type === "ai.result") {
      try {
        entry?.resolve(m);
      } catch (err2) {
        console.log("[host] resolve failed:", String(err2));
      }
    }
    return;
  }
  if (m.type === "ready") {
    console.log("[host] ready:", JSON.stringify(m));
    unrefSockets(hostProcess);
    void applyDesktopGateFromSettings();
    return;
  }
  console.log("[host] message:", JSON.stringify(m));
}
const CUA_GATE_KEYS = ["cuaDesktopControlMode", "cuaMaxActuations", "cuaAllowedApps"];
async function desktopGatePatchFromSettings() {
  const settings = await getSettingsStore();
  const patch = {};
  const mode = String(settings.cuaDesktopControlMode || "").trim().toLowerCase();
  if (["off", "ask", "on", "strict"].includes(mode)) patch.mode = mode;
  const budget = String(settings.cuaMaxActuations ?? "").trim();
  if (/^\d+$/.test(budget) && Number(budget) > 0) patch.budget = budget;
  if (typeof settings.cuaAllowedApps === "string") patch.allowedApps = settings.cuaAllowedApps.trim();
  return patch;
}
async function applyDesktopGateFromSettings() {
  if (!hostProcess || !hostProcess.connected) return;
  try {
    const patch = await desktopGatePatchFromSettings();
    if (Object.keys(patch).length === 0) return;
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`;
    hostProcess.send({ type: "desktopGate.set", id, ...patch });
  } catch (err2) {
    console.log("[host] desktopGate 初始化失败:", String(err2));
  }
}
const KEY_MANAGER_STANDALONE = process.argv.includes("--key-manager");
async function fireAutomation(id, trigger) {
  if (!hostProcess || !hostProcess.connected) {
    return { ok: false, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
  }
  const list = await getAutomations();
  const a = list.find((x) => x.id === id);
  if (!a) {
    return { ok: false, error: "未找到该定时任务，可能已被删除" };
  }
  if (runningAutomationIds.has(id)) {
    if (trigger === "manual") {
      return { ok: false, error: "上一条正在运行中，请稍后再试" };
    }
    await recordRunSkipped(id);
    return { ok: true, skipped: true };
  }
  const started = await recordRunStart(id, trigger);
  if (!started.ok || !started.automation) {
    return { ok: false, error: started.error || "触发运行失败" };
  }
  const hostReqId = `${AUTOMATION_HOST_PREFIX}${Date.now().toString(36)}_${++aiSeq}`;
  runningAutomationIds.add(id);
  pendingAutomationRuns.set(hostReqId, { automationId: id, startedAt: Date.now() });
  hostProcess.send({ type: "ai.generate", id: hostReqId, prompt: a.prompt, options: {} });
  return { ok: true };
}
async function settleAutomationRun(hostReqId, result) {
  const entry = pendingAutomationRuns.get(hostReqId);
  pendingAutomationRuns.delete(hostReqId);
  if (!entry) return;
  runningAutomationIds.delete(entry.automationId);
  const durationMs = Date.now() - entry.startedAt;
  const okFlag = result.ok !== false && typeof result.text === "string" && result.text.length > 0;
  await recordRunEnd(entry.automationId, entry.startedAt, okFlag ? "succeeded" : "failed", {
    durationMs,
    error: okFlag ? void 0 : result.error || "模型无输出：可能端点错误/模型名无效/额度不足，运行 khy gateway status 检查",
    resultPreview: okFlag && typeof result.text === "string" ? result.text.slice(0, 400) : void 0
  }).catch((e) => {
    console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`);
  });
}
const AUTOMATION_TICK_MS = 3e4;
let automationTimer = null;
async function runDueAutomations() {
  const list = await getAutomations();
  for (const a of list) {
    if (a.enabled && a.nextRunAt !== null && a.nextRunAt <= Date.now()) {
      const r = await fireAutomation(a.id, "schedule");
      if (!r.ok) console.log(`[automation] 调度触发失败 (${a.title}): ${r.error}`);
    }
  }
}
function startAutomationScheduler() {
  if (automationTimer) return;
  automationTimer = setInterval(() => {
    void runDueAutomations();
  }, AUTOMATION_TICK_MS);
  automationTimer.unref?.();
}
function failAllAutomationRuns(reason) {
  for (const [hostReqId, entry] of pendingAutomationRuns) {
    pendingAutomationRuns.delete(hostReqId);
    runningAutomationIds.delete(entry.automationId);
    void recordRunEnd(entry.automationId, entry.startedAt, "failed", {
      durationMs: Date.now() - entry.startedAt,
      error: reason
    }).catch((e) => {
      console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
function settleAutomationRunsOnQuit() {
  if (pendingAutomationRuns.size === 0) return;
  failAllAutomationRuns("应用已退出，运行中断");
  setTimeout(() => {
  }, 500);
}
function startHostProcess() {
  const hostPath = path$1.join(__dirname, "../host/index.js");
  hostProcess = fork(hostPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const logSafe = (tag, write) => (data) => {
    const text = data.toString();
    try {
      write(text);
    } catch (err2) {
      console.log(`[host] ${tag} 输出管道已关闭，停止转发: ${String(err2)}`);
    }
  };
  hostProcess.stdout?.on("data", logSafe("stdout", (s) => console.log(`[host] ${s}`)));
  hostProcess.stderr?.on("data", logSafe("stderr", (s) => console.error(`[host] ${s}`)));
  hostProcess.on("message", handleHostMessage);
  hostProcess.on("exit", (code) => {
    console.log(`[host] 进程退出, code=${code}`);
    hostProcess = null;
    failAllAutomationRuns(`host 进程退出 (code=${code})，运行中断`);
  });
}
function startSchedulerProcess() {
  const schedulerPath = path$1.join(__dirname, "../scheduler/index.js");
  try {
    schedulerProcess = fork(schedulerPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  } catch (err2) {
    console.log(`[scheduler] 进程启动失败: ${String(err2)}`);
    schedulerProcess = null;
    return;
  }
  const logSafe = (tag, write) => (data) => {
    const text = data.toString();
    try {
      write(text);
    } catch {
      console.log(`[scheduler] ${tag} 输出管道已关闭，停止转发`);
    }
  };
  schedulerProcess.stdout?.on("data", logSafe("stdout", (s) => console.log(`[scheduler] ${s}`)));
  schedulerProcess.stderr?.on("data", logSafe("stderr", (s) => console.error(`[scheduler] ${s}`)));
  schedulerProcess.on("message", (msg) => {
    const m = msg;
    if (m?.type === "ready") console.log(`[scheduler] ready: pid=${m.pid}`);
  });
  schedulerProcess.on("exit", (code) => {
    console.log(`[scheduler] 进程退出, code=${code}`);
    schedulerProcess = null;
  });
}
function resolveAppIcon() {
  const candidates = [
    // electron-builder packaged resources (win.icon in package.json build block)
    path$1.join(process.resourcesPath, "icon", "icon.ico"),
    path$1.join(process.resourcesPath, "icon.ico"),
    // Repo / portable source tree (public dir next to the main entry's out/)
    path$1.join(__dirname, "../../public/icon.ico"),
    path$1.join(__dirname, "../renderer/icon.ico")
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
    }
  }
  return void 0;
}
async function createWindow() {
  const settings = await getSettingsStore();
  const size = settings.desktopWindowSize || {};
  const width = typeof size.width === "number" && size.width >= 800 ? size.width : 1216;
  const height = typeof size.height === "number" && size.height >= 600 ? size.height : 808;
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
    ...resolveAppIcon() ? { icon: resolveAppIcon() } : {},
    webPreferences: {
      // Preload is built as CJS (electron.vite.config.ts forces format:'cjs')
      // because sandboxed preloads cannot be ESM — see P0-6 in ZC-ALIGN-001.
      preload: path$1.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Browser tab (BrowserPane) embeds live pages via <webview> — ZCode uses
      // a guest view for its side-panel browser; webview is the Electron
      // equivalent (back/forward/reload + did-navigate/did-fail-load events).
      webviewTag: true
    }
  });
  const persistGeometry = () => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    setSetting("desktopWindowSize", {
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized()
    }).catch((e) => {
      console.log(`[settings] 窗口尺寸保存失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  win.on("close", persistGeometry);
  const devPort = process.env.VITE_DEV_PORT || "5173";
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`;
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === "development") {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path$1.join(__dirname, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => {
    win.show();
    if (size.maximized === true) win.maximize();
  });
  ipcMain.handle("window:minimize", () => win.minimize());
  ipcMain.handle("window:maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("window:close", () => win.close());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:workspacePath", () => getWorkspaceRoot());
  ipcMain.handle("workspace:list", async () => {
    return { ok: true, current: await getWorkspaceRoot(), recents: await readRecentWorkspaces() };
  });
  ipcMain.handle("workspace:open", async (_e, target) => {
    const requested = typeof target === "string" ? target.trim() : "";
    let chosen = requested;
    if (!chosen) {
      const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      chosen = result.filePaths[0];
    }
    return switchWorkspace(chosen);
  });
  ipcMain.handle("settings:get", async () => {
    return getSettingsStore();
  });
  ipcMain.handle("settings:set", async (_e, key, value) => {
    await setSetting(key, value);
    if (typeof key === "string" && CUA_GATE_KEYS.includes(key)) {
      await applyDesktopGateFromSettings();
    }
    return true;
  });
  ipcMain.handle("settings:setDataPath", async (_e, newPath) => {
    if (typeof newPath !== "string" || !newPath.trim()) {
      return { ok: false, error: "路径为空：请选择或输入有效的数据存储路径" };
    }
    const target = path$1.resolve(newPath.trim());
    const baseSettings = baseHomeFile("settings.json");
    const currentHome = getDataHome();
    const newHome = path$1.join(target, ".khy");
    if (newHome === currentHome) {
      return { ok: true, moved: false, home: newHome };
    }
    try {
      const fs2 = await import("node:fs");
      await fs2.promises.cp(currentHome, newHome, {
        recursive: true,
        force: true,
        filter: (src) => path$1.resolve(src) !== path$1.resolve(baseSettings)
      });
      await setSetting("dataPath", target);
      _resetDataHomeCache();
      return { ok: true, moved: true, home: newHome };
    } catch (err2) {
      return {
        ok: false,
        error: `数据迁移失败：${err2 instanceof Error ? err2.message : String(err2)}，已保留原路径，请检查目标磁盘可写后重试`
      };
    }
  });
  ipcMain.handle("theme:get", async () => {
    return getTheme();
  });
  ipcMain.handle("theme:set", async (_e, mode) => {
    await setTheme(mode);
    for (const win2 of BrowserWindow.getAllWindows()) {
      if (!win2.isDestroyed()) {
        win2.webContents.send("theme:changed", mode);
      }
    }
    return true;
  });
  ipcMain.handle("zoom:set", async (e, factor) => {
    const clamped = Math.min(2, Math.max(0.5, Number(factor)));
    const wc = e.sender;
    if (!Number.isFinite(clamped)) {
      throw new Error("缩放值无效：请传入 0.5–2.0 之间的数字");
    }
    wc.setZoomFactor(clamped);
    return clamped;
  });
  ipcMain.handle("fs:openDirectory", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("fs:selectFiles", async (_e, filters) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: Array.isArray(filters) && filters.length > 0 ? filters : void 0
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("fs:readFile", async (e, filePath) => {
    const fs2 = await import("fs/promises");
    return fs2.readFile(filePath, "utf-8");
  });
  ipcMain.handle("fs:writeFile", async (e, filePath, content) => {
    const fs2 = await import("fs/promises");
    await fs2.writeFile(filePath, content, "utf-8");
    return true;
  });
  ipcMain.handle("codeViewer:read", async (_e, filePath) => {
    const PREVIEW_LIMIT = 256 * 1024;
    try {
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { ok: false, state: "missing" };
      }
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        return { ok: false, state: "missing" };
      }
      if (stat.size > PREVIEW_LIMIT) {
        return { ok: false, state: "tooLarge", size: stat.size };
      }
      const buf = await fs.promises.readFile(filePath);
      if (buf.length === 0) {
        return { ok: false, state: "empty" };
      }
      const probe = buf.subarray(0, Math.min(buf.length, 8192));
      if (probe.includes(0)) {
        return { ok: false, state: "binary" };
      }
      return { ok: true, state: "ok", content: buf.toString("utf-8"), size: buf.length };
    } catch {
      return { ok: false, state: "missing" };
    }
  });
  ipcMain.handle("workspace:listFiles", async (_e, query) => {
    const root = await getWorkspaceRoot();
    const SKIP_DIRS2 = /* @__PURE__ */ new Set([
      "node_modules",
      ".git",
      "dist",
      "out",
      "build",
      ".khy",
      "coverage",
      ".next",
      ".turbo"
    ]);
    const TEXT_EXTS2 = /* @__PURE__ */ new Set([
      ".md",
      ".markdown",
      ".txt",
      ".json",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".vue",
      ".css",
      ".html",
      ".yml",
      ".yaml",
      ".toml",
      ".ini",
      ".sh",
      ".bat",
      ".ps1",
      ".py",
      ".cjs",
      ".mjs"
    ]);
    const MAX_FILES = 5e3;
    const results = [];
    const q = (query || "").trim().toLowerCase();
    try {
      const walk = (dir, depth) => {
        if (results.length >= MAX_FILES || depth > 8) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (results.length >= MAX_FILES) return;
          const full = path$1.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!SKIP_DIRS2.has(ent.name.toLowerCase()) && !ent.name.startsWith(".")) {
              walk(full, depth + 1);
            }
          } else if (ent.isFile()) {
            const ext = path$1.extname(ent.name).toLowerCase();
            if (!TEXT_EXTS2.has(ext)) continue;
            if (q && !full.toLowerCase().includes(q)) continue;
            results.push({ path: full, name: ent.name });
          }
        }
      };
      walk(root, 0);
      return { ok: true, root, files: results };
    } catch (err2) {
      return { ok: false, error: `工作区文件索引失败：${err2 instanceof Error ? err2.message : String(err2)}，请检查工作区目录权限` };
    }
  });
  ipcMain.handle("workspace:readTree", async (_e, dirPath, query) => {
    const root = typeof dirPath === "string" && dirPath.trim() ? path$1.resolve(dirPath.trim()) : await getWorkspaceRoot();
    const SKIP_DIRS2 = /* @__PURE__ */ new Set([
      "node_modules",
      ".git",
      "dist",
      "out",
      "build",
      ".khy",
      "coverage",
      ".next",
      ".turbo"
    ]);
    const q = (query || "").trim().toLowerCase();
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const items = entries.map((ent) => ({
        name: ent.name,
        path: path$1.join(root, ent.name),
        kind: ent.isDirectory() ? "directory" : ent.isFile() ? "file" : "other"
      })).filter((it) => it.kind !== "other").filter((it) => !(it.kind === "directory" && SKIP_DIRS2.has(it.name.toLowerCase()))).filter((it) => !q || it.name.toLowerCase().includes(q)).sort(
        (a, b) => a.kind === b.kind ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.kind === "directory" ? -1 : 1
      );
      return { ok: true, root, items };
    } catch (err2) {
      return { ok: false, error: `读取目录失败：${err2 instanceof Error ? err2.message : String(err2)}，请检查目录权限后重试` };
    }
  });
  ipcMain.handle("ai:send", async (e, payload) => {
    const prompt = payload?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return { ok: false, error: "请求缺少 prompt：请输入要发送的内容后重试" };
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `ai_${Date.now()}_${++aiSeq}`;
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: "发送窗口已关闭：请重试" };
    }
    const workspaceRoot = await getWorkspaceRoot();
    const options = { ...payload?.options || {}, cwd: workspaceRoot };
    return new Promise((resolve) => {
      pendingAi.set(id, { resolve, win: senderWin });
      hostProcess.send({ type: "ai.generate", id, prompt, options });
      setTimeout(() => {
        if (pendingAi.has(id)) {
          pendingAi.delete(id);
          resolve({ ok: false, error: "host 进程响应超时：请查看导出日志排查 host 状态" });
        }
      }, 3e5);
    });
  });
  ipcMain.handle("ai:stream", async (e, payload) => {
    console.log("[ai] stream (streaming flows through ai:send + ai:chunk)", payload);
    return { ok: true };
  });
  ipcMain.handle("session:list", async (e, limit) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, sessions: [], error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `sess_list_${Date.now()}_${++aiSeq}`;
    BrowserWindow.fromWebContents(e.sender);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionList.delete(id);
        resolve({ ok: false, sessions: [], error: "会话列表读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingSessionList.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "session.list", id, limit: typeof limit === "number" ? limit : 50 });
    });
  });
  ipcMain.handle("session:create", async (e, workspacePath) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `sess_create_${Date.now()}_${++aiSeq}`;
    const cwd = typeof workspacePath === "string" && workspacePath ? workspacePath : process.cwd();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionCreate.delete(id);
        resolve({ ok: false, error: "会话创建超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingSessionCreate.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "session.create", id, cwd });
    });
  });
  ipcMain.handle("session:messages", async (e, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { ok: false, messages: [], error: "会话 ID 为空：请先在左侧任务列表中选择一个会话" };
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, messages: [], error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `sess_msgs_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionMessages.delete(id);
        resolve({ ok: false, messages: [], error: "会话内容读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingSessionMessages.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "session.messages", id, sessionId });
    });
  });
  ipcMain.handle("host:status", async () => {
    return { running: !!hostProcess, pid: hostProcess?.pid };
  });
  ipcMain.handle("token:usage", async (e) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, usage: null, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `token_usage_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTokenUsage.delete(id);
        resolve({ ok: false, usage: null, error: "Token 用量读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingTokenUsage.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "token.usage", id });
    });
  });
  ipcMain.handle("usage:history", async (_e, days) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, history: null, models: null, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `usage_history_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingUsageHistory.delete(id);
        resolve({ ok: false, history: null, models: null, error: "用量历史读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingUsageHistory.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "usage.history", id, days: typeof days === "number" && days > 0 ? Math.floor(days) : 30 });
    });
  });
  ipcMain.handle("background:status", async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, status: null, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `bg_status_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBackgroundStatus.delete(id);
        resolve({ ok: false, status: null, error: "后台任务计数读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingBackgroundStatus.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "background.status", id });
    });
  });
  ipcMain.handle("desktopGate:get", async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, gate: null, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDesktopGate.delete(id);
        resolve({ ok: false, gate: null, error: "安全闸状态读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingDesktopGate.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "desktopGate.get", id });
    });
  });
  ipcMain.handle("context:size", async (_e, text) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, estimate: null, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `ctx_size_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingContextSize.delete(id);
        resolve({ ok: false, estimate: null, error: "上下文估算超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingContextSize.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "context.size", id, text: typeof text === "string" ? text : "" });
    });
  });
  ipcMain.handle("models:list", async (_e, adapterKey) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, models: [], error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    const id = `models_list_${Date.now()}_${++aiSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingModelList.delete(id);
        resolve({ ok: false, models: [], error: "模型列表读取超时：请查看导出日志排查 host 状态" });
      }, 15e3);
      pendingModelList.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        }
      });
      hostProcess.send({ type: "models.list", id, adapterKey: typeof adapterKey === "string" ? adapterKey : void 0 });
    });
  });
  ipcMain.handle("automation:list", async () => {
    return { ok: true, automations: await getAutomations() };
  });
  ipcMain.handle("automation:create", (_e, input) => createAutomation(input || {}));
  ipcMain.handle(
    "automation:update",
    (_e, id, patch) => updateAutomation(id, patch || {})
  );
  ipcMain.handle("automation:delete", (_e, id) => deleteAutomation(id));
  ipcMain.handle("automation:runNow", (_e, id) => fireAutomation(id, "manual"));
  ipcMain.handle("plugin:list", async () => {
    return { ok: true, plugins: await getPlugins() };
  });
  ipcMain.handle(
    "plugin:install",
    (_e, input) => installPlugin(input || {})
  );
  ipcMain.handle("plugin:setEnabled", (_e, id, enabled) => setPluginEnabled(id, enabled));
  ipcMain.handle("plugin:uninstall", (_e, id) => uninstallPlugin(id));
  ipcMain.handle("plugin:checkUpdates", async () => checkPluginUpdates());
  ipcMain.handle("mcp:list", async () => {
    return { ok: true, servers: await getMcpServers() };
  });
  ipcMain.handle("mcp:create", (_e, input) => createMcpServer(input || {}));
  ipcMain.handle("mcp:setEnabled", (_e, id, enabled) => setMcpServerEnabled(id, enabled));
  ipcMain.handle("mcp:delete", (_e, id) => deleteMcpServer(id));
  ipcMain.handle("mcp:import", (_e, rows) => importMcpServers(rows));
  ipcMain.handle("agent:list", (_e, kind) => listItems(kind));
  ipcMain.handle("agent:create", (_e, kind, input) => createItem(kind, input));
  ipcMain.handle("agent:setEnabled", (_e, kind, id, enabled) => setItemEnabled(kind, id, enabled));
  ipcMain.handle("agent:delete", (_e, kind, id) => deleteItem(kind, id));
  ipcMain.handle("agent:import", (_e, kind, rows) => importItems(kind, rows));
  ipcMain.handle("index:list", async () => listIndexes());
  ipcMain.handle("index:create", (_e, input) => createIndex(input));
  ipcMain.handle("index:rebuild", (_e, id) => rebuildIndex(id));
  ipcMain.handle("index:setEnabled", (_e, id, enabled) => setIndexEnabled(id, enabled));
  ipcMain.handle("index:delete", (_e, id) => deleteIndex(id));
  ipcMain.handle("migration:scan", async () => scanMigrations());
  ipcMain.handle("migration:import", (_e, sourceId) => importMigration(sourceId));
  ipcMain.handle("app:dataHome", () => migrationDataHome());
  ipcMain.handle("git:status", async () => {
    const cwd = process.cwd();
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile("git", ["status", "--porcelain=v1", "-z", "--branch"], { cwd, timeout: 1e4, maxBuffer: 4 * 1024 * 1024 }, (err2, out) => {
          if (err2) reject(err2);
          else resolve(out);
        });
      });
      return parseGitStatus(stdout);
    } catch (err2) {
      const e = err2;
      if (e.code === "ENOENT") {
        return { ok: false, state: "gitUnavailable" };
      }
      if (typeof e.stderr === "string" && /not a git repository/i.test(e.stderr)) {
        return { ok: false, state: "notRepository" };
      }
      if (e.code === "128" && typeof e.message === "string" && /not a git repository/i.test(e.message)) {
        return { ok: false, state: "notRepository" };
      }
      return { ok: false, state: "error", error: e.stderr?.trim() || e.message || "git status 执行失败" };
    }
  });
  ipcMain.handle("app:openExternal", async (_e, url) => {
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      return { ok: false, error: "仅允许 https 链接：已拒绝非 https 的外部打开请求" };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle("app:openPath", async (_e, dir) => {
    if (typeof dir !== "string" || !dir.trim()) {
      return { ok: false, error: "路径为空：请先选择工作区" };
    }
    const err2 = shell.openPath(dir);
    return err2 ? { ok: false, error: `无法打开目录 ${dir}：${err2}` } : { ok: true };
  });
  ipcMain.handle("app:openInEditor", async (_e, target) => {
    let editor = "";
    try {
      const settings2 = await getSettingsStore();
      if (typeof settings2.desktopEditor === "string") editor = settings2.desktopEditor.trim();
    } catch {
    }
    if (!editor) editor = (process.env.KHY_EDITOR || "").trim();
    if (!editor) {
      return {
        ok: false,
        error: "未配置编辑器：请在「设置 → 常规」填写编辑器命令，或设置 KHY_EDITOR 环境变量（例如 code），然后重试"
      };
    }
    const dir = typeof target === "string" && target.trim() ? target.trim() : await getWorkspaceRoot();
    return new Promise((resolve) => {
      try {
        const child = execFile(editor, [dir], { windowsHide: true }, (err2) => {
          if (err2) resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${err2.message}` });
        });
        child.unref();
        setTimeout(() => resolve({ ok: true, editor, target: dir }), 600);
      } catch (err2) {
        resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${String(err2?.message || err2)}` });
      }
    });
  });
  ipcMain.handle("app:processInfo", async () => {
    const mem = process.memoryUsage();
    return {
      ok: true,
      main: { pid: process.pid, rssBytes: mem.rss, uptimeMs: Math.round(process.uptime() * 1e3) },
      host: { pid: hostProcess?.pid ?? null, alive: Boolean(hostProcess?.connected) },
      scheduler: { pid: schedulerProcess?.pid ?? null, alive: Boolean(schedulerProcess?.connected) },
      rendererCount: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
      platform: `${os.platform()} ${os.release()}`,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }
    };
  });
  ipcMain.handle("app:brandingLinks", async () => {
    try {
      const root = process.env.KHY_OS_DIR ? path$1.resolve(process.env.KHY_OS_DIR) : path$1.resolve(__dirname, "..", "..", "..");
      const sd = nodeRequire(path$1.join(root, "services", "backend", "src", "constants", "serviceDefaults.js"));
      const host = sd.CLOUD_DEFAULT_HOST || "";
      return {
        ok: true,
        cloudHost: host,
        feedback: host ? `https://${host}/feedback` : "",
        docs: host ? `https://${host}/docs` : "",
        community: host ? `https://${host}/community` : "",
        issues: host ? `https://${host}/issues` : ""
      };
    } catch (err2) {
      return { ok: false, error: `品牌链接真源不可用：${String(err2?.message || err2)}` };
    }
  });
  ipcMain.handle("ai:controlResponse", (_e, payload) => {
    const id = payload?.id;
    const requestId = payload?.requestId;
    if (typeof id !== "string" || !id || typeof requestId !== "string" || !requestId) {
      return { ok: false, error: "应答缺少 id 或 requestId：请重试" };
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: "host 进程未启动：请重启 KhyOS Desktop 后重试" };
    }
    hostProcess.send({ type: "ai.controlResponse", id, requestId, response: payload?.response });
    return { ok: true };
  });
  ipcMain.handle("ai:abort", async (e) => {
    let aborted = 0;
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    for (const [id, entry] of pendingAi) {
      if (entry.win === senderWin) {
        pendingAi.delete(id);
        if (hostProcess && hostProcess.connected) {
          try {
            hostProcess.send({ type: "ai.abort", id });
          } catch {
          }
        }
        entry.resolve({ ok: false, error: "已停止：本轮工具执行已请求中断，已产生的中间结果将被丢弃" });
        aborted++;
      }
    }
    return { ok: true, aborted };
  });
  return win;
}
app.whenReady().then(() => {
  registerKeyManagerIpc(ipcMain);
  if (KEY_MANAGER_STANDALONE) {
    openKeyManagerWindow({ standalone: true });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openKeyManagerWindow({ standalone: true });
    });
    return;
  }
  startHostProcess();
  startSchedulerProcess();
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
  Menu.setApplicationMenu(null);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    settleAutomationRunsOnQuit();
    app.quit();
  }
});
app.on("will-quit", () => {
  settleAutomationRunsOnQuit();
  try {
    schedulerProcess?.send?.({ type: "shutdown" });
  } catch {
  }
});
