'use strict';

/**
 * ccSwitch routeResolver — active-card routing for the local proxy.
 *
 * When an external tool (Claude Code / Codex / OpenCode / Gemini CLI) has an
 * ACTIVE card in the ccSwitch store, requests arriving at the proxy from that
 * tool should be routed to the card's upstream. This resolver rewrites the
 * model-router result to point at the card via the generic `api` adapter:
 *   adapterKey = 'api'
 *   apiPoolProvider = 'cc-switch:<cardId>'  (keys/endpoint live in apiKeyPool)
 *
 * Explicit adapter prefixes (`claude/...`, `trae/...`, route-map overrides) and
 * user-pinned channels ALWAYS take precedence over the active card — a card is
 * only a default, never a straitjacket.
 *
 * Pure resolver (zero IO except the store read, which is cached): returns the
 * rewritten route or null when no card applies.
 */

const { APPS, PROTOCOLS } = require('./constants');

/**
 * Map an inbound source protocol to the external app that produced it.
 * @param {string} sourceProtocol  one of PROTOCOLS.*
 * @returns {string[]} candidate APPS.* apps (may be several for shared wires)
 */
function appsForProtocol(sourceProtocol) {
  switch (sourceProtocol) {
    case PROTOCOLS.ANTHROPIC:
      // Anthropic wire: Claude Code (native) and Command Code BYOK
      // (anthropic-messages wire) both speak it.
      return [APPS.CLAUDE_CODE, APPS.COMMAND_CODE];
    case PROTOCOLS.CODEX:
      return [APPS.CODEX];
    case PROTOCOLS.OPENAI:
      // OpenAI wire: OpenCode, Command Code BYOK (openai-completions),
      // YCode (api connection) and generic OpenAI-compatible tools.
      return [APPS.OPENCODE, APPS.COMMAND_CODE, APPS.YCODE];
    case PROTOCOLS.GEMINI:
      return [APPS.GEMINI];
    default:
      return [];
  }
}

// Backward-compat single-app mapping (used by callers expecting one app id).
function appForProtocol(sourceProtocol) {
  const apps = appsForProtocol(sourceProtocol);
  return apps.length ? apps[0] : null;
}

/**
 * Decide whether the active card should override the resolved route.
 *
 * @param {object} route  result of modelRouter.resolveModelRoute
 * @param {object} ctx    { sourceProtocol, store }
 * @returns {object|null} rewritten route (adapterKey=api + pool hint) or null
 */
function resolveCardRoute(route, ctx = {}) {
  const store = ctx.store;
  if (!store || !route) {
    return null;
  }
  const sourceProtocol = ctx.sourceProtocol;
  const candidates = appsForProtocol(sourceProtocol);
  if (!candidates.length) {
    return null;
  }

  // 1. Explicit user pinning always wins over a card.
  const source = route.metadata && route.metadata.source;
  if (route.userPinned || route.strictPreferred === true || source === 'explicit' || source === 'route-map') {
    return null;
  }

  // 2. Find the FIRST candidate app that has an active, enabled card.
  let card = null;
  let cardApp = null;
  let cardId = null;
  for (const app of candidates) {
    try {
      const activeId = store.getActiveCardId(app);
      if (!activeId) {
        continue;
      }
      const activeCard = store.getCard(activeId);
      if (activeCard && activeCard.enabled) {
        card = activeCard;
        cardApp = app;
        cardId = activeId;
        break;
      }
    } catch {
      /* try next app */
    }
  }
  if (!card || !cardApp) {
    return null;
  }

  // 3. Protocol sanity: reject when the card's protocol is plainly incompatible
  //    with the inbound app (Codex needs an OpenAI-compatible upstream).
  if (cardApp === APPS.CODEX && ![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
    return null;
  }

  // 4. Rewrite the route to the generic api adapter pinned to the card's pool.
  const poolProvider = `cc-switch:${card.id}`;
  return {
    ...route,
    adapterKey: 'api',
    preferredAdapter: 'api',
    preferredModel: route.modelId || card.defaultModel || null,
    strictPreferred: false, // keep cascade fallback for robustness
    userPinned: false,
    ccSwitchCardId: card.id,
    ccSwitchCardName: card.name,
    apiPoolProvider: poolProvider,
    metadata: {
      ...(route.metadata || {}),
      source: 'cc-switch-card',
      ccSwitchCardId: card.id,
      ccSwitchCardName: card.name,
    },
  };
}

module.exports = { resolveCardRoute, appForProtocol, appsForProtocol };
