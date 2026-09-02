'use strict';

/**
 * ccSwitch REST handlers — HTTP surface for the CC-Switch provider-card store.
 *
 * Served under /api/cc-switch by the AI-management daemon (and optionally the
 * monolith server). Every endpoint is authenticated; none of them expose raw
 * API keys (only keyId presence + masked forms). Fail-soft JSON responses.
 */

const { APPS, APP_LABELS, PROTOCOLS } = require('./constants');
const store = require('./store');

// ── HTTP deps injected by the host (sendJson / parseBody / authenticate) ──
let sendJson = null;
let sendError = null;
let parseBody = null;
let authenticateRequest = null;
function setCcSwitchHttpDeps(deps = {}) {
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
  if (typeof deps.sendError === 'function') sendError = deps.sendError;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
}

async function _resolveAuth(req, res) {
  const auth = req.authContext || (authenticateRequest ? await authenticateRequest(req) : null);
  if (!auth || !auth.ok) {
    sendJson(res, 401, {
      success: false,
      message: (auth && auth.error) || 'Authentication required',
    });
    return null;
  }
  return auth;
}

// GET /api/cc-switch/cards
async function handleListCards(req, res) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  const cards = store.listCards().map((c) => ({
    id: c.id,
    name: c.name,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    wireApi: c.wireApi,
    models: c.models,
    defaultModel: c.defaultModel,
    apps: c.apps,
    enabled: c.enabled,
    hasKey: !!c.keyId,
    requiresOpenaiAuth: c.requiresOpenaiAuth,
  }));
  sendJson(res, 200, { success: true, data: cards });
}

// POST /api/cc-switch/cards  { name, baseUrl, key?, protocol?, ... }
async function handleCreateCard(req, res) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return sendError(res, 400, '请求体无效');
  }
  const result = store.addCard({
    name: body && body.name,
    baseUrl: body && body.baseUrl,
    key: body && body.key ? String(body.key) : undefined,
    protocol: (body && body.protocol) || PROTOCOLS.OPENAI,
    wireApi: body && body.wireApi,
    models: Array.isArray(body && body.models) ? body.models : [],
    defaultModel: (body && body.defaultModel) || '',
    apps: Array.isArray(body && body.apps) ? body.apps : undefined,
    requiresOpenaiAuth: !!(body && body.requiresOpenaiAuth),
  });
  if (!result.success) {
    return sendError(res, 400, result.error);
  }
  sendJson(res, 200, { success: true, data: { id: result.card.id, name: result.card.name } });
}

// PUT /api/cc-switch/cards/:id
async function handleUpdateCard(req, res, pathname) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  const cardId = _extractId(pathname, '/cards/');
  if (!cardId) {
    return sendError(res, 400, '缺少卡片 ID');
  }
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return sendError(res, 400, '请求体无效');
  }
  const patch = {};
  if (body && body.name !== undefined) patch.name = body.name;
  if (body && body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
  if (body && body.protocol !== undefined) patch.protocol = body.protocol;
  if (body && body.wireApi !== undefined) patch.wireApi = body.wireApi;
  if (body && body.defaultModel !== undefined) patch.defaultModel = body.defaultModel;
  if (Array.isArray(body && body.models)) patch.models = body.models;
  if (Array.isArray(body && body.apps)) patch.apps = body.apps;
  if (body && body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body && body.requiresOpenaiAuth !== undefined) patch.requiresOpenaiAuth = !!body.requiresOpenaiAuth;
  if (body && body.key) patch.key = String(body.key);

  const result = store.updateCard(cardId, patch);
  if (!result.success) {
    return sendError(res, 400, result.error);
  }
  sendJson(res, 200, { success: true, data: { id: result.card.id } });
}

// DELETE /api/cc-switch/cards/:id
async function handleDeleteCard(req, res, pathname) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  const cardId = _extractId(pathname, '/cards/');
  if (!cardId) {
    return sendError(res, 400, '缺少卡片 ID');
  }
  const result = store.removeCard(cardId);
  if (!result.success) {
    return sendError(res, 400, result.error);
  }
  sendJson(res, 200, { success: true });
}

