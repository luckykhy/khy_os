/**
 * Data Plane Enforcer
 *
 * Single orchestration point for the proxy data plane. Keeps proxyServer.js
 * thin: it calls enforceInbound() before dispatching to the gateway, and
 * settleOutbound() once the real token usage is known.
 *
 * Auth model (priority):
 *   1. Global PROXY_AUTH_TOKEN  -> source:'global', bypasses per-customer
 *      enforcement (backward compatible). When set, a request matching it is
 *      always allowed.
 *   2. Managed customer token   -> source:'customer', full enforcement chain:
 *      enabled -> model permission -> rate limit -> quota.
 *   3. No managed tokens and no global token -> open mode (source:'open'),
 *      preserves the original unauthenticated behavior.
 *
 * enforceInbound returns one of:
 *   { ok: true, ctx }                          -> proceed
 *   { ok: false, httpStatus, code, message, retryAfterMs? } -> reject
 *
 * ctx is attached to req as req._khy and carries everything settleOutbound needs.
 */

function lazy(name) {
  // Function-internal require avoids circular deps (matches aiGateway style).
  return require(name);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Derive token usage from a gateway result, falling back to estimation when the
 * adapter returns no real counts (most CLI adapters). Marks `estimated:true`
 * in the fallback path.
 * @returns {{ inputTokens, outputTokens, estimated, provider, adapter, model }}
 */
function deriveUsage(ctx, gatewayResult, outputText = '') {
  const tokenUsage = lazy('../tokenUsageService');
  const tu = gatewayResult && gatewayResult.tokenUsage;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimated = true;

  if (tu && typeof tu === 'object') {
    inputTokens = num(tu.promptTokens ?? tu.prompt_tokens ?? tu.inputTokens ?? tu.input_tokens);
    outputTokens = num(tu.completionTokens ?? tu.completion_tokens ?? tu.outputTokens ?? tu.output_tokens);
    estimated = false;
  }

  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens = (ctx && ctx.estInput) || 0;
    outputTokens = tokenUsage.estimateTokens(outputText || '');
    estimated = true;
  }

  return {
    inputTokens,
    outputTokens,
    estimated,
    provider: (gatewayResult && gatewayResult.provider) || '',
    adapter: (gatewayResult && gatewayResult.adapter) || '',
    model: (gatewayResult && gatewayResult.model) || (ctx && ctx.model) || '',
  };
}

function getGlobalToken() {
  const customers = lazy('../aiAssetCustomerService');
  return customers.normalizeAuthToken(process.env.PROXY_AUTH_TOKEN, { allowEmpty: true });
}

function estimateInputTokens(messages, fallbackText = '') {
  const tokenUsage = lazy('../tokenUsageService');
  let text = '';
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m) continue;
      if (typeof m.content === 'string') text += m.content + '\n';
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part.text === 'string') text += part.text + '\n';
        }
      }
    }
  }
  if (!text) text = String(fallbackText || '');
  return tokenUsage.estimateTokens(text);
}

/**
 * @param {object} opts
 * @param {string} opts.bearer  raw Authorization bearer value (without "Bearer ")
 * @param {string} opts.model   requested model id (may be "provider/model")
 * @param {Array}  opts.messages request messages (for input-token estimate)
 * @param {string} opts.traceId
 * @returns {{ ok: boolean, ctx?: object, httpStatus?: number, code?: string, message?: string, retryAfterMs?: number }}
 */
