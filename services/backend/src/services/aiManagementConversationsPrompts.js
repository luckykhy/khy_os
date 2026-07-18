'use strict';

/**
 * aiManagementServer 的「已认证的每用户 REST 处理器」子系统(从上帝文件抽出)。
 *
 * 承载三簇 HTTP 处理器,均按 user_id 归属、经 routeRequest 分派:
 *  - 每用户 AI 对话历史(ai_conversations 行·AIChat.vue 侧栏):list/create/get/update/delete
 *    + resolveAuthUserId(私有)+ handleAiContextStats(上下文用量)。
 *  - Prompt 库:内置/自建 prompt 的增删改查 + use/approve + maybeAutoCapturePrompt(聊天处理器
 *    在宿主侧回调采集)。
 *  - 用量/工具/安全:handleGetUsage/handleGetUsageHistory/handleListTools/handleExecuteTool/
 *    handleSecurityStats(无模块态·仅经注入的 getTokenUsage/getSecurity/getToolCalling 读)。
 *
 * **全部可变态私有于本叶子**:_conversationStore / _promptStore / _promptTemplateCatalog
 * (三个懒加载单例·随簇迁入)——宿主不触碰,故可无环抽出。
 *
 * **反向边经依赖注入打破**:处理器体调宿主的 sendJson / sendError / parseBody(无态响应工具)、
 * authenticateRequest(§5·态在宿主 DB)、getSecurity / getTokenUsage / getToolCalling(§2 懒加载
 * 单例 getter·态留宿主)。宿主加载时调一次 setConversationsPromptsDeps 注入;被迁函数体仍按
 * **同名**引用,故字节不变。
 *
 * **刻意非纯零 IO 叶子**:懒加载 conversationStore / promptStore / promptTemplateCatalog /
 * webContextStats / promptAutoCapture / toolCalling;读 DB。放置为 aiManagementServer.js 的
 * **同目录兄弟**以保懒 require 相对路径字节不变。宿主 routeRequest / handleAiGatewayNamespace /
 * 聊天处理器按**同名 re-import** 接回,调用点字节不变。
 */

// 宿主注入的反向边(响应工具 + 认证 + 懒加载单例 getter),加载时由 setConversationsPromptsDeps 注入一次。
let sendJson = null;
let sendError = null;
let parseBody = null;
let authenticateRequest = null;
let getSecurity = null;
let getTokenUsage = null;
let getToolCalling = null;
function setConversationsPromptsDeps(deps = {}) {
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
  if (typeof deps.sendError === 'function') sendError = deps.sendError;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
  if (typeof deps.getSecurity === 'function') getSecurity = deps.getSecurity;
  if (typeof deps.getTokenUsage === 'function') getTokenUsage = deps.getTokenUsage;
  if (typeof deps.getToolCalling === 'function') getToolCalling = deps.getToolCalling;
}

// ── Per-user AI chat conversations (backend-persisted sidebar history) ───────
// Distinct from the CLI single-conversation file store above (/api/conversations,
// global CONVO_DIR): these are multi-conversation rows in ai_conversations scoped
// by user_id, backing the AIChat.vue history sidebar. Lazy-required so model/DB
// bootstrap only happens on first use (matches the daemon's boot-order idiom).
let _conversationStore = null;
function getConversationStore() {
  if (!_conversationStore) _conversationStore = require('./conversationStore');
  return _conversationStore;
}

// Resolve the authenticated user's id (0 for the local-owner bypass modes).
// Sends a 401 envelope and returns null when auth fails; legitimate id 0 passes.
async function resolveAuthUserId(req, res) {
  const auth = req.authContext || await authenticateRequest(req);
  if (!auth || !auth.ok) {
    sendJson(res, 401, { success: false, message: (auth && auth.error) || 'Authentication required' });
    return null;
  }
  return auth.user?.id ?? 0;
}

async function handleListAiConversations(req, res, query) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    // Optional ?projectId=<id> filters the sidebar to one coding project; absent
    // → full list (unchanged behavior). Store treats blank/invalid as null.
    const projectId = query && query.projectId;
    const data = await getConversationStore().list(userId, { projectId });
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to list conversations');
  }
}

