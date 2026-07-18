'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const customerRegistry = require('./customerRegistry');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');

const STORE_FILE = path.join(getDataHome(), 'ai_gateway_payments.json');
const LEGACY_STORE_FILE = path.join(getLegacyDataHome(), 'ai_gateway_payments.json');
const STORE_VERSION = 1;
const DEFAULT_PROVIDER = 'mock';
const DEFAULT_CURRENCY = 'CNY';
const DEFAULT_EXPIRES_MINUTES = 30;
const MAX_PAGE_SIZE = 100;
const SUPPORTED_PROVIDERS = new Set(['mock']);
const FINAL_STATES = new Set(['fulfilled', 'failed', 'cancelled', 'expired']);

// 收敛到 utils/mkdirpSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../../utils/mkdirpSync');

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonWithFallback(filePaths = [], fallback = {}) {
  for (const filePath of filePaths) {
    try {
      if (!filePath || !fs.existsSync(filePath)) continue;
      return safeJsonParse(fs.readFileSync(filePath, 'utf-8'), fallback);
    } catch {
      // try next
    }
  }
  return fallback;
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function roundCny(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function normalizePositiveInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
}

function normalizeGrant(input = {}, fallbackAmountCny = 0) {
  const src = isPlainObject(input) ? input : {};
  const normalized = {
    monthlyRequests: normalizePositiveInt(src.monthlyRequests),
    monthlyTokens: normalizePositiveInt(src.monthlyTokens),
    monthlyBudgetCny: Math.max(0, roundCny(src.monthlyBudgetCny)),
  };
  if (normalized.monthlyRequests === 0 && normalized.monthlyTokens === 0 && normalized.monthlyBudgetCny === 0) {
    normalized.monthlyBudgetCny = Math.max(0, roundCny(fallbackAmountCny));
  }
  return normalized;
}

function cloneJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeProvider(raw) {
  const provider = String(raw || DEFAULT_PROVIDER).trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`unsupported payment provider: ${provider}`);
  }
  return provider;
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePaymentStatus(raw) {
  const value = String(raw || 'pending').trim().toLowerCase();
  return ['pending', 'fulfilled', 'failed', 'cancelled', 'expired'].includes(value)
    ? value
    : 'pending';
}

function normalizeEvent(raw = {}) {
  const input = isPlainObject(raw) ? raw : {};
  return {
    id: String(input.id || generateId('evt')),
    orderId: String(input.orderId || '').trim(),
    type: String(input.type || 'unknown').trim() || 'unknown',
    provider: String(input.provider || DEFAULT_PROVIDER).trim().toLowerCase() || DEFAULT_PROVIDER,
    eventId: String(input.eventId || '').trim(),
    source: String(input.source || '').trim(),
    payload: cloneJson(input.payload, {}),
    createdAt: String(input.createdAt || new Date().toISOString()),
  };
}

function normalizePayment(raw = {}) {
  const input = isPlainObject(raw) ? raw : {};
  const amountCny = Math.max(0, roundCny(input.amountCny));
  const createdAt = String(input.createdAt || new Date().toISOString());
  const expiresAt = String(
    input.expiresAt
      || new Date(Date.parse(createdAt) + (DEFAULT_EXPIRES_MINUTES * 60 * 1000)).toISOString()
  );
  return {
    id: String(input.id || generateId('pay')),
    userId: Number.isFinite(Number(input.userId)) ? Number(input.userId) : 0,
    userRole: String(input.userRole || 'user').trim().toLowerCase() || 'user',
    customerId: String(input.customerId || '').trim(),
    customerName: String(input.customerName || '').trim(),
    provider: normalizeProvider(input.provider || DEFAULT_PROVIDER),
    amountCny,
    currency: String(input.currency || DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY,
    subject: String(input.subject || '').trim(),
    description: String(input.description || '').trim(),
    grant: normalizeGrant(input.grant, amountCny),
    status: normalizePaymentStatus(input.status),
    idempotencyKey: String(input.idempotencyKey || '').trim(),
    metadata: cloneJson(input.metadata, {}),
    gatewayTradeNo: String(input.gatewayTradeNo || '').trim(),
    gatewayEventId: String(input.gatewayEventId || '').trim(),
    webhookCount: normalizePositiveInt(input.webhookCount),
    failureReason: String(input.failureReason || '').trim(),
    cancellationReason: String(input.cancellationReason || '').trim(),
    createdAt,
    updatedAt: String(input.updatedAt || createdAt),
    expiresAt,
    paidAt: input.paidAt ? String(input.paidAt) : null,
    fulfilledAt: input.fulfilledAt ? String(input.fulfilledAt) : null,
    cancelledAt: input.cancelledAt ? String(input.cancelledAt) : null,
    result: cloneJson(input.result, {}),
  };
}

function markExpiredPayments(store) {
  let changed = false;
  const now = Date.now();
  for (const order of store.payments) {
    if (order.status !== 'pending') continue;
    const expiresAtMs = Date.parse(order.expiresAt || '');
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
      order.status = 'expired';
      order.updatedAt = new Date(now).toISOString();
      changed = true;
    }
  }
  return changed;
}