// GET /api/cc-switch/status — per-app active card + scan config
async function handleStatus(req, res) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  const cards = store.listCards();
  const apps = Object.values(APPS).map((app) => {
    const activeId = store.getActiveCardId(app);
    const active = activeId ? cards.find((c) => c.id === activeId) : null;
    return {
      app,
      label: APP_LABELS[app] || app,
      activeCardId: activeId || null,
      activeCardName: active ? active.name : null,
      scanEnabled: store.getAppConfig(app).scanEnabled,
    };
  });
  sendJson(res, 200, { success: true, data: apps });
}

// POST /api/cc-switch/use  { cardId, app }  — switch an app onto a card
async function handleUseCard(req, res) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return sendError(res, 400, '请求体无效');
  }
  const cardId = body && body.cardId;
  const app = body && body.app;
  if (!cardId || !app) {
    return sendError(res, 400, 'cardId 与 app 均为必填');
  }
  const card = store.getCard(cardId);
  if (!card) {
    return sendError(res, 404, `卡片不存在: ${cardId}`);
  }
  const { applyCardToApp, preflightCardForApp } = require('./appWriters');
  const pre = preflightCardForApp(card, app);
  if (!pre.ok) {
    return sendError(res, 400, pre.reason);
  }
  const result = await applyCardToApp(card, app, { store });
  if (!result.success) {
    return sendError(res, 500, `${APP_LABELS[app] || app} 切换失败: ${result.error}`);
  }
  store.setActiveCard(app, cardId);
  sendJson(res, 200, { success: true, data: { app, cardId, cardName: card.name } });
}

// POST /api/cc-switch/scan  { apps? }  — trigger an incremental usage scan
async function handleScan(req, res) {
  const auth = await _resolveAuth(req, res);
  if (!auth) return;
  let apps = null;
  try {
    const body = await parseBody(req);
    apps = Array.isArray(body && body.apps) && body.apps.length ? body.apps : null;
  } catch {
    /* body optional */
  }
  const { scanSessions } = require('./usageScan');
  try {
    const result = await scanSessions(apps ? { apps } : {});
    sendJson(res, 200, { success: true, data: result });
  } catch (e) {
    sendError(res, 500, `扫描失败: ${(e && e.message) || e}`);
  }
}

function _extractId(pathname, prefix) {
  const idx = pathname.indexOf(prefix);
  if (idx === -1) {
    return null;
  }
  const rest = pathname.slice(idx + prefix.length).split('/')[0];
  return rest || null;
}

/**
 * Route dispatcher for /api/cc-switch/*
 * @returns {Promise<void>}
 */
async function handleCcSwitchApi(req, res, pathname) {
  try {
    if (pathname === '/api/cc-switch/cards' && req.method === 'GET') {
      return await handleListCards(req, res);
    }
    if (pathname === '/api/cc-switch/cards' && req.method === 'POST') {
      return await handleCreateCard(req, res);
    }
    if (pathname.startsWith('/api/cc-switch/cards/') && req.method === 'PUT') {
      return await handleUpdateCard(req, res, pathname);
    }
    if (pathname.startsWith('/api/cc-switch/cards/') && req.method === 'DELETE') {
      return await handleDeleteCard(req, res, pathname);
    }
    if (pathname === '/api/cc-switch/status' && req.method === 'GET') {
      return await handleStatus(req, res);
    }
    if (pathname === '/api/cc-switch/use' && req.method === 'POST') {
      return await handleUseCard(req, res);
    }
    if (pathname === '/api/cc-switch/scan' && req.method === 'POST') {
      return await handleScan(req, res);
    }
    return sendError(res, 404, `未知的 cc-switch 端点: ${pathname}`);
  } catch (e) {
    return sendError(res, 500, `cc-switch API 错误: ${(e && e.message) || e}`);
  }
}

module.exports = {
  setCcSwitchHttpDeps,
  handleCcSwitchApi,
  __test__: { _extractId },
};