async function handleCreateAiConversation(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getConversationStore().create(userId, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to create conversation');
  }
}

async function handleGetAiConversation(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getConversationStore().get(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to load conversation');
  }
}

async function handleUpdateAiConversation(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getConversationStore().update(userId, id, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to update conversation');
  }
}

async function handleDeleteAiConversation(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getConversationStore().remove(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to delete conversation');
  }
}

// ── Context-usage stats for the web chat (AIChat.vue indicator) ─────────────
// Stateless compute: the client POSTs its live transcript; we reuse the CC
// context-visualization backend leaves (webContextStats → messageBreakdown +
// contextSuggestions) to return per-category breakdown, percentage full,
// remaining tokens, per-tool accounting and actionable optimization hints.
// Reflects the CURRENT unsaved transcript (not the last-persisted row), which
// is what a "context is N% full" indicator must show. Read-only, no DB write.
async function handleAiContextStats(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const messages = Array.isArray(body && body.messages) ? body.messages : [];
    const contextWindow = body && body.contextWindow;
    const isAutoCompactEnabled =
      body && typeof body.isAutoCompactEnabled === 'boolean' ? body.isAutoCompactEnabled : undefined;

    const { analyzeWebContextStats } = require('./context/webContextStats');
    const { estimateTokens } = require('../services/textHeuristics');

    // System tools schema JSON = the tool-definition overhead the model is sent.
    let toolDefsJson;
    try {
      const { getToolDefinitions } = require('../services/toolCalling');
      const defs = getToolDefinitions();
      if (Array.isArray(defs) && defs.length > 0) toolDefsJson = JSON.stringify(defs);
    } catch { /* registry unavailable → System tools category simply omitted */ }

    const stats = analyzeWebContextStats(
      { messages, contextWindow, toolDefsJson, estimateTokens, isAutoCompactEnabled },
      process.env,
    );

    // Gate off (null) → honest empty envelope so the frontend hides the indicator.
    sendJson(res, 200, { success: true, data: stats || null });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to compute context stats');
  }
}

// ── Prompt library (per-user prompt templates) ──────────────────────────────
// Backs /api/ai/prompts: the user's saved prompts (manual + AI-discovered
// pending-review). Lazy-required so model/DB bootstrap only happens on first use.
let _promptStore = null;
function getPromptStore() {
  if (!_promptStore) _promptStore = require('./promptStore');
  return _promptStore;
}

// Built-in multi-angle prompt template catalog (source of truth: promptTemplateCatalog.js,
// a pure leaf). Read-only and identical for everyone, so no auth: an empty/new account still
// sees starter templates on the chat empty-state. Gate off (KHY_PROMPT_TEMPLATE_CATALOG=0) or
// any exception → empty catalog, never a 500; the frontend has a local fallback so it never
// renders blank either way.
let _promptTemplateCatalog = null;
function getPromptTemplateCatalog() {
  if (!_promptTemplateCatalog) _promptTemplateCatalog = require('./promptTemplateCatalog');
  return _promptTemplateCatalog;
}

async function handleListBuiltinPrompts(req, res, query) {
  try {
    const catalog = getPromptTemplateCatalog();
    const category = query && query.category ? String(query.category) : '';
    const templates = catalog.listTemplates(category ? { category } : {});
    const categories = catalog.listCategories();
    sendJson(res, 200, { success: true, data: { templates, categories } });
  } catch {
    // Fail-soft: never 500 the chat empty-state over builtin templates.
    sendJson(res, 200, { success: true, data: { templates: [], categories: [] } });
  }
}

async function handleListPrompts(req, res, query) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const opts = {
      status: query && query.status,
      source: query && query.source,
      q: query && query.q,
    };
    const data = await getPromptStore().list(userId, opts);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to list prompts');
  }
}

async function handleCreatePrompt(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getPromptStore().create(userId, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to create prompt');
  }
}

async function handleGetPrompt(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getPromptStore().get(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to load prompt');
  }
}

async function handleUpdatePrompt(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getPromptStore().update(userId, id, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to update prompt');
  }
}

async function handleDeletePrompt(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getPromptStore().remove(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to delete prompt');
  }
}