function loadStore() {
  ensureDir(getDataHome());
  const raw = readJsonWithFallback(
    [STORE_FILE, LEGACY_STORE_FILE],
    { version: STORE_VERSION, payments: [], events: [] }
  );
  const store = {
    version: STORE_VERSION,
    payments: Array.isArray(raw.payments) ? raw.payments.map(normalizePayment) : [],
    events: Array.isArray(raw.events) ? raw.events.map(normalizeEvent) : [],
  };
  if (markExpiredPayments(store)) saveStore(store);
  return store;
}

function saveStore(store) {
  const payments = Array.isArray(store?.payments) ? store.payments.map(normalizePayment) : [];
  const events = Array.isArray(store?.events) ? store.events.map(normalizeEvent) : [];
  const payload = { version: STORE_VERSION, payments, events };
  writeJsonAtomic(STORE_FILE, payload);
  return payload;
}

function getPaymentById(store, paymentId) {
  const id = String(paymentId || '').trim();
  return store.payments.find((item) => item.id === id) || null;
}

function getEventsForOrder(store, paymentId) {
  const id = String(paymentId || '').trim();
  return store.events
    .filter((item) => item.orderId === id)
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
}

function isAdminLikeUser(user = {}) {
  return Number(user?.id || 0) === 0 || String(user?.role || '').trim().toLowerCase() === 'admin';
}

