'use strict';

/**
 * traeAdapter.generateChannels.test.js — locks the generate() channel cascade of
 * src/services/gateway/adapters/traeAdapter.js, fully offline via
 * _traeGenHarness.js (jest.resetModules + doMock on os/ideDetector/
 * traeOfficialArtifacts/accountPool/_proxyTunnel: zero real network, zero
 * real home-dir reads, os.homedir pinned to a throwaway temp dir).
 *
 * Locked contract (channel order: native → CW → SDK → HTTP → refresh/fallback):
 *   1. no-token         → buildFailure('Trae token not found'), zero HTTP calls
 *   2. JWT-200          → eyJ* token skips CW (jwt_skip_cw) and goes HTTP Bearer
 *   3. SSE stream       → OpenAI SSE deltas are accumulated when stream: true
 *   4. expired-refresh  → refreshToken + RefreshToken route exchange, then relay
 *                         retry with the NEW token (writeBridgeAuthToken called)
 *   5. 401 no-fallback  → auth failure is terminal: errorType 'auth', statusCode
 *                         401, exactly one relay call (no refresh — not expired,
 *                         no second token)
 *   6. non-JWT (CW)     → plain token drives the CW channel through a fake
 *                         @aws/codewhisperer-streaming-client while the REAL
 *                         _cwStreamParser.parseCWStreamEvents accumulates
 *   7. refresh-null     → refreshCredential() returns null when no token is
 *                         present, and when the token has no refreshToken
 *
 * Who changes it goes red first:
 *   - any reorder of the channel cascade or JWT-skip rules;
 *   - the refreshTraeToken contract (native host resolution, 200+data gate,
 *     expiresAt normalization) or the single-flight/backoff plumbing;
 *   - the canonical attempts logging of the cascade.
 */
const { loadTraeAdapter, JWT_TOKEN, JWT_TOKEN2 } = require('./_traeGenHarness');

const FUTURE = () => new Date(Date.now() + 7200 * 1000).toISOString();

function relayOkResponse() {
  const body = {
    choices: [{ message: { role: 'assistant', content: 'ok-from-relay' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    raw: JSON.stringify(body),
    data: body,
  };
}

describe('traeAdapter.generate() channel cascade (offline harness)', () => {
  test('无 token → generate 直接失败且不发起任何 HTTP 调用', async () => {
    const h = loadTraeAdapter({});
    try {
      const res = await h.adapter.generate('hi', { model: 'gpt-4o' });
      expect(res.success).toBe(false);
      expect(res.error).toBe('Trae token not found');
      expect(res.adapter).toBe('trae');
      expect(res.attempts).toEqual([{ provider: 'Trae', success: false, error: 'No token' }]);
      expect(h.httpSeam.calls).toHaveLength(0);
    } finally {
      h.adapter.destroy();
      h.cleanup();
    }
  });

  test('JWT token + 200 JSON → 跳过 CW 走 HTTP Bearer 中继成功', async () => {
    const h = loadTraeAdapter({
      token: JWT_TOKEN,
      expiresAt: FUTURE(),
      endpoint: 'https://relay.example.dev/v1',
    });
    h.httpSeam.routes.push({
      match: /relay\.example\.dev\/v1\/chat\/completions$/,
      response: relayOkResponse(),
    });
    try {
      const res = await h.adapter.generate('hi', { model: 'gpt-4o' });
      expect(res.success).toBe(true);
      expect(res.content).toBe('ok-from-relay');
      expect(res.model).toBe('gpt-4o');
      expect(res.tokenUsage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
      // cascade evidence: JWT skipped the CW channel, SDK was unavailable,
      // the HTTP channel succeeded.
      expect(res.attempts.some((a) => a.error === 'jwt_skip_cw')).toBe(true);
      expect(res.attempts.some((a) => a.error === 'sdk_unavailable')).toBe(true);
      expect(res.attempts.some((a) => a.provider === 'Trae(HTTP)' && a.success === true)).toBe(true);
      expect(h.httpSeam.calls.some((u) => u.endsWith('/v1/chat/completions'))).toBe(true);
      expect(h.httpSeam.calls.every((u) => !u.includes('RefreshToken'))).toBe(true);
    } finally {
      h.adapter.destroy();
      h.cleanup();
    }
  });
});
