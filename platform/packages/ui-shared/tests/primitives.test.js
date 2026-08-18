import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthHeaders,
  createRequestSignal,
  fetchWithTimeout,
  getResponseErrorMessage,
  hasAuthToken,
  isNetworkLikeError,
  normalizeToken,
  parseStoredJson,
  resolveAuthGuard,
  unwrapResponse,
} from '../src/index.js';

test('normalizeToken accepts strings and token-shaped objects', () => {
  assert.equal(normalizeToken('Bearer abc '), 'abc');
  assert.equal(normalizeToken(' Bearer abc '), 'Bearer abc');
  assert.equal(normalizeToken({ data: { token: 'Bearer nested' } }), 'nested');
  assert.equal(normalizeToken(null), '');
});

test('auth state helpers preserve stored JSON and token truthiness', () => {
  assert.deepEqual(parseStoredJson('{"id":1}'), { id: 1 });
  assert.equal(parseStoredJson('', 'fallback'), 'fallback');
  assert.equal(parseStoredJson('{broken', null), null);
  assert.equal(parseStoredJson(1, 'fallback'), 'fallback');
  assert.equal(hasAuthToken('token'), true);
  assert.equal(hasAuthToken(''), false);
  assert.equal(hasAuthToken(null), false);
});

test('resolveAuthGuard preserves ordered auth decisions', () => {
  assert.equal(resolveAuthGuard({ requiresAuth: true, loginRedirect: '/login' }), '/login');
  assert.equal(resolveAuthGuard({ requiresAdmin: true, adminRedirect: '/home' }), '/home');
  assert.equal(resolveAuthGuard({ isGuestRoute: true, isAuthenticated: true, authenticatedRedirect: '/dashboard' }), '/dashboard');
  assert.equal(resolveAuthGuard({ requiresAdmin: true, isGuestRoute: true, isAuthenticated: true, adminRedirect: '/home', authenticatedRedirect: '/dashboard' }), '/home');
  assert.equal(resolveAuthGuard({ requiresAdmin: true, isGuestRoute: true, isAuthenticated: true, adminRedirect: '/home', authenticatedRedirect: '/dashboard', order: ['guest', 'admin'] }), '/dashboard');
  assert.equal(resolveAuthGuard(), null);
});

test('createAuthHeaders preserves caller authorization casing and headers', () => {
  assert.deepEqual(createAuthHeaders('token', { 'X-Trace': '1' }), {
    'X-Trace': '1',
    Authorization: 'Bearer token',
  });
  assert.deepEqual(createAuthHeaders('new', { authorization: 'Bearer old' }), {
    authorization: 'Bearer old',
  });
});

test('unwrapResponse handles envelopes and raw payloads', () => {
  assert.deepEqual(unwrapResponse({ data: { success: true, data: { id: 1 } } }), { id: 1 });
  assert.equal(unwrapResponse({ data: 0 }), 0);
  assert.deepEqual(unwrapResponse({ data: null }), { data: null });
});

test('response errors and network errors are classified', () => {
  assert.equal(getResponseErrorMessage({ data: { message: 'bad' } }, 'fallback'), 'bad');
  assert.equal(getResponseErrorMessage({}, 'fallback'), 'fallback');
  assert.equal(isNetworkLikeError({ code: 'ERR_NETWORK' }), true);
  assert.equal(isNetworkLikeError({ response: { status: 500 }, code: 'ERR_NETWORK' }), false);
});

test('fetchWithTimeout passes a combined signal and clears the timer', async () => {
  let receivedSignal;
  const response = await fetchWithTimeout(
    async (_url, options) => {
      receivedSignal = options.signal;
      return { ok: true };
    },
    '/fixture',
    { timeout: 25 }
  );
  assert.deepEqual(response, { ok: true });
  assert.equal(receivedSignal.aborted, false);
});

test('createRequestSignal follows an already-aborted external signal', () => {
  const external = new AbortController();
  external.abort('fixture');
  const request = createRequestSignal({ signal: external.signal });
  assert.equal(request.signal.aborted, true);
  request.dispose();
});