function canAccessOrder(order, actorUser = {}) {
  if (!order) return false;
  if (isAdminLikeUser(actorUser)) return true;
  return Number(order.userId || 0) === Number(actorUser?.id || -1);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function buildSignaturePayload(payload) {
  return JSON.stringify(canonicalize(payload || {}));
}

function signMockWebhookPayload(payload, secret = '') {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(buildSignaturePayload(payload))
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf-8');
  const right = Buffer.from(String(b || ''), 'utf-8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyMockWebhookSignature(payload, signature = '') {
  const rawSecret = String(process.env.AI_PAYMENT_WEBHOOK_SECRET || process.env.KHY_PAYMENT_WEBHOOK_SECRET || '').trim();
  const normalizedSignature = String(signature || '').trim().replace(/^sha256=/i, '');

  if (!rawSecret) {
    return process.env.NODE_ENV !== 'production';
  }
  if (!normalizedSignature) return false;
  const expected = signMockWebhookPayload(payload, rawSecret);
  return timingSafeEqualHex(normalizedSignature, expected);
}

function inferBaseUrl(reqLike = {}) {
  const envBase = String(process.env.AI_PAYMENT_PUBLIC_BASE_URL || process.env.KHY_PAYMENT_PUBLIC_BASE_URL || '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');

  const headers = reqLike.headers || {};
  const forwardedHost = String(headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(headers.host || '').trim();
  const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwardedProto || String(reqLike.protocol || 'http').trim().toLowerCase() || 'http';
  if (!host) return '';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

function buildCheckoutDescriptor(order, baseUrl = '') {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const statusPath = `/api/ai-gateway/payments/${order.id}`;
  const confirmPath = `/api/ai-gateway/payments/${order.id}/mock/confirm`;
  const cancelPath = `/api/ai-gateway/payments/${order.id}/cancel`;
  const webhookPath = '/api/payment-webhooks/mock';
  const qrPayload = `khy-pay://mock?payment_id=${encodeURIComponent(order.id)}&amount_cny=${order.amountCny.toFixed(2)}`;
  return {
    mode: 'mock_qr',
    qrPayload,
    statusUrl: root ? `${root}${statusPath}` : statusPath,
    confirmUrl: root ? `${root}${confirmPath}` : confirmPath,
    cancelUrl: root ? `${root}${cancelPath}` : cancelPath,
    webhookUrl: root ? `${root}${webhookPath}` : webhookPath,
    signatureHeader: 'X-KHY-Signature',
    expiresAt: order.expiresAt,
    instructions: [
      'Scan is simulated locally. Use the mock confirm endpoint or post a signed webhook to complete payment.',
      'Poll the status endpoint to observe state transitions from pending to fulfilled, failed, cancelled, or expired.',
      'Successful completion automatically applies the purchased quota delta to the target AI gateway customer.',
    ],
  };
}

async function decoratePaymentView(order, store, options = {}) {
  const view = cloneJson(order, {});
  if (options.includeEvents) {
    view.events = getEventsForOrder(store, order.id);
  }
  if (options.includeCheckout) {
    const checkout = buildCheckoutDescriptor(order, options.baseUrl || '');
    view.checkout = {
      ...checkout,
      qrCodeDataUrl: await QRCode.toDataURL(checkout.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
      }),
    };
  }
  return view;
}

function parsePaging(input = {}) {
  const page = Math.max(1, normalizePositiveInt(input.page || 1) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, normalizePositiveInt(input.pageSize || 20) || 20));
  return { page, pageSize };
}

function recordEvent(store, event) {
  const normalized = normalizeEvent(event);
  store.events.push(normalized);
  return normalized;
}

function ensureCustomerOrThrow(customerId) {
  const id = String(customerId || '').trim();
  if (!id) throw new Error('customerId is required');
  const customer = customerRegistry.getCustomer(id, { includeSecrets: false });
  if (!customer) throw new Error(`customer not found: ${id}`);
  return customer;
}

async function createPayment(input = {}, options = {}) {
  const actorUser = options.actorUser || { id: 0, role: 'admin' };
  if (!isAdminLikeUser(actorUser)) {
    throw new Error('admin access is required to create payment orders');
  }

  const customer = ensureCustomerOrThrow(input.customerId);
  const amountCny = roundCny(input.amountCny);
  if (!(amountCny > 0)) throw new Error('amountCny must be greater than 0');

  const provider = normalizeProvider(input.provider || DEFAULT_PROVIDER);
  const subject = String(input.subject || `AI gateway quota top-up · ${customer.name}`).trim().slice(0, 120);
  const description = String(input.description || 'Top up AI gateway customer quota via payment gateway').trim().slice(0, 500);
  const grant = normalizeGrant(input.grant, amountCny);
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const expiresInMinutes = Math.min(24 * 60, Math.max(1, normalizePositiveInt(input.expiresInMinutes || DEFAULT_EXPIRES_MINUTES) || DEFAULT_EXPIRES_MINUTES));

  const store = loadStore();
  if (idempotencyKey) {
    const existing = store.payments.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) {
      return decoratePaymentView(existing, store, {
        includeCheckout: true,
        includeEvents: true,
        baseUrl: options.baseUrl || '',
      });
    }
  }

  const now = new Date();
  const order = normalizePayment({
    id: generateId('pay'),
    userId: Number(actorUser.id || 0),
    userRole: String(actorUser.role || 'admin').trim().toLowerCase() || 'admin',
    customerId: customer.id,
    customerName: customer.name,
    provider,
    amountCny,
    currency: DEFAULT_CURRENCY,
    subject,
    description,
    grant,
    status: 'pending',
    idempotencyKey,
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (expiresInMinutes * 60 * 1000)).toISOString(),
  });

  store.payments.unshift(order);
  recordEvent(store, {
    orderId: order.id,
    type: 'payment.created',
    provider: order.provider,
    source: 'api',
    payload: {
      customerId: order.customerId,
      amountCny: order.amountCny,
      grant: order.grant,
      subject: order.subject,
    },
  });
  saveStore(store);

  return decoratePaymentView(order, store, {
    includeCheckout: true,
    includeEvents: true,
    baseUrl: options.baseUrl || '',
  });
}

