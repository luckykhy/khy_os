'use strict';

/**
 * streamErrorClassification.test.js —— 转录区错误行的「落档 + 宽度」守卫(BUG-44)。
 *
 * 缺陷本体(实测于真实 `_classifyStreamError`，见 .khy/feedback/tui-ux-audit-20260919/AE/)：
 *   S1 落档错：8 例真实厂商错误串有 5 例退化成泛指的 `请求失败：<原文>`。
 *      OpenAI 说的是 `Incorrect API key provided`、Anthropic 是 `invalid x-api-key`、
 *      error.code 是 `invalid_api_key` —— 旧词表 `invalid ?api ?key` 三种全漏；
 *      中文侧（余额不足 / 当前访问用户较多 / 模型实例不存在）整档没有中文词。
 *      → 违反 RUNTIME-002 §2.2：错误消息必须给「问题 + 怎么修」，而恰恰是这几类
 *        最需要 `khy gateway config` 这句可执行建议。
 *   S2 宽度失控：兜底按**字符数**截（`length > 80 ? slice(0,77)`）。CJK 一字两列，
 *      实测两型：截了仍 90 列；55 字中文（55<80）**压根没截**，上屏 110 列。
 *
 * 守卫钉的是**不变量**，不是文案：
 *   1) 已知语义的原文必须落到对应具体档，不得留在泛指兜底；
 *   2) 补词表不得过度命中（网络/超时/5xx 不许被新中文词抢走）；
 *   3) 任何一条上屏行的**显示宽度** ≤ 80 列（用渲染层同一套 displayWidth）；
 *   4) 每条错误行都必须含「问题：建议」的分隔与可执行动作词。
 *
 * 纯函数测试，不需要 ink/vm-modules，因此不套 describeOrSkip。
 */

const path = require('path');
const { displayWidth } = require('../../src/cli/formatters');

const HOOK = path.join(__dirname, '../../src/cli/tui/hooks/useQueryBridge.js');
const { classifyStreamError } = require(HOOK);

// 真实世界原文（逐字取自各厂商返回体），expect 是**档位前缀**而非整句文案。
const REAL_WORLD = [
  { raw: 'Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account/api-keys.', expect: '认证失败' },
  { raw: 'invalid x-api-key', expect: '认证失败' },
  { raw: 'invalid_api_key', expect: '认证失败' },
  { raw: 'Your authentication token has been invalidated', expect: '认证失败' },
  { raw: '余额不足，请充值后再试 (status code: 2061)', expect: '额度已用完' },
  { raw: '当前访问用户较多，请稍后再试', expect: '限流' },
  { raw: 'This model\'s maximum context length is 200000 tokens, however you requested 300000 tokens', expect: '上下文超限' },
  { raw: '上游服务返回异常：模型实例不存在，请检查配置中的模型名称是否与平台一致', expect: '模型不存在' },
];

// 反例：补中文词最怕抢档 —— 这三类必须留在自己原来的档。
const NO_CROSSWALK = [
  { raw: 'fetch failed: getaddrinfo ENOTFOUND api.example.com', expect: '网络连接失败' },
  { raw: 'Internal Server Error：模型服务暂不可用，请稍后重试', expect: '上游异常' },
  { raw: 'request timed out after 120000 ms', expect: '请求超时' },
];

const FALLBACK_BUDGET = 80; // 兜底行的列预算（含 `请求失败：` 前缀）

describe('转录区错误行落档(BUG-44 S1)', () => {
  test.each(REAL_WORLD)('真实原文落到具体档而不是泛指兜底：%s', ({ raw, expect: want }) => {
    const out = classifyStreamError(raw, {});
    expect(out.startsWith(want)).toBe(true);
    expect(out.startsWith('请求失败：')).toBe(false);
  });

  test.each(NO_CROSSWALK)('补词不得抢档：%s', ({ raw, expect: want }) => {
    expect(classifyStreamError(raw, {}).startsWith(want)).toBe(true);
  });

  test('status 仍优先于文本（429/404 走码不靠词表）', () => {
    expect(classifyStreamError('something odd', { statusCode: 429 }).startsWith('限流')).toBe(true);
    expect(classifyStreamError('something odd', { statusCode: 401 }).startsWith('认证失败')).toBe(true);
  });
});

describe('转录区错误行宽度(BUG-44 S2)', () => {
  const samples = [
    '上游网关返回异常状态，本次请求未能完成处理，请稍后重试或切换模型通道。'.repeat(6),
    'a'.repeat(500),
    'x'.repeat(79) + '尾部再拖一段中文说明',
    '请求被风控拦截'.repeat(20),
  ];

  test.each(samples)('兜底每一渲染行的显示宽度 ≤ %s 列', (raw) => {
    const out = classifyStreamError(raw, {});
    expect(out.startsWith('请求失败：')).toBe(true);
    for (const line of out.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(FALLBACK_BUDGET);
    }
  });

  test('兜底必须带一行可执行建议（不复读原文就算完）', () => {
    const out = classifyStreamError('completely unknown upstream failure', {});
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatch(/khy gateway status/);
  });

  test('空原文不产生悬空冒号', () => {
    const out = classifyStreamError('', {});
    expect(out).toContain('上游未返回错误详情');
    expect(out).not.toMatch(/^请求失败：\s*\n/);
  });

  test('短原文不被无谓截断（不硬吃省略号）', () => {
    expect(classifyStreamError('boom', {})).toBe('请求失败：boom\n下一步：运行 khy gateway status 查通道可用性，或换模型通道重试');
  });
});

describe('每条错误行都符合 RUNTIME-002 §2.2「问题：建议」', () => {
  const all = [...REAL_WORLD, ...NO_CROSSWALK, { raw: '完全没见过的上游错误', expect: null }];

  test.each(all)('含分隔冒号与可执行动作：%s', ({ raw }) => {
    const out = classifyStreamError(raw, {});
    expect(out).toMatch(/：/);
    // 建议必须是**能做的动作**：一条命令、一个 /命令、或明确的下一步
    expect(out).toMatch(/khy |\/model|\/compact|重试|充值|更换|检查|调整|继续/);
  });

  test('绝不返回空串或纯泛指状态词', () => {
    for (const raw of ['', null, undefined, '   ']) {
      const out = classifyStreamError(raw, {});
      expect(typeof out).toBe('string');
      expect(out.trim().length).toBeGreaterThan(0);
      expect(out).not.toMatch(/^(错误|异常|失败|未知错误)[：:]?$/);
    }
  });
});
