'use strict';

/**
 * agentCardSpec — 标准 A2A Agent Card 构造的回归锁。
 *
 * 这些断言针对的都是**历史上真实出过的问题**（见审计 A3/A6）：
 *   - 卡片字段不符规范（`authentication.schemes` 不是 A2A 字段）
 *   - 能力虚报（`streaming: true` 而零 SSE 实现）
 *   - Part 缺 `kind` 判别字段
 * 因此这里的"应当为 false / 应当被拒"不是洁癖，是防止旧缺陷复活。
 */

const spec = require('../../../src/services/a2a/agentCardSpec');

describe('agentCardSpec — 常量', () => {
  test('协议版本为 0.3.0，且 well-known 路径符合 RFC 8615', () => {
    expect(spec.A2A_PROTOCOL_VERSION).toBe('0.3.0');
    expect(spec.AGENT_CARD_WELL_KNOWN_PATH).toBe('/.well-known/agent-card.json');
  });

  test('方法名使用 A2A v0.3.0 的斜杠形式，而非私有 ACP 的点分形式', () => {
    expect(spec.A2A_METHODS.SEND_MESSAGE).toBe('message/send');
    expect(spec.A2A_METHODS.GET_TASK).toBe('tasks/get');
    expect(spec.A2A_METHODS.CANCEL_TASK).toBe('tasks/cancel');
    // 私有方言不得出现在这里
    for (const m of Object.values(spec.A2A_METHODS)) {
      expect(m).not.toMatch(/^a2a\./);
    }
  });

  test('错误码落在 JSON-RPC 实现级区间 -32000 ~ -32099 内', () => {
    for (const code of Object.values(spec.A2A_ERROR_CODES)) {
      expect(code).toBeGreaterThanOrEqual(-32099);
      expect(code).toBeLessThanOrEqual(-32000);
    }
  });
});

