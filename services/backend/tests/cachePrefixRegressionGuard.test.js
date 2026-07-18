'use strict';

// 缓存前缀回归守卫 — 对标 Reasonix cachehit_e2e_test.go 的 TestCacheHitPrefixStable,
// 但做成**确定性**(不依赖真实时钟跨桶):用 KHY_SYSTEM_CLOCK 的开/关代表「时钟 tick」。
//
// 核心不变式(承 [[project_prompt_cache_prefix_reorder_relay]]):relay 路径靠 provider
// 最长前缀匹配,凡「每轮/每分钟变」的内容(时钟/按需胶囊/git/task_memory)都必须在**可缓存
// 前缀之外**(baseSecurity 之后)。本守卫锁死这条:
//   G1 结构:reorder ON 时,前缀(baseSecurity 之前)不含易变锚点(# Environment / 按需胶囊);
//           它们出现在尾部(baseSecurity 之后)。
//   G2 字节稳定:reorder ON 时,切换时钟门控(=模拟时钟 tick),前缀逐字节不变
//           → 时钟完全在尾部,无法击穿前缀。
//   G3 载荷证明(load-bearing 负例):reorder OFF 时,切换时钟门控前缀**会变**
//           → 证明本守卫确实能抓「易变段回到前缀」的回归,而非空断言。
//
// 用调用方注入的 baseSecurity 唯一标记切前缀/尾部,避免依赖 git/skills/CLAUDE.md 等按 cwd 存在的段。

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECURITY_MARK = '@@KHY_CACHE_GUARD_SENTINEL_4471@@';
const CODING_MSG = '修复 backend 登录 bug,先搜索 router 和 service,再修改文件并运行 npm test 验证。';
const CODING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function buildPrompt(cwd) {
  const { getSystemPrompt, assembleSystemPrompt, clearSectionCache } = require('../src/constants/prompts');
  clearSectionCache(); // 防止跨门控/跨时钟用例复用缓存段导致串扰
  const sections = await getSystemPrompt({
    cwd,
    enabledTools: CODING_TOOLS,
    userMessage: CODING_MSG,
    taskScale: 'medium',
    baseSecurity: SECURITY_MARK,
  });
  return assembleSystemPrompt(sections);
}

// 前缀 = baseSecurity 标记之前的整段(provider 可缓存前缀的上界锚点)。
function prefixOf(prompt) {
  const i = prompt.indexOf(SECURITY_MARK);
  assert.ok(i > -1, 'baseSecurity 标记应在');
  return prompt.slice(0, i);
}

describe('缓存前缀回归守卫', () => {
  test('G1 结构:reorder ON → 易变锚点(时钟/按需胶囊)在 baseSecurity 之后', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheguard-g1-'));
    try {
      const prompt = await withEnv(
        { KHY_PROMPT_CACHE_ORDER: undefined, KHY_ONDEMAND_OUT_OF_PREFIX: undefined, KHY_SYSTEM_CLOCK: undefined },
        () => buildPrompt(tmp),
      );
      const prefix = prefixOf(prompt);
      const tail = prompt.slice(prompt.indexOf(SECURITY_MARK));
      assert.ok(!prefix.includes('# Environment'), 'reorder ON:时钟段不应在可缓存前缀内');
      assert.ok(!prefix.includes('# File operations'), 'reorder ON:按需胶囊不应在可缓存前缀内');
      assert.ok(tail.includes('# Environment'), 'reorder ON:时钟段应在 baseSecurity 之后(尾部)');
      assert.ok(tail.includes('# File operations'), 'reorder ON:按需胶囊应在 baseSecurity 之后(尾部)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('G2 字节稳定:reorder ON 时切换时钟门控(模拟 tick),可缓存前缀逐字节不变', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheguard-g2-'));
    try {
      // 时钟开(桶=1s 使内容尽量易变)vs 时钟关——两种「时钟态」代表时钟 tick 前后。
      const prefixClockOn = prefixOf(await withEnv(
        { KHY_PROMPT_CACHE_ORDER: undefined, KHY_ONDEMAND_OUT_OF_PREFIX: undefined,
          KHY_SYSTEM_CLOCK: '1', KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '1' },
        () => buildPrompt(tmp),
      ));
      const prefixClockOff = prefixOf(await withEnv(
        { KHY_PROMPT_CACHE_ORDER: undefined, KHY_ONDEMAND_OUT_OF_PREFIX: undefined,
          KHY_SYSTEM_CLOCK: 'off' },
        () => buildPrompt(tmp),
      ));
      assert.strictEqual(
        prefixClockOn, prefixClockOff,
        'reorder ON:时钟态变化不得改动可缓存前缀(时钟必须完全在尾部)',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('G3 载荷证明(负例):reorder OFF 时切换时钟门控 → 前缀会变(守卫非空断言)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheguard-g3-'));
    try {
      // reorder 关 = 今日顺序,env_info 在前缀内。切换时钟门控会改变前缀内的时钟行/段
      // (门控开:含实时时间行;门控关:legacyDateLine 形态)→ 前缀不同。证明 G2 的等价
      // 断言不是恒真:若哪天有人把易变段挪回前缀,G2 就会像这里一样开始失败。
      const prefixOn = prefixOf(await withEnv(
        { KHY_PROMPT_CACHE_ORDER: 'off', KHY_ONDEMAND_OUT_OF_PREFIX: 'off',
          KHY_SYSTEM_CLOCK: '1', KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '1' },
        () => buildPrompt(tmp),
      ));
      const prefixOff = prefixOf(await withEnv(
        { KHY_PROMPT_CACHE_ORDER: 'off', KHY_ONDEMAND_OUT_OF_PREFIX: 'off',
          KHY_SYSTEM_CLOCK: 'off' },
        () => buildPrompt(tmp),
      ));
      assert.notStrictEqual(
        prefixOn, prefixOff,
        'reorder OFF:时钟段在前缀内,时钟态变化应改动前缀(证明守卫能抓回归)',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('G4 归因叶子锁定 reorder 收益:仅尾部(时钟)变时 system 变、tools 不变', async () => {
    // 用归因叶子把「前缀稳定」表达成可断言的信号:两次构建仅时钟态不同(尾部),
    // captureShape 的 systemHash 会不同(system 串整体含尾部),但这正是归因要暴露的
    // 'system' 原因;而 tools 不变 → 不报 'tools'/'order'。守卫此处只验叶子与真实提示联动。
    const shape = require('../src/constants/promptPrefixShape');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cacheguard-g4-'));
    try {
      const tools = CODING_TOOLS.map((n) => ({ name: n, description: `tool ${n}`, input_schema: {} }));
      const promptA = await withEnv(
        { KHY_SYSTEM_CLOCK: '1', KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '1' }, () => buildPrompt(tmp));
      const promptB = await withEnv(
        { KHY_SYSTEM_CLOCK: 'off' }, () => buildPrompt(tmp));
      const a = shape.captureShape({ system: promptA, tools }, {});
      const b = shape.captureShape({ system: promptB, tools }, {});
      const r = shape.compareShape(a, b);
      assert.ok(r.reasons.includes('system'), '尾部(时钟)变 → 归因应报 system');
      assert.ok(!r.reasons.includes('tools') && !r.reasons.includes('order'), '工具未变 → 不报 tools/order');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
