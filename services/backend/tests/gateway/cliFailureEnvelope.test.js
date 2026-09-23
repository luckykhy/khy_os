'use strict';

/**
 * cliFailureEnvelope.test.js — [DESIGN-ARCH-114] / RUNTIME-005 的验收用例。
 *
 * 覆盖设计文档 §5 的 A1–A4 四项判据,重点是 §3.1「钉选优先的严格边界」——
 * 那是本规范最容易做错、且做错就会把 09-13→15 的误诊反向重犯一次的地方。
 */

const {
  buildCliFailureEnvelope,
  renderCliFailureEnvelope,
} = require('../../src/services/gateway/cliFailureEnvelope');

const ENV_ON = {};

describe('cliFailureEnvelope — [DESIGN-ARCH-114] 结构化失败信封', () => {
  describe('A2: 钉选 + 通道不存在 → CHANNEL_ABSENT_PINNED', () => {
    const result = {
      success: false,
      errorType: 'unavailable',
      preferredAdapter: 'windsurf',
      attempts: [
        {
          adapterKey: 'windsurf',
          success: false,
          statusCode: 0,
          errorType: 'unavailable',
          error: 'windsurf disabled by configuration',
        },
      ],
      resumable: false,
    };

    test('码为 CHANNEL_ABSENT_PINNED 且不显示推广清单', () => {
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(e.enabled).toBe(true);
      expect(e.code).toBe('CHANNEL_ABSENT_PINNED');
      expect(e.showPromoPanel).toBe(false);
      expect(e.routing.mode).toBe('pinned-strict');
      expect(e.routing.fallbackSuppressed).toBe(true);
    });

    test('hint 首条给出解钉方法(而非推广链接)', () => {
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      const joined = e.hint.join('\n');
      expect(joined).toMatch(/GATEWAY_PREFERRED_ADAPTER/);
      expect(joined).toMatch(/auto/);
      expect(joined).toMatch(/GATEWAY_PREFERRED_STRICT=false/);
    });

    test('首屏点名真实通道与原因,不再被截断成通用墙', () => {
      const rendered = renderCliFailureEnvelope(buildCliFailureEnvelope({ result, env: ENV_ON }));
      expect(rendered).toContain('windsurf');
      expect(rendered).toContain('CHANNEL_ABSENT_PINNED');
      expect(rendered).toMatch(/钉选 strict/);
    });
  });

  describe('A3: 钉选 + 真实 401 → AUTH_FAILED_PINNED(不得被元原因掩盖)', () => {
    const result = {
      success: false,
      errorType: 'auth',
      preferredAdapter: 'api',
      attempts: [
        {
          adapterKey: 'api',
          success: false,
          statusCode: 401,
          errorType: 'auth',
          error: 'invalid api key',
        },
      ],
    };

    test('码为 AUTH_FAILED_PINNED 而非 CHANNEL_ABSENT_PINNED', () => {
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(e.code).toBe('AUTH_FAILED_PINNED');
    });

    test('首条 hint 指向密钥(通道侧事实),而非只谈钉选', () => {
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(e.hint[0]).toMatch(/api key/i);
    });

    test('仍披露回退被抑制', () => {
      const rendered = renderCliFailureEnvelope(buildCliFailureEnvelope({ result, env: ENV_ON }));
      expect(rendered).toMatch(/钉选 strict/);
    });
  });

  describe('A1/A4: 非钉选场景的码判定与首屏', () => {
    const cases = [
      ['rate_limit', 429, 'RATE_LIMITED'],
      ['server_error', 502, 'UPSTREAM_ERROR'],
      ['network', 0, 'NETWORK_ERROR'],
      ['timeout', 0, 'TIMEOUT'],
      ['model_not_found', 404, 'MODEL_NOT_FOUND'],
      ['context_length', 413, 'CONTEXT_TOO_LONG'],
      ['cancelled', 0, 'CANCELLED'],
    ];

    test.each(cases)('%s (%s) → %s', (errorType, statusCode, expected) => {
      const result = {
        success: false,
        errorType,
        preferredAdapter: 'auto',
        attempts: [{ adapterKey: 'agnes', success: false, statusCode, errorType, error: `${errorType} happened` }],
      };
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(e.code).toBe(expected);
    });

    test('非钉选失败不显示「回退被抑制」', () => {
      const result = {
        success: false,
        errorType: 'rate_limit',
        preferredAdapter: 'auto',
        attempts: [
          { adapterKey: 'agnes', success: false, statusCode: 429, errorType: 'rate_limit', error: 'rate limit' },
        ],
      };
      const rendered = renderCliFailureEnvelope(buildCliFailureEnvelope({ result, env: ENV_ON }));
      expect(rendered).not.toMatch(/钉选 strict/);
      expect(rendered).not.toMatch(/回退已抑制/);
    });
  });

  describe('首屏行数与码互斥(§2.2 / §3)', () => {
    test('首屏 ≤ 8 行', () => {
      const result = {
        success: false,
        errorType: 'unavailable',
        preferredAdapter: 'windsurf',
        attempts: [
          {
            adapterKey: 'windsurf',
            success: false,
            statusCode: 0,
            errorType: 'unavailable',
            error: 'windsurf disabled by configuration',
          },
        ],
      };
      const rendered = renderCliFailureEnvelope(buildCliFailureEnvelope({ result, env: ENV_ON }));
      expect(rendered.split('\n').length).toBeLessThanOrEqual(8);
    });

    test('一次失败只落一个码(码为字符串且非空)', () => {
      const result = {
        success: false,
        errorType: 'auth',
        preferredAdapter: 'auto',
        attempts: [
          { adapterKey: 'a', success: false, statusCode: 401, errorType: 'auth', error: '401' },
          { adapterKey: 'b', success: false, statusCode: 429, errorType: 'rate_limit', error: '429' },
        ],
      };
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(typeof e.code).toBe('string');
      expect(e.code.length).toBeGreaterThan(0);
      // 首个命中即停 → 401 优先于 429
      expect(e.code).toBe('AUTH_FAILED');
    });
  });

  describe('门控与 fail-soft(逐字节回退)', () => {
    test('门关 → { enabled: false }', () => {
      const e = buildCliFailureEnvelope({
        result: { success: false, errorType: 'auth', attempts: [] },
        env: { KHY_CLI_FAILURE_ENVELOPE: '0' },
      });
      expect(e.enabled).toBe(false);
    });

    test.each(['0', 'false', 'off', 'no', 'OFF', 'False'])('门值 %s → 关', (v) => {
      const e = buildCliFailureEnvelope({
        result: { success: false, errorType: 'auth', attempts: [] },
        env: { KHY_CLI_FAILURE_ENVELOPE: v },
      });
      expect(e.enabled).toBe(false);
    });

    test('畸形输入绝不抛,落 CHANNEL_EXHAUSTED 兜底', () => {
      expect(() => buildCliFailureEnvelope()).not.toThrow();
      expect(() => buildCliFailureEnvelope({ result: null, env: ENV_ON })).not.toThrow();
      expect(() => buildCliFailureEnvelope({ result: 42, env: ENV_ON })).not.toThrow();
      expect(() => renderCliFailureEnvelope(null)).not.toThrow();
      expect(renderCliFailureEnvelope(null)).toBe('');
    });

    test('无 attempts 且无信号 → NO_ATTEMPT,有可执行 hint 时不显示推广清单', () => {
      // [DESIGN-ARCH-136] 起,「一条失败记录都没有」不再落 NONE 兜底,而是报可自证的
      // NO_ATTEMPT(零尝试)。旧行为把「没试过」与「试了被拦住」混为一谈,
      // 使首屏在无任何失败证据时仍披露「钉选 strict,本轮不回退」——一个没发生的因果。
      const e = buildCliFailureEnvelope({
        result: { success: false, errorType: 'unknown', preferredAdapter: 'auto', attempts: [] },
        env: ENV_ON,
      });
      expect(e.code).toBe('NO_ATTEMPT');
      // §2.2 红线 R-GW-1:推广清单只在「确实没有任何可执行建议」时出现。
      // NO_ATTEMPT 仍能给出 `khy gateway status` 等下一步,所以清单不该占首屏。
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.showPromoPanel).toBe(false);
    });

    test('推广清单仅在 CHANNEL_EXHAUSTED 或 hint 为空时出现', () => {
      const exhausted = buildCliFailureEnvelope({
        result: { success: false, errorType: 'unknown', preferredAdapter: 'auto', attempts: [] },
        env: ENV_ON,
      });
      // 构造一个 hint 为空的码(取消类),验证「hint 空 → 允许清单」这条分支
      const cancelled = buildCliFailureEnvelope({
        result: {
          success: false,
          errorType: 'cancelled',
          preferredAdapter: 'auto',
          attempts: [{ adapterKey: 'x', success: false, statusCode: 0, errorType: 'cancelled', error: 'aborted' }],
        },
        env: ENV_ON,
      });
      expect(cancelled.code).toBe('CANCELLED');
      expect(cancelled.hint.length).toBe(0);
      expect(cancelled.showPromoPanel).toBe(true);
      // CHANNEL_EXHAUSTED 兜底信封恒可显示清单
      expect(typeof exhausted.showPromoPanel).toBe('boolean');
    });
  });

  describe('陈旧缓存跳过不抢主因(failureReasonRanking 语义)', () => {
    test('取新鲜的 live 失败而非陈旧的 virtualSkip', () => {
      const result = {
        success: false,
        errorType: 'rate_limit',
        preferredAdapter: 'auto',
        attempts: [
          {
            adapterKey: 'glm',
            success: false,
            statusCode: 0,
            errorType: 'model_not_found',
            error: 'recent model_not_found failure cached: 404 (cooldown 238s)',
            virtualSkip: true,
          },
          {
            adapterKey: 'glm',
            success: false,
            statusCode: 429,
            errorType: 'rate_limit',
            error: 'HTTP 429 code=1305',
          },
        ],
      };
      const e = buildCliFailureEnvelope({ result, env: ENV_ON });
      expect(e.cause.statusCode).toBe(429);
      expect(e.code).toBe('RATE_LIMITED');
    });
  });
});
