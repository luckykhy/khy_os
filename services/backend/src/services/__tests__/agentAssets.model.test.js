'use strict';

/**
 * agentAssets.model.test.js — 统一资产模型(纯叶子)与注册表的契约测试。
 *
 * 覆盖:三类资产的校验(合法 + 每条拒绝理由)、身份、内容哈希的「该敏感的敏感/该
 * 无视的无视」、凭据脱敏(键名命中 / 值形态命中 / 嵌套与数组路径)、脱敏还原、
 * 冲突判定四态、冲突副本命名的确定性与幂等、门控,以及**注册表零厂商逻辑**
 * (验收标准 2:新增一家只需加一个适配器文件 + 表里加一行)。
 *
 * 零磁盘依赖:全部对纯叶子直接断言,不碰任何外部工具目录。
 */

const M = require('../domain/agents/agentAssets/assetModel');
const registry = require('../domain/agents/agentAssets/registry');

const baseMemory = {
  id: 'project-conventions',
  scope: 'project',
  title: '项目约定',
  content: '提交信息用 Conventional Commits。\n',
  tags: ['project'],
  source: { tool: 'opencode', path: 'memory/project-conventions.md' },
  updatedAt: '2026-08-20T10:00:00.000Z',
};

const baseTool = {
  name: 'filesystem',
  kind: 'mcp_server',
  description: '本地文件访问',
  spec: { type: 'local', command: ['npx', 'mcp-server-filesystem'] },
  source: { tool: 'opencode', path: 'opencode.json' },
};

const baseSkill = {
  name: 'code-review',
  description: '评审当前 diff',
  entry: 'SKILL.md',
  files: ['reference.md'],
  contents: { 'SKILL.md': '# code-review\n', 'reference.md': 'ref\n' },
  metadata: { name: 'code-review' },
  source: { tool: 'claude-code', path: 'skills/code-review' },
};

describe('门控 KHY_AGENT_ASSETS', () => {
  test('默认开;仅 0/false/off/no(含大小写与空白)关', () => {
    expect(M.isEnabled({})).toBe(true);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: '1' })).toBe(true);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: 'on' })).toBe(true);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: '0' })).toBe(false);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: 'false' })).toBe(false);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: ' OFF ' })).toBe(false);
    expect(M.isEnabled({ KHY_AGENT_ASSETS: 'No' })).toBe(false);
  });

  test('门关时注册表返空、解析明确拒绝(不抛)', () => {
    const off = { KHY_AGENT_ASSETS: 'off' };
    expect(registry.listSourceIds(off)).toEqual([]);
    const res = registry.resolveAdapter('opencode', off);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/门控/);
  });
});

