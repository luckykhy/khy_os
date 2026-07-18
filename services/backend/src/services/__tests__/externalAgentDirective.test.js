'use strict';

/**
 * externalAgentDirective.test.js — 纯叶子测试:
 *   ① 能力指令始终注入(门开)/ 父子门控逐字节回退(门关)。
 *   ② 确定性 NL 识别:点名 + 驱动动词两命中才接管;零假阳性;子串不误命中。
 *   ③ delegatable vs launch-only 的 nudge 分支。
 *   ④ fail-soft:异常/空输入返中性值,绝不抛。
 */

const ead = require('../externalAgentDirective');

const ON = {}; // 空 env → 默认 on(default-on 门控)
const OFF_DIRECTIVE = { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' };
const OFF_NUDGE = { KHY_EXTERNAL_AGENT_NUDGE: 'off' };
const OFF_PARENT = { KHY_WEAK_MODEL_GUIDANCE: 'false' };

describe('externalAgentDirective — 门控', () => {
  test('默认 on:能力指令与 nudge 均启用', () => {
    expect(ead.isExternalAgentDirectiveEnabled(ON)).toBe(true);
    expect(ead.isExternalAgentNudgeEnabled(ON)).toBe(true);
  });

  test('子门关 → 该面回退,另一面不受影响', () => {
    expect(ead.isExternalAgentDirectiveEnabled(OFF_DIRECTIVE)).toBe(false);
    expect(ead.isExternalAgentNudgeEnabled(OFF_NUDGE)).toBe(false);
  });

  test('父门 KHY_WEAK_MODEL_GUIDANCE 关 → 能力指令必关(父→子)', () => {
    expect(ead.isExternalAgentDirectiveEnabled(OFF_PARENT)).toBe(false);
  });
});

describe('externalAgentDirective — buildExternalAgentDirective', () => {
  test('门开:注入含三个 delegatable subagent_type 与顶层启动项', () => {
    const d = ead.buildExternalAgentDirective(ON);
    expect(d).toContain('驱动其它 agent');
    expect(d).toContain("subagent_type: 'claude'");
    expect(d).toContain("subagent_type: 'codex'");
    expect(d).toContain("subagent_type: 'opencode'");
    expect(d).toContain('自包含'); // 委派要点:prompt 自包含
    expect(d).toContain('khy cursor'); // launch-only 顶层命令
  });

  test('门关(directive 子门)→ 返空(逐字节回退)', () => {
    expect(ead.buildExternalAgentDirective(OFF_DIRECTIVE)).toBe('');
  });

  test('父门关 → 返空', () => {
    expect(ead.buildExternalAgentDirective(OFF_PARENT)).toBe('');
  });
});

describe('externalAgentDirective — detectExternalAgentRequest', () => {
  test('点名 + 驱动动词 → 命中(claude,delegatable)', () => {
    const hit = ead.detectExternalAgentRequest('用 claude code 帮我重构这个模块', ON);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('claude');
    expect(hit.delegatable).toBe(true);
  });

  test('英文「delegate to codex」→ 命中 codex', () => {
    const hit = ead.detectExternalAgentRequest('please delegate to codex and run the tests', ON);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('codex');
  });

  test('「叫 opencode 改这个」→ 命中 opencode', () => {
    const hit = ead.detectExternalAgentRequest('叫 opencode 改这个 bug', ON);
    expect(hit && hit.id).toBe('opencode');
  });

  test('launch-only:「切换到 cursor」→ 命中但 delegatable=false', () => {
    const hit = ead.detectExternalAgentRequest('切换到 cursor 来做', ON);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('cursor');
    expect(hit.delegatable).toBe(false);
  });

  test('无驱动动词 → 不接管(仅提到 agent 名)', () => {
    expect(ead.detectExternalAgentRequest('claude code 是什么?', ON)).toBeNull();
    expect(ead.detectExternalAgentRequest('codex 的价格如何', ON)).toBeNull();
  });

  test('子串不误命中:"clause"/"cursor position" 类不触发', () => {
    // "clause" 含子串但前后是字母 → 不命中 claude
    expect(ead.detectExternalAgentRequest('请解释这个 license clause', ON)).toBeNull();
    // "cursor" 是词但无驱动动词
    expect(ead.detectExternalAgentRequest('把 cursor 移到行尾', ON)).toBeNull();
  });

  test('多 agent 同现:按注册表顺序取第一个(delegatable 靠前)', () => {
    const hit = ead.detectExternalAgentRequest('用 codex 还是 cursor?让 codex 来吧', ON);
    expect(hit && hit.id).toBe('codex');
  });

  test('门关(nudge 子门)→ 恒返 null', () => {
    expect(ead.detectExternalAgentRequest('用 claude code 帮我重构', OFF_NUDGE)).toBeNull();
  });

  test('父门(directive)关 → nudge 子门必关 → 返 null', () => {
    expect(ead.detectExternalAgentRequest('用 claude code 帮我重构', OFF_DIRECTIVE)).toBeNull();
  });

  test('空/异常输入 → null,绝不抛', () => {
    expect(ead.detectExternalAgentRequest('', ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(null, ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(undefined, ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(12345, ON)).toBeNull();
  });
});

describe('externalAgentDirective — buildExternalAgentNudge', () => {
  test('delegatable 命中 → 指令用 Agent 工具 + subagent_type', () => {
    const n = ead.buildExternalAgentNudge('用 claude code 帮我修这个测试', ON);
    expect(n).toContain('[SYSTEM:外部 agent 路由]');
    expect(n).toContain("subagent_type: 'claude'");
    expect(n).toContain('自包含');
    expect(n).toContain('不要自己内联');
  });

  test('launch-only 命中 → 指令顶层 `khy <id>` 启动', () => {
    const n = ead.buildExternalAgentNudge('拉起 cursor 来做这个', ON);
    expect(n).toContain('[SYSTEM:外部 agent 路由]');
    expect(n).toContain('khy cursor');
    expect(n).not.toContain("subagent_type: 'cursor'"); // enum 不含 cursor,不能误导
  });

  test('未命中 → 返空', () => {
    expect(ead.buildExternalAgentNudge('claude code 是什么', ON)).toBe('');
    expect(ead.buildExternalAgentNudge('随便聊聊', ON)).toBe('');
  });

  test('门关 → 返空(逐字节回退)', () => {
    expect(ead.buildExternalAgentNudge('用 claude code 帮我修', OFF_NUDGE)).toBe('');
  });
});

describe('externalAgentDirective — 注册表契约', () => {
  test('EXTERNAL_AGENTS 冻结,delegatable 项 id 与 AgentTool subagent_type 枚举一致', () => {
    expect(Object.isFrozen(ead.EXTERNAL_AGENTS)).toBe(true);
    const delegatableIds = ead.EXTERNAL_AGENTS.filter((a) => a.delegatable).map((a) => a.id).sort();
    expect(delegatableIds).toEqual(['claude', 'codex', 'opencode']);
  });
});