async function enforceInbound({ bearer = '', model = '', messages = [], traceId = '' } = {}) {
  const customers = lazy('../aiAssetCustomerService');
  const pricing = lazy('../pricingService');

  const globalToken = getGlobalToken();
  const normalizedBearer = customers.normalizeAuthToken(bearer, { allowEmpty: true });
  const estInput = estimateInputTokens(messages);

  const baseCtx = {
    traceId,
    model,
    estInput,
    source: 'open',
    customerId: '',
    customerName: '',
    tokenId: '',
    group: 'default',
    startedAt: Date.now(),
  };

  // 1. Global token short-circuit (backward compatible).
  if (globalToken && normalizedBearer && normalizedBearer === globalToken) {
    return { ok: true, ctx: { ...baseCtx, source: 'global' } };
  }

  // 1.5 Per-user gateway routing (multi-tenant). A khy_ ApiKey whose owner has
  // saved a relay config is routed to THAT user's upstream — strict tenant
  // isolation. This layer is opt-in: a token with no saved relay falls through
  // to the existing ladder unchanged (zero regression), unless
  // GATEWAY_USER_ISOLATION_STRICT is set, in which case a recognized-but-
  // unconfigured user is rejected rather than served by global keys.
  if (normalizedBearer) {
    let userCtx = null;
    try {
      const resolver = lazy('./userGatewayResolver');
      // Resolve against the RAW bearer: a khy_ ApiKey is hashed verbatim at
      // issue time, whereas normalizeAuthToken rewrites the khy- customer-token
      // namespace and would never match the stored ApiKey hash.
      userCtx = await resolver.resolveUserGatewayContext(bearer);
    } catch {
      userCtx = null; // resolver failure → behave as a miss, never block
    }
    if (userCtx) {
      const relay = userCtx.relay;
      if (relay && relay.baseUrl) {
        return {
          ok: true,
          ctx: {
            ...baseCtx,
            source: 'user',
            userId: userCtx.userId,
            upstream: {
              apiKey: relay.apiKey || '',
              apiEndpoint: relay.baseUrl,
              model: relay.model || model || '',
              apiFormat: relay.apiFormat || 'openai',
              apiKeyField: relay.apiKeyField || 'authorization_bearer',
              endpoints: Array.isArray(relay.endpoints) ? relay.endpoints : [],
            },
          },
        };
      }
      // Recognized user but no usable relay config.
      if (String(process.env.GATEWAY_USER_ISOLATION_STRICT || '').toLowerCase() === 'true') {
        return {
          ok: false,
          httpStatus: 403,
          code: 'gateway_unconfigured',
          message: 'No per-user gateway configured for this token',
        };
      }
      // Non-strict (default): fall through to the existing ladder unchanged.
    }
  }

  // 2. Try resolving as a managed customer token.
  const resolved = normalizedBearer ? customers.resolveCustomerByToken(normalizedBearer) : null;

  if (resolved) {
    const { customer, token, enabled, group, limits } = resolved;
    if (!enabled) {
      return { ok: false, httpStatus: 403, code: 'token_disabled', message: 'Token or customer is disabled' };
    }

    // Model permission.
    if (model && !customers.hasModelAccess(customer, model)) {
      return { ok: false, httpStatus: 403, code: 'model_forbidden', message: `Model not permitted: ${model}` };
    }

    const ctx = {
      ...baseCtx,
      source: 'customer',
      customerId: customer.id,
      customerName: customer.name,
      tokenId: token.id,
      group,
      limits,
      quota: customer.quota,
    };

    // Rate limit (RPM/TPM).
    const rateLimiter = lazy('./rateLimiter');
    const groupLimits = pricing.getGroupLimits(group);
    const rl = rateLimiter.tryAcquire(`${token.id}:${model || '*'}`, {
      estTokens: estInput,
      limits: { tokenLimits: limits, customerLimits: limits, groupLimits },
    });
    if (!rl.ok) {
      return {
        ok: false,
        httpStatus: 429,
        code: `rate_limited_${rl.scope}`,
        message: `Rate limit exceeded (${rl.scope})`,
        retryAfterMs: rl.retryAfterMs,
      };
    }
    ctx._rateKey = `${token.id}:${model || '*'}`;

    // Quota (monthly requests/tokens/budget).
    const usage = lazy('../customerUsageService');
    const q = usage.checkQuota(customer);
    if (!q.ok) {
      return {
        ok: false,
        httpStatus: 429,
        code: `quota_exceeded_${q.scope}`,
        message: `Monthly quota exceeded (${q.scope}): ${q.used}/${q.limit}`,
      };
    }

    customers.touchTokenLastUsed(customer.id, token.id);
    return { ok: true, ctx };
  }

  // 3. Bearer provided but unknown, while enforcement is active -> reject.
  if (normalizedBearer && (globalToken || customers.hasManagedTokens())) {
    return { ok: false, httpStatus: 401, code: 'invalid_token', message: 'Invalid API token' };
  }

  // 3b. A global token is configured but the caller sent nothing matching.
  if (globalToken && !normalizedBearer) {
    return { ok: false, httpStatus: 401, code: 'missing_token', message: 'Authorization required' };
  }

  // 4. Open mode: no global token, no managed tokens -> allow (legacy behavior).
  return { ok: true, ctx: baseCtx };
}

/**
 * Finalize a request: compute cost, meter the customer, reconcile rate limiter,
 * and append the request log. Never throws.
 *
 * @param {object} ctx              the req._khy context from enforceInbound
 * @param {object} result
 * @param {number} result.inputTokens
 * @param {number} result.outputTokens
 * @param {boolean} result.estimated
 * @param {string} result.provider
 * @param {string} result.adapter
 * @param {string} result.model     resolved model id
 * @param {string} result.status    'ok' | 'error'
 * @param {number} result.httpStatus
 * @param {string} result.error
 */
function settleOutbound(ctx, result = {}) {
  if (!ctx) return null;
  try {
    const pricing = lazy('../pricingService');
    const usage = lazy('../customerUsageService');
    const requestLog = lazy('../requestLogService');
    const rateLimiter = lazy('./rateLimiter');

    const inputTokens = Math.max(0, Number(result.inputTokens) || ctx.estInput || 0);
    const outputTokens = Math.max(0, Number(result.outputTokens) || 0);
    const totalTokens = inputTokens + outputTokens;
    const model = result.model || ctx.model || '';
    const group = ctx.group || 'default';

    const cost = pricing.computeCost({
      provider: result.provider || '',
      model,
      input: inputTokens,
      output: outputTokens,
      groupId: group,
    });

    // Reconcile rate limiter token bucket against the real output count.
    if (ctx._rateKey) {
      rateLimiter.reconcile(ctx._rateKey, { estTokens: ctx.estInput || 0, actualTokens: totalTokens });
    }

    // Meter the customer (authoritative quota counter) when this was a customer request.
    if (ctx.source === 'customer' && ctx.customerId) {
      usage.addUsage(ctx.customerId, {
        requests: 1,
        inputTokens,
        outputTokens,
        tokens: totalTokens,
        costCny: cost.baseCostCny,
        billedCny: cost.billedCny,
      });
    }

    const latencyMs = ctx.startedAt ? Math.max(0, Date.now() - ctx.startedAt) : 0;
    requestLog.append({
      traceId: ctx.traceId || '',
      customerId: ctx.customerId || '',
      customerName: ctx.customerName || '',
      tokenId: ctx.tokenId || '',
      group,
      model,
      adapter: result.adapter || '',
      provider: result.provider || '',
      inputTokens,
      outputTokens,
      totalTokens,
      estimated: !!result.estimated,
      baseCostCny: cost.baseCostCny,
      billedCny: cost.billedCny,
      status: result.status || 'ok',
      httpStatus: Number(result.httpStatus) || 200,
      latencyMs,
      error: result.error || '',
    });

    return { ...cost, inputTokens, outputTokens, totalTokens, latencyMs };
  } catch {
    return null;
  }
}

module.exports = { enforceInbound, settleOutbound, deriveUsage, estimateInputTokens };