async function handleUsePrompt(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getPromptStore().use(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to mark prompt used');
  }
}

async function handleApprovePrompt(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getPromptStore().approve(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to approve prompt');
  }
}

// Auto-capture hook: after a chat turn completes, judge whether the user's raw
// message is worth keeping as a reusable prompt and, if so, enqueue it into the
// per-user review queue (status:'pending'). Pure heuristic — no model call.
// Fully fail-soft: any error here must NEVER disturb the chat stream.
async function maybeAutoCapturePrompt(userId, rawMessage) {
  try {
    if (userId === null || userId === undefined) return;
    const autoCapture = require('./promptAutoCapture');
    if (!autoCapture.shouldCapture(rawMessage, process.env)) return;
    const store = getPromptStore();
    // Skip if this user already has an identical prompt (manual or pending).
    if (await store.existsByContent(userId, rawMessage)) return;
    await store.create(userId, {
      content: rawMessage,
      title: autoCapture.deriveTitle(rawMessage),
      source: 'ai_discovered',
      status: 'pending',
    });
  } catch {
    // Swallow — auto-capture is best-effort and must not affect chat delivery.
  }
}

async function handleGetUsage(req, res) {
  const tu = getTokenUsage();
  sendJson(res, 200, {
    success: true,
    data: {
      session: tu.getSessionUsage(),
      today: tu.getTodayUsage(),
      month: tu.getMonthUsage(),
      quota: tu.getRemainingQuota(),
      cost: tu.getSessionCost(),
    },
  });
}

async function handleGetUsageHistory(req, res, searchParams) {
  const days = parseInt(searchParams.get('days')) || 30;
  const history = getTokenUsage().getUsageHistory(days);
  sendJson(res, 200, { success: true, data: history });
}

async function handleListTools(req, res) {
  const tc = getToolCalling();
  sendJson(res, 200, {
    success: true,
    data: {
      tools: tc.listTools(),
      definitions: tc.getToolDefinitions(),
    },
  });
}

async function handleExecuteTool(req, res, toolName) {
  const body = await parseBody(req);
  const params = body.params || body;

  // Find the tool
  const tc = getToolCalling();
  const tool = tc.BUILTIN_TOOLS.find(t => t.name === toolName);
  if (!tool) return sendError(res, 404, `Tool not found: ${toolName}`);

  // Security check on params
  try {
    const check = getSecurity().analyzeInput(JSON.stringify(params));
    if (!check.safe) return sendError(res, 403, check.refusal);
  } catch { /* security failure should not block */ }

  // High-risk tools require explicit approval via web (return approval request)
  if (tool.risk !== 'safe' && !tc.isDangerousMode() && !tc.isApproved(toolName)) {
    return sendJson(res, 200, {
      success: false,
      requiresApproval: true,
      tool: { name: tool.name, risk: tool.risk, description: tool.description },
      message: `Tool "${toolName}" requires approval (risk: ${tool.risk})`,
    });
  }

  try {
    const result = await tool.handler(params);
    sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    sendError(res, 500, `Tool execution failed: ${err.message}`);
  }
}

async function handleSecurityStats(req, res) {
  const stats = getSecurity().getSecurityStats();
  sendJson(res, 200, { success: true, data: stats });
}

module.exports = {
  // Per-user AI conversations
  handleListAiConversations,
  handleCreateAiConversation,
  handleGetAiConversation,
  handleUpdateAiConversation,
  handleDeleteAiConversation,
  handleAiContextStats,
  // Prompt library
  handleListBuiltinPrompts,
  handleListPrompts,
  handleCreatePrompt,
  handleGetPrompt,
  handleUpdatePrompt,
  handleDeletePrompt,
  handleUsePrompt,
  handleApprovePrompt,
  maybeAutoCapturePrompt,
  // Usage / tools / security
  handleGetUsage,
  handleGetUsageHistory,
  handleListTools,
  handleExecuteTool,
  handleSecurityStats,
  // Internal (exported for tests)
  getConversationStore,
  getPromptStore,
  getPromptTemplateCatalog,
  resolveAuthUserId,
  // Dependency injection
  setConversationsPromptsDeps,
};
