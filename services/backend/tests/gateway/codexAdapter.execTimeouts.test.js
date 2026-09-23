'use strict';

/**
 * codexAdapter.execTimeouts.test.js — locks the exec-side pure helper seams of
 * src/services/gateway/adapters/codexAdapter.js (via the `__test__` export):
 *
 *   - resolveExecIdleTimeoutMs: explicit > env > (DEFAULT_idle, resolved)
 *     cascade, always floored by GATEWAY_CODEX_MIN_IDLE_TIMEOUT_MS (min 60s);
 *   - resolveExecFirstResponseTimeoutMs: explicit > env > min(resolved, 45s),
 *     clamped to a 1s floor;
 *   - buildCliPrompt: prompt-only passthrough vs the KHY directive +
 *     "# Recent Conversation" / "# Current Request" composition from system +
 *     messages (recent 6, user/assistant labels, system-role skipped).
 *
 * Zero network, zero disk, zero child processes: all pure functions over
 * options + env. Each test reloads the module with scrubbed Codex env so the
 * env-driven cascade is deterministic. Who reorders the cascade or changes a
 * clamp bound goes red first.
 */
const CODEX_ENV_KEYS = [
  'GATEWAY_CODEX_MODE',
  'GATEWAY_CODEX_TIMEOUT_MS',
  'KHY_CODEX_TIMEOUT_MS',
  'GATEWAY_CODEX_IDLE_TIMEOUT_MS',
  'KHY_CODEX_IDLE_TIMEOUT_MS',
  'GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS',
  'KHY_CODEX_FIRST_RESPONSE_TIMEOUT_MS',
  'GATEWAY_CODEX_MIN_IDLE_TIMEOUT_MS',
  'GATEWAY_CODEX_MAX_TIMEOUT_MS',
];

function loadCodexAdapter() {
  jest.resetModules();
  for (const key of CODEX_ENV_KEYS) {
    delete process.env[key];
  }
  // deterministic module-load constants
  process.env.GATEWAY_CODEX_TIMEOUT_MS = '300000';
  return require('../../src/services/gateway/adapters/codexAdapter');
}

describe('codexAdapter exec timeout resolution (offline pure seams)', () => {
  let mod;

  beforeEach(() => {
    mod = loadCodexAdapter();
  });

  afterEach(() => {
    for (const key of CODEX_ENV_KEYS) {
      delete process.env[key];
    }
    jest.resetModules();
  });

  test('resolveExecIdleTimeoutMs: 缺省 = max(默认 300s, 下限 180s)', () => {
    expect(mod.__test__.resolveExecIdleTimeoutMs({})).toBe(300000);
  });

  test('resolveExecIdleTimeoutMs: 显式 idleTimeoutMs 被下限兜底抬到 180s', () => {
    expect(mod.__test__.resolveExecIdleTimeoutMs({ idleTimeoutMs: 90000 })).toBe(180000);
    // explicit above the floor passes through
    expect(mod.__test__.resolveExecIdleTimeoutMs({ idleTimeoutMs: 240000 })).toBe(240000);
    // non-numeric explicit falls back to env-less default, then floor
    expect(mod.__test__.resolveExecIdleTimeoutMs({ idleTimeoutMs: 'abc' })).toBe(300000);
  });

  test('resolveExecIdleTimeoutMs: env GATEWAY_CODEX_IDLE_TIMEOUT_MS 生效', () => {
    process.env.GATEWAY_CODEX_IDLE_TIMEOUT_MS = '240000';
    expect(mod.__test__.resolveExecIdleTimeoutMs({})).toBe(240000);
    process.env.GATEWAY_CODEX_IDLE_TIMEOUT_MS = '90000';
    // env value below the floor is raised to the floor
    expect(mod.__test__.resolveExecIdleTimeoutMs({})).toBe(180000);
  });

  test('resolveExecFirstResponseTimeoutMs: 缺省 = min(超时, 45s) 且不小于 1s', () => {
    expect(mod.__test__.resolveExecFirstResponseTimeoutMs({})).toBe(45000);
    // explicit value honored when sane
    expect(mod.__test__.resolveExecFirstResponseTimeoutMs({ firstResponseTimeoutMs: 10000 })).toBe(
      10000
    );
    // clamped to the 1s floor
    expect(mod.__test__.resolveExecFirstResponseTimeoutMs({ firstResponseTimeoutMs: 500 })).toBe(
      1000
    );
    // explicit total timeout caps the first-response window
    expect(
      mod.__test__.resolveExecFirstResponseTimeoutMs({
        timeoutMs: 20000,
        firstResponseTimeoutMs: 45000,
      })
    ).toBe(20000);
  });

  test('buildCliPrompt: 无 system/messages 时原样透传', () => {
    expect(mod.__test__.buildCliPrompt('fix the bug', {})).toBe('fix the bug');
    expect(mod.__test__.buildCliPrompt('', {})).toBe('');
  });

  test('buildCliPrompt: 有 system 时注入 KHY 指令 + 语言节 + 当前请求', () => {
    const system = [
      'some preamble',
      '# Language',
      'Reply in Chinese unless the user asks otherwise.',
      '# Other Section',
      'body',
    ].join('\n');
    const out = mod.__test__.buildCliPrompt('do the thing', { system });
    expect(out).toContain('[KHY PRIORITY DIRECTIVE]');
    // the "# Language" block is extracted (up to the next section header)
    expect(out).toContain('# Language\nReply in Chinese unless the user asks otherwise.');
    expect(out).not.toContain('# Other Section');
    // no messages → current request falls back to the raw prompt
    expect(out).toContain('# Current Request');
    expect(out).toContain('do the thing');
  });

  test('buildCliPrompt: messages → 最近 6 条对话 + 最后一条 user 作为当前请求', () => {
    const messages = [];
    for (let i = 0; i < 8; i += 1) {
      messages.push({ role: 'user', content: `u${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const out = mod.__test__.buildCliPrompt('ignored raw', { messages });
    expect(out).toContain('# Recent Conversation');
    // only the last 6 entries survive: u5..u7 / a5..a7, u0..u4 dropped
    expect(out).toContain('- User: u5');
    expect(out).toContain('- Assistant: a7');
    expect(out).not.toContain('u0');
    // latest user message wins as the current request
    expect(out).toContain('# Current Request');
    const currentIdx = out.indexOf('# Current Request');
    expect(out.slice(currentIdx)).toContain('u7');
    expect(out.slice(currentIdx)).not.toContain('ignored raw');
  });
});