async function listPayments(filters = {}, options = {}) {
  const actorUser = options.actorUser || { id: 0, role: 'admin' };
  if (!isAdminLikeUser(actorUser)) {
    throw new Error('admin access is required to list payment orders');
  }

  const store = loadStore();
  const { page, pageSize } = parsePaging(filters);
  const status = String(filters.status || '').trim().toLowerCase();
  const customerId = String(filters.customerId || '').trim();
  const provider = String(filters.provider || '').trim().toLowerCase();

  let rows = store.payments.slice();
  if (!isAdminLikeUser(actorUser)) {
    rows = rows.filter((item) => Number(item.userId || 0) === Number(actorUser.id || -1));
  }
  if (status) rows = rows.filter((item) => item.status === status);
  if (customerId) rows = rows.filter((item) => item.customerId === customerId);
  if (provider) rows = rows.filter((item) => item.provider === provider);

  rows.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map((item) => cloneJson(item, {}));
  return {
    total,
    page,
    pageSize,
    list: pageRows,
  };
}

async function getPayment(paymentId, options = {}) {
  const store = loadStore();
  const order = getPaymentById(store, paymentId);
  if (!order) throw new Error(`payment not found: ${paymentId}`);
  const actorUser = options.actorUser || { id: 0, role: 'admin' };
  if (!canAccessOrder(order, actorUser)) {
    throw new Error('forbidden');
  }
  return decoratePaymentView(order, store, {
    includeEvents: options.includeEvents !== false,
    includeCheckout: options.includeCheckout === true,
    baseUrl: options.baseUrl || '',
  });
}

async function cancelPayment(paymentId, input = {}, options = {}) {
  const actorUser = options.actorUser || { id: 0, role: 'admin' };
  if (!isAdminLikeUser(actorUser)) {
    throw new Error('admin access is required to cancel payment orders');
  }

  const store = loadStore();
  const order = getPaymentById(store, paymentId);
  if (!order) throw new Error(`payment not found: ${paymentId}`);
  if (FINAL_STATES.has(order.status)) {
    return decoratePaymentView(order, store, { includeEvents: true, includeCheckout: true, baseUrl: options.baseUrl || '' });
  }
  if (order.status !== 'pending') {
    throw new Error(`payment cannot be cancelled from status ${order.status}`);
  }

  const now = new Date().toISOString();
  order.status = 'cancelled';
  order.cancelledAt = now;
  order.cancellationReason = String(input.reason || 'cancelled_by_operator').trim();
  order.updatedAt = now;
  recordEvent(store, {
    orderId: order.id,
    type: 'payment.cancelled',
    provider: order.provider,
    source: 'api',
    payload: { reason: order.cancellationReason },
  });
  saveStore(store);
  return decoratePaymentView(order, store, { includeEvents: true, includeCheckout: true, baseUrl: options.baseUrl || '' });
}

function applyFulfillment(order) {
  const updatedCustomer = customerRegistry.adjustCustomerQuota(order.customerId, order.grant, { includeSecrets: false });
  order.result = {
    customerId: updatedCustomer.id,
    customerName: updatedCustomer.name,
    appliedGrant: cloneJson(order.grant, {}),
    quotaAfter: cloneJson(updatedCustomer.quota, {}),
  };
  order.fulfilledAt = new Date().toISOString();
  order.status = 'fulfilled';
  order.updatedAt = order.fulfilledAt;
  return updatedCustomer;
}

