'use strict';

/**
 * externalAgentDirective.test.js �?纯叶子测�?
 *   �?能力指令始终注入(门开)/ 父子门控逐字节回退(门关)�? *   �?确定�?NL 识别:点名 + 驱动动词两命中才接管;零假阳�?子串不误命中�? *   �?delegatable vs launch-only �?nudge 分支�? *   �?fail-soft:异常/空输入返中性�?绝不抛�? */

const ead = require('../externalAgentDirective');

const ON = {}; // �?env �?默认 on(default-on 门控)
const OFF_DIRECTIVE = { KHY_EXTERNAL_AGENT_DIRECTIVE: '0' };
const OFF_NUDGE = { KHY_EXTERNAL_AGENT_NUDGE: 'off' };
const OFF_PARENT = { KHY_WEAK_MODEL_GUIDANCE: 'false' };

describe('externalAgentDirective �?门控', () => {
  test('默认 on:能力指令�?nudge 均启�?, () => {
    expect(ead.isExternalAgentDirectiveEnabled(ON)).toBe(true);
    expect(ead.isExternalAgentNudgeEnabled(ON)).toBe(true);
  });

  test('子门�?�?该面回退,另一面不受影�?, () => {
    expect(ead.isExternalAgentDirectiveEnabled(OFF_DIRECTIVE)).toBe(false);
    expect(ead.isExternalAgentNudgeEnabled(OFF_NUDGE)).toBe(false);
  });

  test('父门 KHY_WEAK_MODEL_GUIDANCE �?�?能力指令必关(父→�?', () => {
    expect(ead.isExternalAgentDirectiveEnabled(OFF_PARENT)).toBe(false);
  });
});

describe('externalAgentDirective �?buildExternalAgentDirective', () => {
  test('门开:注入含三�?delegatable subagent_type 与顶层启动项', () => {
    const d = ead.buildExternalAgentDirective(ON);
    expect(d).toContain('驱动其它 agent');
    expect(d).toContain("subagent_type: 'claude'");
    expect(d).toContain("subagent_type: 'codex'");
    expect(d).toContain("subagent_type: 'opencode'");
    expect(d).toContain('自包�?); // 委派要点:prompt 自包�?    expect(d).toContain('khy cursor'); // launch-only 顶层命令
  });

  test('门关(directive 子门)�?返空(逐字节回退)', () => {
    expect(ead.buildExternalAgentDirective(OFF_DIRECTIVE)).toBe('');
  });

  test('父门�?�?返空', () => {
    expect(ead.buildExternalAgentDirective(OFF_PARENT)).toBe('');
  });
});

describe('externalAgentDirective �?detectExternalAgentRequest', () => {
  test('点名 + 驱动动词 �?命中(claude,delegatable)', () => {
    const hit = ead.detectExternalAgentRequest('�?claude code 帮我重构这个模块', ON);
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
    const hit = ead.detectExternalAgentRequest('�?opencode 改这�?bug', ON);
    expect(hit && hit.id).toBe('opencode');
  });

  test('launch-only:「切换到 cursor」→ 命中�?delegatable=false', () => {
    const hit = ead.detectExternalAgentRequest('切换�?cursor 来做', ON);
    expect(hit).not.toBeNull();
    expect(hit.id).toBe('cursor');
    expect(hit.delegatable).toBe(false);
  });

  test('无驱动动�?�?不接�?仅提�?agent �?', () => {
    expect(ead.detectExternalAgentRequest('claude code 是什�?', ON)).toBeNull();
    expect(ead.detectExternalAgentRequest('codex 的价格如�?, ON)).toBeNull();
  });

  test('子串不误命中:"clause"/"cursor position" 类不触发', () => {
    // "clause" 含子串但前后是字�?�?不命�?claude
    expect(ead.detectExternalAgentRequest('请解释这�?license clause', ON)).toBeNull();
    // "cursor" 是词但无驱动动词
    expect(ead.detectExternalAgentRequest('�?cursor 移到行尾', ON)).toBeNull();
  });

  test('�?agent 同现:按注册表顺序取第一�?delegatable 靠前)', () => {
    const hit = ead.detectExternalAgentRequest('�?codex 还是 cursor?�?codex 来吧', ON);
    expect(hit && hit.id).toBe('codex');
  });

  test('门关(nudge 子门)�?恒返 null', () => {
    expect(ead.detectExternalAgentRequest('�?claude code 帮我重构', OFF_NUDGE)).toBeNull();
  });

  test('父门(directive)�?�?nudge 子门必关 �?�?null', () => {
    expect(ead.detectExternalAgentRequest('�?claude code 帮我重构', OFF_DIRECTIVE)).toBeNull();
  });

  test('�?异常输入 �?null,绝不�?, () => {
    expect(ead.detectExternalAgentRequest('', ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(null, ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(undefined, ON)).toBeNull();
    expect(ead.detectExternalAgentRequest(12345, ON)).toBeNull();
  });
});

describe('externalAgentDirective �?buildExternalAgentNudge', () => {
  test('delegatable 命中 �?指令�?Agent 工具 + subagent_type', () => {
    const n = ead.buildExternalAgentNudge('�?claude code 帮我修这个测�?, ON);
    expect(n).toContain('[SYSTEM:外部 agent 路由]');
    expect(n).toContain("subagent_type: 'claude'");
    expect(n).toContain('自包�?);
    expect(n).toContain('不要自己内联');
  });

  test('launch-only 命中 �?指令顶层 `khy <id>` 启动', () => {
    const n = ead.buildExternalAgentNudge('拉起 cursor 来做这个', ON);
    expect(n).toContain('[SYSTEM:外部 agent 路由]');
    expect(n).toContain('khy cursor');
    expect(n).not.toContain("subagent_type: 'cursor'"); // enum 不含 cursor,不能误导
  });

  test('未命�?�?返空', () => {
    expect(ead.buildExternalAgentNudge('claude code 是什�?, ON)).toBe('');
    expect(ead.buildExternalAgentNudge('随便聊聊', ON)).toBe('');
  });

  test('门关 �?返空(逐字节回退)', () => {
    expect(ead.buildExternalAgentNudge('�?claude code 帮我�?, OFF_NUDGE)).toBe('');
  });
});

describe('externalAgentDirective �?注册表契�?, () => {
  test('EXTERNAL_AGENTS 冻结,delegatable �?id �?AgentTool subagent_type 枚举一�?, () => {
    expect(Object.isFrozen(ead.EXTERNAL_AGENTS)).toBe(true);
    const delegatableIds = ead.EXTERNAL_AGENTS.filter((a) => a.delegatable)
      .map((a) => a.id)
      .sort();
    expect(delegatableIds).toEqual(['claude', 'codex', 'opencode']);
  });
});