describe('validateAsset:memory', () => {
  test('合法输入 → 归一化后字段齐全', () => {
    const r = M.validateAsset('memory', baseMemory);
    expect(r.ok).toBe(true);
    expect(r.asset.kind).toBe('memory');
    expect(r.asset.scope).toBe('project');
    expect(r.asset.title).toBe('项目约定');
    expect(r.asset.tags).toEqual(['project']);
    expect(r.asset.source.tool).toBe('opencode');
    expect(r.asset.updatedAt).toBe('2026-08-20T10:00:00.000Z');
  });

  test('scope 缺省为 project;非法 scope 被拒并说明允许值', () => {
    expect(M.validateAsset('memory', { ...baseMemory, scope: undefined }).asset.scope).toBe('project');
    const bad = M.validateAsset('memory', { ...baseMemory, scope: 'team' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/global/);
  });

  test('id 空 / content 非字符串 → 拒绝并说明是哪个字段', () => {
    expect(M.validateAsset('memory', { ...baseMemory, id: '  ' }).error).toMatch(/memory\.id/);
    expect(M.validateAsset('memory', { ...baseMemory, content: 42 }).error).toMatch(/memory\.content/);
  });

  test('tags 去空去重保序;非数组 → 空数组', () => {
    const r = M.validateAsset('memory', { ...baseMemory, tags: ['a', '', 'a', ' b '] });
    expect(r.asset.tags).toEqual(['a', 'b']);
    expect(M.validateAsset('memory', { ...baseMemory, tags: 'a' }).asset.tags).toEqual([]);
  });

  test('无法解析的 updatedAt → 空串(而非 Invalid Date)', () => {
    expect(M.validateAsset('memory', { ...baseMemory, updatedAt: 'not-a-date' }).asset.updatedAt).toBe('');
  });
});

describe('validateAsset:tool / skill', () => {
  test('tool 合法 → toolKind 归位、spec 原样保留', () => {
    const r = M.validateAsset('tool', baseTool);
    expect(r.ok).toBe(true);
    expect(r.asset.toolKind).toBe('mcp_server');
    expect(r.asset.spec).toEqual(baseTool.spec);
  });

  test('tool.kind 必须在三类之内;spec 必须是对象', () => {
    expect(M.validateAsset('tool', { ...baseTool, kind: 'weird' }).error).toMatch(/mcp_server/);
    expect(M.validateAsset('tool', { ...baseTool, kind: '' }).error).toMatch(/tool\.kind/);
    expect(M.validateAsset('tool', { ...baseTool, spec: 'x' }).error).toMatch(/tool\.spec/);
  });

  test('校验幂等:IR 资产再喂回 validateAsset 仍然合法(三类都要)', () => {
    // 每个 writeAsset 入口都会先 validateAsset 一次。若 IR 形态过不了自己的校验,
    // 「读出来再写回去」这条主链路直接断掉——tool 曾因 kind/toolKind 错位踩过。
    for (const [kind, input] of [
      ['memory', baseMemory],
      ['tool', baseTool],
      ['skill', baseSkill],
    ]) {
      const once = M.validateAsset(kind, input);
      expect(once.ok).toBe(true);
      const twice = M.validateAsset(kind, once.asset);
      expect(twice.ok).toBe(true);
      expect(twice.asset).toEqual(once.asset);
      expect(M.contentHash(twice.asset)).toBe(M.contentHash(once.asset));
    }
  });

  test('skill 合法;name/entry 缺失被拒', () => {
    const r = M.validateAsset('skill', baseSkill);
    expect(r.ok).toBe(true);
    expect(r.asset.entry).toBe('SKILL.md');
    expect(M.validateAsset('skill', { ...baseSkill, name: '' }).error).toMatch(/skill\.name/);
    expect(M.validateAsset('skill', { ...baseSkill, entry: '' }).error).toMatch(/skill\.entry/);
  });

  test('未知 kind → 拒绝并列出合法类型;坏输入不抛', () => {
    expect(M.validateAsset('agent', {}).error).toMatch(/memory\/tool\/skill/);
    expect(M.validateAsset('memory', null).ok).toBe(false);
    expect(M.validateAsset('', undefined).ok).toBe(false);
  });
});

describe('assetIdentity 与 contentHash', () => {
  test('memory 身份含 scope;tool/skill 身份是 name', () => {
    expect(M.assetIdentity(M.validateAsset('memory', baseMemory).asset)).toBe('project:project-conventions');
    expect(M.assetIdentity(M.validateAsset('tool', baseTool).asset)).toBe('filesystem');
    expect(M.assetIdentity(M.validateAsset('skill', baseSkill).asset)).toBe('code-review');
    expect(M.assetIdentity(null)).toBe('');
  });

  test('哈希无视 source / updatedAt / raw —— 否则一搬家就永远判冲突', () => {
    const a = M.validateAsset('memory', baseMemory).asset;
    const moved = M.validateAsset('memory', {
      ...baseMemory,
      source: { tool: 'claude-code', path: 'projects/x/memory/project-conventions.md' },
      updatedAt: '2026-01-01T00:00:00.000Z',
      raw: { frontmatterText: 'name: whatever' },
    }).asset;
    expect(M.contentHash(moved)).toBe(M.contentHash(a));
  });

  test('哈希对正文/标题/标签敏感', () => {
    const a = M.validateAsset('memory', baseMemory).asset;
    for (const patch of [{ content: 'x' }, { title: 'x' }, { tags: ['z'] }]) {
      const b = M.validateAsset('memory', { ...baseMemory, ...patch }).asset;
      expect(M.contentHash(b)).not.toBe(M.contentHash(a));
    }
  });

  test('哈希与键序无关(不同工具写出的 JSON 键序不同)', () => {
    const one = M.validateAsset('tool', { ...baseTool, spec: { a: 1, b: 2 } }).asset;
    const two = M.validateAsset('tool', { ...baseTool, spec: { b: 2, a: 1 } }).asset;
    expect(M.contentHash(two)).toBe(M.contentHash(one));
  });

  test('哈希无视「被提升字段回落进 spec」—— 否则 khy 侧写一次就永远判冲突', () => {
    // khy 的 tools.json 是映射形态,写回时把 IR 的一等字段 kind/description 物化进
    // 条目里;再读出来时它们又被提升成一等字段,spec 就比源侧多出这两个键。
    // 这是表示层产物而非内容差异,不剥掉的话「导入 → 再同步」必然凭空报冲突。
    const source = M.validateAsset('tool', baseTool).asset;
    const roundTripped = M.validateAsset('tool', {
      ...baseTool,
      spec: { ...baseTool.spec, kind: 'mcp_server', description: '本地文件访问' },
      source: { tool: 'khy-os', path: 'tools.json', format: 'json:map' },
    }).asset;
    expect(M.contentHash(roundTripped)).toBe(M.contentHash(source));
  });

  test('哈希无视被抹掉的凭据键 —— 「抹掉」与「本来就没有」不可区分', () => {
    // 凭据从不进 IR:源侧留下 REDACTED 占位,目标侧因为没有对应现值而整键删除。
    // 两侧都在出口处抹,故把 REDACTED 键排除掉是对称的——凭据干脆不参与判等。
    const withPlaceholder = M.validateAsset('tool', {
      ...baseTool,
      spec: { ...baseTool.spec, environment: { API_KEY: M.REDACTED, WORKSPACE: 'repo' } },
    }).asset;
    const withoutKey = M.validateAsset('tool', {
      ...baseTool,
      spec: { ...baseTool.spec, environment: { WORKSPACE: 'repo' } },
    }).asset;
    expect(M.contentHash(withPlaceholder)).toBe(M.contentHash(withoutKey));

    // 但非凭据字段的差异照样敏感——别把「无视」放宽成「什么都不看」。
    const otherWorkspace = M.validateAsset('tool', {
      ...baseTool,
      spec: { ...baseTool.spec, environment: { WORKSPACE: 'other' } },
    }).asset;
    expect(M.contentHash(otherWorkspace)).not.toBe(M.contentHash(withoutKey));
  });

  test('哈希无视技能的落盘形态 —— 目录型 SKILL.md 与单文件型 <name>.md 同正文即同内容', () => {
    const body = '---\nname: deploy\ndescription: 发布流程\n---\n按 checklist 逐项确认。\n';
    const dirForm = M.validateAsset('skill', {
      name: 'deploy',
      description: '发布流程',
      entry: 'SKILL.md',
      files: [],
      contents: { 'SKILL.md': body },
      metadata: { name: 'deploy', description: '发布流程' },
      source: { tool: 'opencode', path: 'skill/deploy', format: 'dir:SKILL.md' },
    }).asset;
    const fileForm = M.validateAsset('skill', {
      name: 'deploy',
      description: '发布流程',
      entry: 'deploy.md',
      files: [],
      contents: { 'deploy.md': body },
      metadata: { name: 'deploy', description: '发布流程' },
      source: { tool: 'khy-os', path: 'skills/deploy.md', format: 'file:md' },
    }).asset;
    expect(M.contentHash(fileForm)).toBe(M.contentHash(dirForm));

    // 附属资源仍按文件名逐一入哈希:主文件名是布局,附属资源是内容。
    const withExtra = M.validateAsset('skill', {
      name: 'deploy',
      description: '发布流程',
      entry: 'SKILL.md',
      files: ['checklist.md'],
      contents: { 'SKILL.md': body, 'checklist.md': '1. 跑质量门\n' },
      metadata: { name: 'deploy', description: '发布流程' },
      source: { tool: 'opencode', path: 'skill/deploy', format: 'dir:SKILL.md' },
    }).asset;
    expect(M.contentHash(withExtra)).not.toBe(M.contentHash(dirForm));
  });

  test('坏输入返空串,不抛', () => {
    expect(M.contentHash(null)).toBe('');
    expect(M.contentHash({ kind: 'nope' })).toBe('');
  });
});

describe('凭据脱敏', () => {
  test('键名命中(含大小写、连字符、下划线变体)', () => {
    for (const key of ['apiKey', 'API_KEY', 'access-key', 'clientSecret', 'password', 'AUTH_TOKEN', 'Cookie']) {
      expect(M.isCredentialKey(key)).toBe(true);
    }
    for (const key of ['command', 'baseURL', 'model', 'description', 'name']) {
      expect(M.isCredentialKey(key)).toBe(false);
    }
  });

  test('嵌套对象/数组里的凭据键被抹,路径被记录', () => {
    const r = M.redactCredentials(
      { type: 'local', env: { API_KEY: 'sk-real-value-123456', PATH: '/usr/bin' }, args: [{ token: 't-abcdefghij' }] },
      { pathPrefix: 'spec' }
    );
    expect(r.value.env.API_KEY).toBe(M.REDACTED);
    expect(r.value.env.PATH).toBe('/usr/bin');
    expect(r.value.args[0].token).toBe(M.REDACTED);
    expect(r.redactedFields).toContain('spec.env.API_KEY');
    expect(r.redactedFields).toContain('spec.args[0].token');
  });

  test('键名无辜但值长得像密钥的也被抹(sk-proj- 多段现代 key / JWT)', () => {
    const r = M.redactCredentials({ note: 'sk-proj-abcdefghijklmnop', plain: 'hello world' });
    expect(r.value.note).toBe(M.REDACTED);
    expect(r.value.plain).toBe('hello world');
    expect(r.redactedFields).toEqual(['note']);
  });

  test('无凭据 → 原样返回且 redactedFields 为空', () => {
    const input = { type: 'remote', transport: 'sse', enabled: true };
    const r = M.redactCredentials(input);
    expect(r.value).toEqual(input);
    expect(r.redactedFields).toEqual([]);
  });
});

describe('restoreRedacted:回写时用目标侧现值填回,绝不写占位符', () => {
  test('目标侧有真值 → 填回真值', () => {
    const incoming = { env: { API_KEY: M.REDACTED, PATH: '/new' } };
    const existing = { env: { API_KEY: 'sk-target-real-000000', PATH: '/old' } };
    const out = M.restoreRedacted(incoming, existing, ['env.API_KEY']);
    expect(out.env.API_KEY).toBe('sk-target-real-000000');
    expect(out.env.PATH).toBe('/new');
  });

  test('目标侧没有该路径 → 整键删掉(而不是留下占位符)', () => {
    const out = M.restoreRedacted({ env: { API_KEY: M.REDACTED, PATH: '/x' } }, {}, ['env.API_KEY']);
    expect('API_KEY' in out.env).toBe(false);
    expect(out.env.PATH).toBe('/x');
  });

  test('数组下标路径也能还原', () => {
    const out = M.restoreRedacted(
      { args: [{ token: M.REDACTED }] },
      { args: [{ token: 'real-token' }] },
      ['args[0].token']
    );
    expect(out.args[0].token).toBe('real-token');
  });

  test('redactedFields 为空 → 结构等价复制;坏路径被忽略不抛', () => {
    const input = { a: 1 };
    expect(M.restoreRedacted(input, {}, [])).toEqual(input);
    expect(M.restoreRedacted(input, {}, ['nope.deep.path'])).toEqual(input);
  });
});

describe('decideSync:四态判定,绝不返回「覆盖」', () => {
  const local = M.validateAsset('memory', baseMemory).asset;

  test('目标侧不存在 → create', () => {
    const d = M.decideSync(local, null);
    expect(d.action).toBe('create');
  });

  test('内容哈希一致 → in-sync', () => {
    const same = M.validateAsset('memory', { ...baseMemory, source: { tool: 'khy-os', path: 'memory/x.md' } }).asset;
    expect(M.decideSync(local, same).action).toBe('in-sync');
  });

  test('同名不同内容 → conflict,且用 updatedAt 报出谁更新', () => {
    const older = M.validateAsset('memory', {
      ...baseMemory,
      content: '旧内容\n',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }).asset;
    const d = M.decideSync(local, older);
    expect(d.action).toBe('conflict');
    expect(d.newer).toBe('source');
    expect(d.reason).toMatch(/保留双方/);
  });

  test('两侧时间戳不可比 → 仍是 conflict,newer=unknown', () => {
    const noTime = M.validateAsset('memory', { ...baseMemory, content: '别的\n', updatedAt: '' }).asset;
    const d = M.decideSync(M.validateAsset('memory', { ...baseMemory, updatedAt: '' }).asset, noTime);
    expect(d.action).toBe('conflict');
    expect(d.newer).toBe('unknown');
  });

  test('仅目标侧存在 → noop(本方向不动它);两侧皆空 → noop', () => {
    expect(M.decideSync(null, local).action).toBe('noop');
    expect(M.decideSync(null, null).action).toBe('noop');
  });
});

describe('冲突副本命名:确定性 + 幂等', () => {
  test('同一份冲突内容永远得到同一个名字(内嵌哈希前 8 位,不用时间戳)', () => {
    const hash = 'a'.repeat(64);
    const first = M.conflictCopyName('project-conventions', 'opencode', hash);
    const second = M.conflictCopyName('project-conventions', 'opencode', hash);
    expect(first).toBe(second);
    expect(first).toBe('project-conventions.conflict-opencode-aaaaaaaa');
  });

  test('内容不同 → 名字不同;工具 id 被规整成小写连字符', () => {
    expect(M.conflictCopyName('x', 'Claude Code', 'bbbbbbbbbb')).toBe('x.conflict-claude-code-bbbbbbbb');
    expect(M.conflictCopyName('x', 'opencode', 'c'.repeat(8))).not.toBe(
      M.conflictCopyName('x', 'opencode', 'd'.repeat(8))
    );
  });

  test('文件名形态:后缀插在扩展名之前,目录部分保留', () => {
    expect(M.conflictCopyPath('memory/notes.md', 'opencode', 'e'.repeat(8))).toBe(
      'memory/notes.conflict-opencode-eeeeeeee.md'
    );
    expect(M.conflictCopyPath('', 'opencode', 'x')).toBe('');
  });
});

describe('注册表:零厂商专属逻辑(验收标准 2)', () => {
  test('表项只有 id/label/module —— 不含任何「支持哪几类资产 / 能不能写」的厂商知识', () => {
    for (const entry of registry.AGENT_ASSET_SOURCES) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'label', 'module']);
    }
  });

  test('每一家都能解析出适配器,且都实现完整契约(七个方法)', () => {
    const contract = [
      'detect',
      'capabilities',
      'listMemories',
      'listTools',
      'listSkills',
      'readAsset',
      'writeAsset',
      'removeAsset',
    ];
    for (const id of registry.listSourceIds({})) {
      const r = registry.resolveAdapter(id, {});
      expect(r.ok).toBe(true);
      for (const fn of contract) {
        expect(typeof r.adapter[fn]).toBe('function');
      }
    }
  });

  test('未注册的 id → 明确报错并列出已注册的家数', () => {
    const r = registry.resolveAdapter('cursor', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/opencode/);
  });

  test('describeSources:本机没装的工具只标记未检测到,不让整条链路失败', () => {
    const d = registry.describeSources({ KHY_AGENT_ASSETS_OPENCODE_ROOT: '', HOME: '' });
    expect(d.ok).toBe(true);
    expect(d.sources.length).toBe(registry.AGENT_ASSET_SOURCES.length);
    for (const s of d.sources) {
      expect(typeof s.detected).toBe('boolean');
      if (!s.detected) {
        expect(s.error).toMatch(/已查找|环境变量/);
      }
    }
  });
});