async function processWebhook(providerRaw, payload = {}, options = {}) {
  const provider = normalizeProvider(providerRaw || DEFAULT_PROVIDER);
  const source = String(options.source || 'webhook').trim() || 'webhook';
  const body = isPlainObject(payload) ? payload : {};
  const orderId = String(body.orderId || body.paymentId || '').trim();
  if (!orderId) throw new Error('orderId is required');
  if (!['mock'].includes(provider)) throw new Error(`provider handler is not implemented: ${provider}`);

  if (!options.skipSignatureVerification) {
    const signature = String(options.signature || '').trim();
    if (!verifyMockWebhookSignature(body, signature)) {
      throw new Error('invalid webhook signature');
    }
  }

  const store = loadStore();
  const order = getPaymentById(store, orderId);
  if (!order) throw new Error(`payment not found: ${orderId}`);

  const eventId = String(body.eventId || body.gatewayEventId || '').trim();
  if (eventId) {
    const existingEvent = store.events.find((item) => item.orderId === order.id && item.eventId === eventId);
    if (existingEvent) {
      return decoratePaymentView(order, store, {
        includeEvents: true,
        includeCheckout: true,
        baseUrl: options.baseUrl || '',
      });
    }
  }

  const status = String(body.status || 'paid').trim().toLowerCase();
  if (!['paid', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`unsupported webhook status: ${status}`);
  }

  const amountCny = body.amountCny == null ? null : roundCny(body.amountCny);
  if (amountCny != null && amountCny > 0 && amountCny !== order.amountCny) {
    throw new Error(`amount mismatch: expected ${order.amountCny.toFixed(2)}, got ${amountCny.toFixed(2)}`);
  }

  const now = new Date().toISOString();
  order.gatewayTradeNo = String(body.gatewayTradeNo || body.tradeNo || order.gatewayTradeNo || '').trim();
  order.gatewayEventId = eventId || order.gatewayEventId || '';
  order.webhookCount = normalizePositiveInt(order.webhookCount) + 1;
  order.updatedAt = now;

  recordEvent(store, {
    orderId: order.id,
    type: `payment.webhook.${status}`,
    provider,
    eventId,
    source,
    payload: body,
  });

  if (status === 'paid') {
    order.paidAt = String(body.paidAt || now);
    if (!FINAL_STATES.has(order.status)) {
      applyFulfillment(order);
      recordEvent(store, {
        orderId: order.id,
        type: 'payment.fulfilled',
        provider,
        eventId,
        source,
        payload: cloneJson(order.result, {}),
      });
    }
  } else if (!FINAL_STATES.has(order.status)) {
    order.status = status === 'failed' ? 'failed' : 'cancelled';
    if (status === 'cancelled') order.cancelledAt = now;
    if (status === 'failed') order.failureReason = String(body.reason || body.failureReason || 'gateway_reported_failure').trim();
  }

  saveStore(store);
  return decoratePaymentView(order, store, {
    includeEvents: true,
    includeCheckout: true,
    baseUrl: options.baseUrl || '',
  });
}

async function confirmMockPayment(paymentId, input = {}, options = {}) {
  const actorUser = options.actorUser || { id: 0, role: 'admin' };
  if (!isAdminLikeUser(actorUser)) {
    throw new Error('admin access is required to confirm mock payments');
  }

  const payload = {
    orderId: String(paymentId || '').trim(),
    eventId: String(input.eventId || generateId('mwevt')).trim(),
    gatewayTradeNo: String(input.gatewayTradeNo || `mock_${Date.now()}`).trim(),
    status: 'paid',
    amountCny: input.amountCny,
    paidAt: input.paidAt || new Date().toISOString(),
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  };
  return processWebhook(DEFAULT_PROVIDER, payload, {
    skipSignatureVerification: true,
    source: 'mock_confirm',
    baseUrl: options.baseUrl || '',
  });
}

module.exports = {
  createPayment,
  listPayments,
  getPayment,
  cancelPayment,
  processWebhook,
  confirmMockPayment,
  inferBaseUrl,
  signMockWebhookPayload,
  verifyMockWebhookSignature,
  __test__: {
    STORE_FILE,
    LEGACY_STORE_FILE,
    loadStore,
    saveStore,
    normalizeGrant,
    buildSignaturePayload,
    buildCheckoutDescriptor,
    isAdminLikeUser,
  },
};
