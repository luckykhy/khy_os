'use strict';

/**
 * _traeGenHarness.minimal.test.js — temporary harness smoke check (delete once verified).
 */
const { loadTraeAdapter, JWT_TOKEN } = require('./_traeGenHarness');

describe('harness smoke', () => {
  test('no-token → generate fails with "Trae token not found" and zero HTTP calls', async () => {
    const h = loadTraeAdapter({});
    try {
      const res = await h.adapter.generate('hi', { model: 'gpt-4o' });
      expect(res.success).toBe(false);
      expect(res.error).toBe('Trae token not found');
      expect(res.adapter).toBe('trae');
      expect(h.httpSeam.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test('JWT token + 200 JSON relay → success via HTTP Bearer channel', async () => {
    const h = loadTraeAdapter({
      token: JWT_TOKEN,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      endpoint: 'https://relay.example.dev/v1',
    });
    h.httpSeam.routes.push({
      match: /relay\.example\.dev\/v1\/chat\/completions$/,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        raw: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok-from-relay' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        data: {
          choices: [{ message: { role: 'assistant', content: 'ok-from-relay' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        },
      },
    });
    try {
      const res = await h.adapter.generate('hi', { model: 'gpt-4o' });
      expect(res.success).toBe(true);
      expect(res.content).toBe('ok-from-relay');
      expect(res.tokenUsage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
      expect(h.httpSeam.calls.some((u) => u.includes('/v1/chat/completions'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