describe('agentCardSpec — 能力诚实性', () => {
  test('未实现的能力必须为 false（当前 streaming / pushNotifications / stateTransitionHistory 都未实现）', () => {
    expect(spec.IMPLEMENTED_CAPABILITIES).toEqual({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
  });

  test('构造出的卡片默认沿用真实能力，不因调用方沉默而虚报', () => {
    const { card } = spec.buildAgentCard({ baseUrl: 'http://127.0.0.1:3000' });
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(false);
  });

  test('只有显式传 capabilities 才可覆盖（供已经真的实现了的调用方使用）', () => {
    const { card } = spec.buildAgentCard({
      baseUrl: 'http://127.0.0.1:3000',
      capabilities: { streaming: true },
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
  });
});

describe('agentCardSpec — buildAgentCard', () => {
  test('产出规范必填字段齐全的卡片', () => {
    const { card, warnings } = spec.buildAgentCard({
      baseUrl: 'http://127.0.0.1:3000',
      version: '1.2.3',
      name: 'khy-os',
      description: 'd',
      skills: ['technical_analysis'],
      provider: { organization: 'khy-os', url: 'https://example.invalid' },
    });
    expect(warnings).toEqual([]);
    expect(card).toMatchObject({
      protocolVersion: '0.3.0',
      name: 'khy-os',
      url: 'http://127.0.0.1:3000',
      version: '1.2.3',
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    });
    expect(card.provider).toEqual({ organization: 'khy-os', url: 'https://example.invalid' });
    expect(spec.validateCardShape(card).ok).toBe(true);
  });

  test('url 去掉尾斜杠（规范要求不带）', () => {
    const { card } = spec.buildAgentCard({ baseUrl: 'http://127.0.0.1:3000///' });
    expect(card.url).toBe('http://127.0.0.1:3000');
  });

  test('缺 baseUrl 时告警而不抛，且不编造真实域名', () => {
    const { card, warnings } = spec.buildAgentCard({});
    expect(warnings.some((w) => w.includes('baseUrl'))).toBe(true);
    expect(card.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  test('skills 为空时告警，但卡片仍合法（不阻断发现）', () => {
    const { card, warnings } = spec.buildAgentCard({ baseUrl: 'http://127.0.0.1:3000' });
    expect(warnings.some((w) => w.includes('skills'))).toBe(true);
    expect(card.skills).toEqual([]);
    expect(spec.validateCardShape(card).ok).toBe(true);
  });

  test('绝不抛：畸形输入退化为安全默认', () => {
    for (const bad of [null, undefined, 42, 'nope', { skills: 'not-array' }, { baseUrl: {} }]) {
      expect(() => spec.buildAgentCard(bad)).not.toThrow();
    }
  });

  test('确定性：同样输入必得同样输出', () => {
    const input = { baseUrl: 'http://127.0.0.1:3000', skills: ['a', 'b'] };
    expect(JSON.stringify(spec.buildAgentCard(input))).toBe(
      JSON.stringify(spec.buildAgentCard(input))
    );
  });
});

describe('agentCardSpec — normalizeBaseUrl', () => {
  test('补 scheme、去尾斜杠、拒绝非 http(s)', () => {
    expect(spec.normalizeBaseUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(spec.normalizeBaseUrl('https://a.example/')).toBe('https://a.example');
    expect(spec.normalizeBaseUrl('ftp://a.example')).toBeNull();
    expect(spec.normalizeBaseUrl('')).toBeNull();
    expect(spec.normalizeBaseUrl(null)).toBeNull();
  });
});

describe('agentCardSpec — skills 归一', () => {
  test('字符串能力 → 规范 AgentSkill（四项必填齐全）', () => {
    const s = spec.skillFromCapability('technical_analysis');
    expect(s.id).toBe('technical_analysis');
    expect(s.name).toBe('Technical Analysis');
    expect(s.tags).toEqual(['technical', 'analysis']);
    expect(typeof s.description).toBe('string');
    expect(s.description.length).toBeGreaterThan(0);
  });

  test('对象形式的技能被接受，缺 description 时补默认值而不是丢弃', () => {
    const list = spec.normalizeSkills([{ id: 'x', name: 'X' }]);
    expect(list).toHaveLength(1);
    expect(list[0].description.length).toBeGreaterThan(0);
    expect(list[0].tags).toEqual(['x']);
  });

  test('非法项被丢弃，同 id 去重（后者覆盖前者）', () => {
    const list = spec.normalizeSkills(['a', null, 7, { name: '' }, { id: 'a', name: 'A2' }]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('A2');
  });

  test('非数组输入 → 空数组，不抛', () => {
    expect(spec.normalizeSkills(undefined)).toEqual([]);
    expect(spec.normalizeSkills('x')).toEqual([]);
  });
});

describe('agentCardSpec — validateCardShape', () => {
  const base = () =>
    spec.buildAgentCard({ baseUrl: 'http://127.0.0.1:3000', skills: ['a'] }).card;

  test('正常卡片通过', () => {
    expect(spec.validateCardShape(base()).ok).toBe(true);
  });

  test('缺必填字段被点名', () => {
    const c = base();
    delete c.protocolVersion;
    const r = spec.validateCardShape(c);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('protocolVersion');
  });

  test('protocolVersion 非 semver 形被拒', () => {
    const c = base();
    c.protocolVersion = 'latest';
    expect(spec.validateCardShape(c).ok).toBe(false);
  });

  test('url 带尾斜杠被拒', () => {
    const c = base();
    c.url = 'http://127.0.0.1:3000/';
    expect(spec.validateCardShape(c).ok).toBe(false);
  });

  test('声明 security 却没有 securitySchemes → 悬空引用被拒', () => {
    const c = base();
    c.security = [{ bearer: [] }];
    expect(spec.validateCardShape(c).errors.join(' ')).toContain('securitySchemes');
  });

  test('skill 缺 tags 被拒', () => {
    const c = base();
    c.skills = [{ id: 'a', name: 'A', description: 'd' }];
    expect(spec.validateCardShape(c).ok).toBe(false);
  });

  test('非对象输入 → ok:false 而非抛', () => {
    expect(spec.validateCardShape(null).ok).toBe(false);
    expect(() => spec.validateCardShape(undefined)).not.toThrow();
  });
});

describe('agentCardSpec — 发布门控', () => {
  test('默认开；显式 falsy 才关（4 词 CANON）', () => {
    expect(spec.isPublishEnabled({})).toBe(true);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: '0' })).toBe(false);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: 'false' })).toBe(false);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: 'off' })).toBe(false);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: 'no' })).toBe(false);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: '1' })).toBe(true);
    expect(spec.isPublishEnabled({ KHY_A2A_ENABLED: 'yes' })).toBe(true);
  });
});
