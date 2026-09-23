import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
const nodeRequire = createRequire(import.meta.url);
function resolveKhyOsDir() {
  if (process.env.KHY_OS_DIR) return path.resolve(process.env.KHY_OS_DIR);
  return path.resolve(process.cwd(), "..", "..");
}
function loadGatewayEnvFile() {
  const envPath = path.join(resolveKhyOsDir(), "services", "backend", ".env");
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    console.log("[host] 无网关 .env（", envPath, "），AI 通道未配置时将返回引导错误");
    return;
  }
  let loaded = 0;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded++;
    }
  }
  console.log("[host] 已加载网关 .env（新注入", loaded, "项，不覆盖已有环境）");
}
let aiChat = null;
let toolLoop = null;
function loadAiChat() {
  if (aiChat) return aiChat;
  const chatPath = path.join(resolveKhyOsDir(), "services", "backend", "src", "cli", "ai.js");
  aiChat = nodeRequire(chatPath).chat;
  return aiChat;
}
function loadToolLoop() {
  if (toolLoop) return toolLoop;
  const loopPath = path.join(resolveKhyOsDir(), "services", "backend", "src", "services", "toolUseLoop.js");
  toolLoop = nodeRequire(loopPath);
  return toolLoop;
}
let sessionPersistence = null;
function loadSessionPersistence() {
  if (sessionPersistence) return sessionPersistence;
  const spPath = path.join(resolveKhyOsDir(), "services", "backend", "src", "services", "sessionPersistence.js");
  sessionPersistence = nodeRequire(spPath);
  console.log("[host] sessionPersistence 已加载:", spPath);
  return sessionPersistence;
}
let tokenUsageService = null;
function loadTokenUsageService() {
  if (tokenUsageService) return tokenUsageService;
  const tuPath = path.join(resolveKhyOsDir(), "services", "backend", "src", "services", "tokenUsageService.js");
  tokenUsageService = nodeRequire(tuPath);
  console.log("[host] tokenUsageService 已加载:", tuPath);
  return tokenUsageService;
}
function contextWindowLimit() {
  const envVal = Number(process.env.KHY_CONTEXT_WINDOW);
  if (Number.isFinite(envVal) && envVal > 0) return Math.floor(envVal);
  return 128e3;
}
let providerPresets = null;
function loadProviderPresets() {
  if (providerPresets) return providerPresets;
  const ppPath = path.join(resolveKhyOsDir(), "services", "backend", "src", "services", "gateway", "providerPresets.js");
  providerPresets = nodeRequire(ppPath);
  console.log("[host] providerPresets 已加载:", ppPath);
  return providerPresets;
}
async function listModelOptions(adapterKey) {
  const pp = loadProviderPresets();
  const presets = pp.getProviderPresets();
  let poolKeyByPreset = {};
  try {
    const bpc = nodeRequire(path.join(resolveKhyOsDir(), "services", "backend", "src", "services", "gateway", "builtinProviderConfig.js"));
    const builtins = (bpc.BUILTIN_PROVIDERS || bpc.builtinProviders || []).filter(Boolean);
    const norm = (s) => String(s || "").replace(/[\s（）()·\/]/g, "").toLowerCase();
    for (const b of builtins) {
      if (!b.poolKey) continue;
      const bName = norm(b.name || "");
      for (const p of presets) {
        const pLabel = norm(p.label || p.name || p.id);
        if (pLabel && bName && (pLabel === bName || pLabel.includes(bName) || bName.includes(pLabel))) {
          poolKeyByPreset[p.id] = b.poolKey;
        }
      }
      if (presets.some((p) => p.id === b.poolKey)) {
        poolKeyByPreset[b.poolKey] = b.poolKey;
      }
    }
    console.log("[host] poolKey 映射（preset→通道）:", JSON.stringify(poolKeyByPreset));
  } catch {
  }
  const out = [];
  for (const p of presets) {
    const label = p.label || p.name || p.id;
    const mapped = poolKeyByPreset[p.id];
    const channelId = mapped || p.id;
    const channelKnown = Boolean(mapped);
    const defaultModel = typeof p.defaultModel === "string" && p.defaultModel ? p.defaultModel : "";
    out.push({
      id: p.id,
      channel: channelId,
      channelKnown,
      label: defaultModel ? `${label} · ${defaultModel}` : label,
      format: p.apiFormat || p.format || "openai"
    });
    if (Array.isArray(p.models) && p.models.length > 0) {
      for (const m of p.models) {
        const mid = typeof m === "string" ? m : String(m.id || m);
        out.push({
          id: `${p.id}/${mid}`,
          channel: channelId,
          channelKnown,
          label: mid,
          format: p.apiFormat || p.format || "openai"
        });
      }
    }
  }
  return out;
}
const activeGenerations = /* @__PURE__ */ new Map();
const activeAborts = /* @__PURE__ */ new Map();
const pendingToolCalls = /* @__PURE__ */ new Map();
let toolCallSeq = 0;
function registerToolCall(generationId, toolName) {
  const callId = `tc_${++toolCallSeq}`;
  const key = `${generationId}\0${toolName}`;
  const queue = pendingToolCalls.get(key);
  if (queue) queue.push(callId);
  else pendingToolCalls.set(key, [callId]);
  return callId;
}
function settleToolCall(generationId, toolName) {
  const key = `${generationId}\0${toolName}`;
  const queue = pendingToolCalls.get(key);
  if (!queue || queue.length === 0) return null;
  const callId = queue.shift();
  if (queue.length === 0) pendingToolCalls.delete(key);
  return callId;
}
function clearToolCallQueue(generationId) {
  const prefix = `${generationId}\0`;
  for (const key of Array.from(pendingToolCalls.keys())) {
    if (key.startsWith(prefix)) pendingToolCalls.delete(key);
  }
}
const pendingControls = /* @__PURE__ */ new Map();
const CONTROL_RESPONSE_TIMEOUT_MS = 3e5;
function settleControl(generationId, requestId, response) {
  const key = `${generationId}\0${requestId}`;
  const entry = pendingControls.get(key);
  if (!entry) return false;
  pendingControls.delete(key);
  clearTimeout(entry.timer);
  entry.resolve(response);
  return true;
}
function failAllControls(generationId) {
  const prefix = `${generationId}\0`;
  for (const key of Array.from(pendingControls.keys())) {
    if (!key.startsWith(prefix)) continue;
    const entry = pendingControls.get(key);
    if (!entry) continue;
    pendingControls.delete(key);
    clearTimeout(entry.timer);
    entry.resolve({ behavior: "deny" });
  }
}
const EDITING_TOOL_NAMES = /* @__PURE__ */ new Set(["edit", "write", "multiedit", "applypatch", "notebookedit"]);
function affectedFilesOf(toolName, params) {
  if (!EDITING_TOOL_NAMES.has(String(toolName).toLowerCase())) return [];
  const p = params && typeof params === "object" ? params : {};
  const raw = p.file_path || p.filePath || p.path || p.notebook_path || "";
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? [s] : [];
}
async function handleAiGenerate(id, prompt, options = {}) {
  const send = (msg) => {
    if (process.send) process.send(msg);
    else console.log("[host]", JSON.stringify(msg));
  };
  activeGenerations.set(id, Date.now());
  const controller = new AbortController();
  activeAborts.set(id, controller);
  try {
    loadGatewayEnvFile();
    const chat = loadAiChat();
    const loop = loadToolLoop();
    const cwd = typeof options.cwd === "string" && options.cwd.trim() ? options.cwd.trim() : process.cwd();
    const costSink = {};
    const result = await loop.runToolUseLoop(prompt, {
      chat,
      chatOpts: {
        cwd,
        effort: options.effort,
        preferredAdapter: options.preferredAdapter,
        preferredModel: options.preferredModel,
        images: options.images,
        onChunk: (chunk) => send({ type: "ai.chunk", id, chunk })
      },
      abortSignal: controller.signal,
      onCost: (usage) => {
        costSink.usage = usage;
      },
      onToolCall: (name, params) => send({ type: "ai.toolCall", id, callId: registerToolCall(id, name), tool: name, input: params || {} }),
      onToolResult: (name, params, toolResult, iteration, elapsed) => send({
        type: "ai.toolResult",
        id,
        callId: settleToolCall(id, name),
        tool: name,
        input: params || {},
        result: toolResult,
        iteration,
        elapsed,
        affectedFiles: affectedFilesOf(name, params)
      }),
      // 人在环（P1）：审批 / 提问。同一通道承载多条产生路径（guardApproval 的软守卫审批、
      // Stage 7 requestPermission、shell 命令审批、AskUserQuestion），request 统一为
      // { subtype:'can_use_tool', tool_name, input }，响应按 { behavior } 三态解码
      // （toolCallingPermissions._decisionFromControl：allow / allow-always / 其它=deny）。
      // 5 分钟未响应 → 显式 deny（fail-closed），不挂死循环、绝不默认放行。
      onControlRequest: ({ requestId, request }) => {
        const key = `${id}\0${requestId}`;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (pendingControls.delete(key)) {
              resolve({ behavior: "deny" });
            }
          }, CONTROL_RESPONSE_TIMEOUT_MS);
          pendingControls.set(key, { resolve, timer });
          send({ type: "ai.controlRequest", id, requestId, request });
        });
      }
    });
    const replyText = String(result && result.finalResponse || "");
    const toolCallLog = Array.isArray(result == null ? void 0 : result.toolCallLog) ? result.toolCallLog : [];
    const okFlag = !!replyText || toolCallLog.length > 0;
    send({
      type: "ai.result",
      id,
      ok: okFlag,
      text: replyText,
      empty: !replyText && toolCallLog.length === 0,
      provider: result == null ? void 0 : result.provider,
      iterations: result == null ? void 0 : result.iterations,
      toolCallCount: toolCallLog.length,
      tokenUsage: costSink.usage
    });
  } catch (error) {
    send({
      type: "ai.result",
      id,
      ok: false,
      error: `AI 调用失败：${String((error == null ? void 0 : error.message) || error)}，请运行 khy gateway status 检查通道配置`
    });
  } finally {
    clearToolCallQueue(id);
    failAllControls(id);
    activeAborts.delete(id);
    activeGenerations.delete(id);
  }
}
function backgroundTaskStatus() {
  const taskIds = Array.from(activeGenerations.keys());
  const subagents = taskIds.filter((tid) => tid.startsWith("auto_")).length;
  const bash = 0;
  return { count: taskIds.length, bash, subagents, taskIds };
}
function desktopGateState() {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || "").trim().toLowerCase();
  let mode = "off";
  if (raw === "1" || raw === "on" || raw === "true" || raw === "yes") mode = "on";
  else if (raw === "ask") mode = "ask";
  else if (raw === "strict") mode = "strict";
  const budgetRaw = String(process.env.KHY_DESKTOP_MAX_ACTUATIONS || "").trim();
  return {
    mode,
    budget: /^\d+$/.test(budgetRaw) && Number(budgetRaw) > 0 ? budgetRaw : null,
    allowedApps: String(process.env.KHY_COMPUTER_USE_ALLOWED_APPS || "").trim()
  };
}
function handleMessage(msg) {
  var _a;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") {
    if (process.send) process.send({ type: "ready", pid: process.pid });
    return;
  }
  if (msg.type === "ai.generate" && msg.id && typeof msg.prompt === "string") {
    void handleAiGenerate(msg.id, msg.prompt, msg.options);
    return;
  }
  if (msg.type === "ai.abort" && msg.id) {
    const controller = activeAborts.get(msg.id);
    if (controller) {
      try {
        controller.abort("aborted by host caller");
      } catch {
      }
    }
    return;
  }
  if (msg.type === "ai.controlResponse" && msg.id && typeof msg.requestId === "string") {
    settleControl(msg.id, msg.requestId, msg.response);
    return;
  }
  if (msg.type === "session.list" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    const limit = typeof msg.limit === "number" && msg.limit > 0 ? Math.min(msg.limit, 500) : 50;
    try {
      const sp = loadSessionPersistence();
      const sessions = sp.listPersistedSessions({ limit });
      console.log("[host] session.listResult: ", sessions.length, "sessions");
      send({ type: "session.listResult", id: msg.id, ok: true, sessions });
    } catch (error) {
      send({
        type: "session.listResult",
        id: msg.id,
        ok: false,
        error: `读取本地会话列表失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    }
    return;
  }
  if (msg.type === "session.create" && msg.id && typeof msg.cwd === "string") {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    try {
      const sp = loadSessionPersistence();
      const sessionId = sp.persistSession(void 0, {
        messages: [],
        metadata: { cwd: msg.cwd, projectDir: msg.cwd },
        title: ""
      });
      console.log("[host] session.createResult:", sessionId);
      send({ type: "session.createResult", id: msg.id, ok: true, sessionId });
    } catch (error) {
      send({
        type: "session.createResult",
        id: msg.id,
        ok: false,
        error: `创建会话失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    }
    return;
  }
  if (msg.type === "session.messages" && msg.id && typeof msg.sessionId === "string") {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    try {
      const sp = loadSessionPersistence();
      const restored = sp.restoreSession(msg.sessionId);
      const messages = (restored.messages || []).map((m) => ({
        role: m.role === "assistant" || m.role === "system" ? m.role : "user",
        // content may be a string, a content-part array, or an object — flatten
        // to the display text the bubble renders (same normalization as
        // listPersistedSessions' firstUserMessage).
        content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p && typeof p === "object" ? String(p.text || "") : String(p || "")).join(" ") : m.content && typeof m.content === "object" ? String(m.content.text || "") : "",
        timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now()
      }));
      console.log("[host] session.messagesResult:", msg.sessionId, messages.length, "messages");
      let jsonlPath = "";
      try {
        jsonlPath = ((_a = sp.jsonlPathFor) == null ? void 0 : _a.call(sp, msg.sessionId)) || "";
      } catch {
        jsonlPath = "";
      }
      send({
        type: "session.messagesResult",
        id: msg.id,
        ok: true,
        sessionId: restored.sessionId || msg.sessionId,
        title: restored.title || "",
        model: restored.model || "",
        messages,
        jsonlPath
      });
    } catch (error) {
      send({
        type: "session.messagesResult",
        id: msg.id,
        ok: false,
        messages: [],
        error: `读取会话内容失败：${String((error == null ? void 0 : error.message) || error)}，请确认该会话仍存在于 .khy/sessions 后重试`
      });
    }
    return;
  }
  if (msg.type === "token.usage" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    try {
      const tu = loadTokenUsageService();
      const usage = {
        today: tu.getTodayUsage(),
        month: tu.getMonthUsage(),
        session: tu.getSessionUsage(),
        quota: tu.getRemainingQuota()
      };
      console.log("[host] token.usageResult: month.totalTokens=", usage.month.totalTokens);
      send({ type: "token.usageResult", id: msg.id, ok: true, usage });
    } catch (error) {
      send({
        type: "token.usageResult",
        id: msg.id,
        ok: false,
        error: `读取 Token 用量统计失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    }
    return;
  }
  if (msg.type === "usage.history" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    const days = typeof msg.days === "number" && msg.days > 0 ? Math.min(Math.floor(msg.days), 90) : 30;
    try {
      const tu = loadTokenUsageService();
      const history = tu.getUsageHistory(days);
      const models = tu.getModelUsage();
      console.log("[host] usage.historyResult: days=", days, "| history=", history.length, "| models=", models.length);
      send({ type: "usage.historyResult", id: msg.id, ok: true, history, models });
    } catch (error) {
      send({
        type: "usage.historyResult",
        id: msg.id,
        ok: false,
        error: `读取用量历史失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    }
    return;
  }
  if (msg.type === "context.size" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    typeof msg.contentChars === "number" ? msg.contentChars : 0;
    const text = String(msg.text ?? "").slice(0, 4e5);
    try {
      const tu = loadTokenUsageService();
      const estimate = tu.estimateTokens(text);
      send({
        type: "context.sizeResult",
        id: msg.id,
        ok: true,
        estimate: { used: estimate, total: contextWindowLimit() }
      });
    } catch (error) {
      send({
        type: "context.sizeResult",
        id: msg.id,
        ok: false,
        error: `估算上下文 token 数失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    }
    return;
  }
  if (msg.type === "models.list" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    typeof msg.adapterKey === "string" ? msg.adapterKey : void 0;
    listModelOptions().then((models) => {
      console.log("[host] models.listResult:", models.length, "options");
      send({ type: "models.listResult", id: msg.id, ok: true, models });
    }).catch((error) => {
      send({
        type: "models.listResult",
        id: msg.id,
        ok: false,
        error: `读取模型列表失败：${String((error == null ? void 0 : error.message) || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      });
    });
    return;
  }
  if (msg.type === "background.status" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    const status = backgroundTaskStatus();
    send({ type: "background.statusResult", id: msg.id, ok: true, status });
    return;
  }
  if (msg.type === "desktopGate.set" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    const mode = typeof msg.mode === "string" ? msg.mode.trim().toLowerCase() : "";
    if (["off", "ask", "on", "strict"].includes(mode)) process.env.KHY_DESKTOP_CONTROL = mode;
    const budget = typeof msg.budget === "string" ? msg.budget.trim() : "";
    if (/^\d+$/.test(budget) && Number(budget) > 0) process.env.KHY_DESKTOP_MAX_ACTUATIONS = budget;
    if (typeof msg.allowedApps === "string") {
      if (msg.allowedApps.trim()) process.env.KHY_COMPUTER_USE_ALLOWED_APPS = msg.allowedApps.trim();
      else delete process.env.KHY_COMPUTER_USE_ALLOWED_APPS;
    }
    console.log("[host] desktopGate.set:", JSON.stringify(desktopGateState()));
    send({ type: "desktopGate.setResult", id: msg.id, ok: true, gate: desktopGateState() });
    return;
  }
  if (msg.type === "desktopGate.get" && msg.id) {
    const send = (m) => {
      if (process.send) process.send(m);
      else console.log("[host]", JSON.stringify(m));
    };
    send({ type: "desktopGate.getResult", id: msg.id, ok: true, gate: desktopGateState() });
    return;
  }
}
process.on("message", handleMessage);
process.stdin.on("data", (data) => {
  for (const line of data.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
    }
  }
});
console.log("[host] 进程启动, pid:", process.pid);
if (process.send) process.send({ type: "ready", pid: process.pid });
