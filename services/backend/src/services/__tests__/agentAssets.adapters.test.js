'use strict';

/**
 * agentAssets.adapters.test.js — 四个适配器与编排层的落盘行为测试。
 *
 * 全部用系统临时目录里**假造**的外部工具资产树 + KHY_AGENT_ASSETS_*_ROOT 覆盖变量,
 * 不依赖本机是否真装了 opencode / Claude Code(CI 上一台都不会装)。
 *
 * 覆盖:三类资产读取、native → IR → native **逐字节**无损往返、凭据在适配器出口脱敏
 * 且回写时用目标侧现值填回、干跑默认不落盘、同名冲突保留双方且副本名幂等、
 * 「缺失能力显式声明不支持」而非抛异常、路径探测失败时报清「找了哪些位置」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeCode = require('../agentAssets/adapters/claudeCode');
const dsh = require('../agentAssets/adapters/deepseekHarness');
const harness = require('../agentAssets/adapters/harness');
const khyOs = require('../agentAssets/adapters/khyOs');
const openclaw = require('../agentAssets/adapters/openclaw');
const opencode = require('../agentAssets/adapters/opencode');
const M = require('../agentAssets/assetModel');
const registry = require('../agentAssets/registry');
const sync = require('../agentAssets/sync');

// ── 临时资产树工具 ──────────────────────────────────────────────────────

const _tmpRoots = [];

function mkRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-agent-assets-${tag}-`));
  _tmpRoots.push(root);
  return root;
}

function put(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function get(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function has(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function ls(root, rel) {
  try {
    return fs.readdirSync(path.join(root, rel)).sort();
  } catch {
    /* 目录不存在 = 什么都没落盘 */
    return [];
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

afterAll(() => {
  for (const root of _tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响断言 */
    }
  }
});

// ── 假资产树:opencode ─────────────────────────────────────────────────

/** 刻意用「明显是假的」占位值:测的是键名命中脱敏,不需要真钥匙的形状。 */
const OC_FAKE_KEY = 'sk-fixture-000000000000';

const OC_AGENTS = '# opencode 全局指令\n\n提交信息遵循 Conventional Commits。\n';

const OC_MEMORY = [
  '---',
  'name: project-conventions',
  'title: 项目约定',
  'scope: project',
  'tags: [convention, project]',
  '---',
  '分支名用 feat/<area-id>/<简述>。',
  '',
].join('\n');

const OC_CONFIG = json({
  theme: 'system',
  mcp: {
    filesystem: {
      type: 'local',
      command: ['npx', '-y', 'mcp-server-filesystem'],
      environment: { API_KEY: OC_FAKE_KEY, WORKSPACE: 'repo' },
      enabled: true,
    },
  },
});

const OC_COMMAND = [
  '---',
  'name: review',
  'description: 评审当前改动',
  '---',
  '逐个 hunk 看 diff,先看工程红线再看风格。',
  '',
].join('\n');

const OC_SKILL_ENTRY = [
  '---',
  'name: deploy',
  'description: 发布流程',
  '---',
  '按 checklist.md 逐项确认。',
  '',
].join('\n');

const OC_SKILL_EXTRA = '1. 跑质量门\n2. 同步版本号\n';

function seedOpencode() {
  const root = mkRoot('opencode');
  put(root, 'AGENTS.md', OC_AGENTS);
  put(root, 'memory/project-conventions.md', OC_MEMORY);
  put(root, 'opencode.json', OC_CONFIG);
  put(root, 'command/review.md', OC_COMMAND);
  put(root, 'skill/deploy/SKILL.md', OC_SKILL_ENTRY);
  put(root, 'skill/deploy/checklist.md', OC_SKILL_EXTRA);
  return root;
}

// ── 假资产树:Claude Code ──────────────────────────────────────────────

const CC_PROJECT = 'demo-project';
const CC_FAKE_TOKEN = 'ghp_fixture0000000000000';

const CC_GLOBAL = '# 全局指令\n\n回复语言跟随提问语言。\n';

const CC_MEMORY = [
  '---',
  'name: team-convention',
  'description: 团队约定',
  'metadata:',
  '  type: project',
  '---',
  '合并前先 rebase 再推。',
  '',
].join('\n');

const CC_INDEX = '# Memory Index\n\n- [team-convention](team-convention.md) — 团队约定\n';

const CC_SETTINGS = json({
  theme: 'dark',
  mcpServers: {
    github: {
      command: 'npx',
      args: ['-y', 'mcp-server-github'],
      env: { GITHUB_TOKEN: CC_FAKE_TOKEN, GITHUB_ORG: 'khy' },
    },
  },
});

const CC_SKILL_ENTRY = ['---', 'name: code-review', 'description: 评审 diff', '---', '先看红线。', ''].join(
  '\n'
);

function seedClaudeCode() {
  const root = mkRoot('claude');
  put(root, 'CLAUDE.md', CC_GLOBAL);
  put(root, `projects/${CC_PROJECT}/memory/MEMORY.md`, CC_INDEX);
  put(root, `projects/${CC_PROJECT}/memory/team-convention.md`, CC_MEMORY);
  put(root, 'settings.json', CC_SETTINGS);
  put(root, 'skills/code-review/SKILL.md', CC_SKILL_ENTRY);
  put(root, 'skills/code-review/checklist.md', '- [ ] 红线\n');
  return root;
}

function claudeEnv(root) {
  return {
    KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: root,
    KHY_AGENT_ASSETS_CLAUDE_PROJECT: CC_PROJECT,
  };
}

// ── 假资产树:harness ──────────────────────────────────────────────────

const HARNESS_TOOLS = json([
  { name: 'ripgrep', kind: 'command', command: 'rg' },
  { name: 'fetch', type: 'mcp', transport: 'stdio' },
]);

function seedHarness() {
  const root = mkRoot('harness');
  put(root, 'AGENTS.md', '# harness 指令\n\n输出要可复现。\n');
  put(root, 'memory/deploy-notes.md', '---\nid: deploy-notes\ntitle: 发布备忘\n---\n先跑质量门。\n');
  put(root, 'tools.json', HARNESS_TOOLS);
  put(root, 'skills/greet.md', '---\nname: greet\n---\n打招呼。\n');
  return root;
}

/** khy-os 侧刻意指向一个**尚不存在**的目录:验证「按需创建」而非要求预先建好。 */
function freshKhyRoot(tag) {
  return path.join(mkRoot(tag), 'store');
}

// ── 探测与降级 ──────────────────────────────────────────────────────────

describe('资产根探测:覆盖变量优先,失败要说清找过哪些位置', () => {
  test('覆盖变量命中 → via 指明是哪个变量', () => {
    const root = seedOpencode();
    const d = opencode.detect({ KHY_AGENT_ASSETS_OPENCODE_ROOT: root });
    expect(d.ok).toBe(true);
    expect(d.root).toBe(root);
    expect(d.via).toBe('env:KHY_AGENT_ASSETS_OPENCODE_ROOT');
  });

  test('本机没装 → 报错列出真实查过的目录 + 可用的覆盖变量名', () => {
    const home = mkRoot('empty-home');
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };

    const oc = opencode.detect(env);
    expect(oc.ok).toBe(false);
    expect(oc.error).toContain('已查找 1 处目录');
    expect(oc.error).toContain(path.join(home, '.config', 'opencode'));
    expect(oc.error).toContain('KHY_AGENT_ASSETS_OPENCODE_ROOT');

    const hs = harness.detect(env);
    expect(hs.ok).toBe(false);
    expect(hs.error).toContain('已查找 3 处目录');
    expect(hs.error).toContain('AGENT_HARNESS_HOME');

    const cc = claudeCode.detect(env);
    expect(cc.ok).toBe(false);
    expect(cc.error).toContain(path.join(home, '.claude'));
  });

  test('「已查找 N 处」只数真目录,没设的环境变量单独列(否则那个数字没有意义)', () => {
    const home = mkRoot('empty-home2');
    const d = harness.detect({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') });
    const dirs = d.checked.filter((c) => !String(c.location).startsWith('$'));
    const vars = d.checked.filter((c) => String(c.location).startsWith('$'));
    expect(dirs).toHaveLength(3);
    expect(vars).toHaveLength(2);
    expect(d.error).toContain('可用环境变量');
  });

  test('覆盖变量指向不存在的目录 → 硬报错,绝不静默回退到默认候选', () => {
    const xdg = mkRoot('xdg');
    put(xdg, 'opencode/AGENTS.md', OC_AGENTS);
    // 先证明默认候选本来是能命中的
    expect(opencode.detect({ XDG_CONFIG_HOME: xdg }).ok).toBe(true);

    const missing = path.join(mkRoot('missing'), 'nope');
    const d = opencode.detect({ XDG_CONFIG_HOME: xdg, KHY_AGENT_ASSETS_OPENCODE_ROOT: missing });
    expect(d.ok).toBe(false);
    expect(d.error).toContain('KHY_AGENT_ASSETS_OPENCODE_ROOT');
    expect(d.error).toContain(missing);
  });

  test('khy-os 自己的库:目录不存在也算可用,但如实回报尚未建立', () => {
    const root = freshKhyRoot('khy-detect');
    const d = khyOs.detect({ KHY_AGENT_ASSETS_LOCAL_ROOT: root });
    expect(d.ok).toBe(true);
    expect(d.established).toBe(false);
    expect(khyOs.listMemories({ KHY_AGENT_ASSETS_LOCAL_ROOT: root }).assets).toEqual([]);
  });
});

describe('能力声明:缺失的能力显式声明为不支持,而不是抛异常', () => {
  test('harness 的 tool 声明为不可写;其余三家三类全可写', () => {
    const home = mkRoot('cap-home');
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
    expect(harness.capabilities(env).kinds.tool).toMatchObject({ read: true, write: false });
    for (const adapter of [opencode, claudeCode, khyOs]) {
      const caps = adapter.capabilities(env);
      for (const kind of M.ASSET_KINDS) {
        expect(caps.kinds[kind]).toMatchObject({ read: true, write: true });
      }
    }
  });

  test('未知资产类型 → unsupported,不抛', () => {
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode() };
    expect(opencode.readAsset('agent', 'x', env)).toMatchObject({ ok: false, unsupported: true });
  });

  test('harness 写/删 tool → 明确不支持且一个字节都没动 tools.json', () => {
    const root = seedHarness();
    const env = { KHY_AGENT_ASSETS_HARNESS_ROOT: root };
    const tool = harness.listTools(env).assets[0];

    const wrote = harness.writeAsset('tool', tool, { dryRun: false }, env);
    expect(wrote).toMatchObject({ ok: false, unsupported: true });
    expect(wrote.error).toContain('未写入任何文件');

    const removed = harness.removeAsset('tool', 'ripgrep', { dryRun: false }, env);
    expect(removed).toMatchObject({ ok: false, unsupported: true });
    expect(get(root, 'tools.json')).toBe(HARNESS_TOOLS);
  });
});

// ── 无损往返 ────────────────────────────────────────────────────────────

describe('opencode:三类资产读取与无损往返', () => {
  test('记忆:带 frontmatter 与裸 markdown 写回都逐字节等价', () => {
    const root = seedOpencode();
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: root };
    const listed = opencode.listMemories(env);

    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => a.id)).toEqual(['AGENTS', 'project-conventions']);
    expect(listed.assets[0].scope).toBe('global');
    expect(listed.assets[1].title).toBe('项目约定');
    expect(listed.assets[1].tags).toEqual(['convention', 'project']);
    expect(listed.assets[1].source.path).toBe('memory/project-conventions.md');

    for (const asset of listed.assets) {
      expect(opencode.writeAsset('memory', asset, { dryRun: false }, env).ok).toBe(true);
    }
    expect(get(root, 'AGENTS.md')).toBe(OC_AGENTS);
    expect(get(root, 'memory/project-conventions.md')).toBe(OC_MEMORY);
  });

  test('工具:opencode.json 逐字节等价,真实密钥由目标侧填回而非被占位符覆盖', () => {
    const root = seedOpencode();
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: root };
    const tool = opencode.listTools(env).assets[0];

    expect(tool.name).toBe('filesystem');
    expect(tool.toolKind).toBe('mcp_server');
    expect(tool.spec.type).toBe('local');
    expect(tool.spec.environment.API_KEY).toBe(M.REDACTED);
    expect(tool.spec.environment.WORKSPACE).toBe('repo');
    expect(tool.source.redactedFields).toEqual(['environment.API_KEY']);
    expect(JSON.stringify(tool)).not.toContain(OC_FAKE_KEY);

    expect(opencode.writeAsset('tool', tool, { dryRun: false }, env).ok).toBe(true);
    expect(get(root, 'opencode.json')).toBe(OC_CONFIG);
  });

  test('技能:单文件型与目录型(含附属资源)写回都逐字节等价', () => {
    const root = seedOpencode();
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: root };
    const listed = opencode.listSkills(env);

    expect(listed.assets.map((a) => a.name)).toEqual(['review', 'deploy']);
    expect(listed.assets[0].source.format).toBe('file:md');
    expect(listed.assets[1].source.format).toBe('dir:SKILL.md');
    expect(listed.assets[1].files).toEqual(['checklist.md']);

    for (const asset of listed.assets) {
      expect(opencode.writeAsset('skill', asset, { dryRun: false }, env).ok).toBe(true);
    }
    expect(get(root, 'command/review.md')).toBe(OC_COMMAND);
    expect(get(root, 'skill/deploy/SKILL.md')).toBe(OC_SKILL_ENTRY);
    expect(get(root, 'skill/deploy/checklist.md')).toBe(OC_SKILL_EXTRA);
  });

  test('opencode.json 解析不了时拒绝写入,不拿半截结构覆盖用户配置', () => {
    const root = mkRoot('opencode-broken');
    put(root, 'opencode.json', '{ 这不是 JSON');
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: root };
    const listed = opencode.listTools(env);
    expect(listed.ok).toBe(false);
    expect(listed.error).toContain('解析失败');

    const asset = M.validateAsset('tool', {
      name: 'x',
      kind: 'mcp_server',
      spec: {},
      source: { tool: 'khy-os' },
    }).asset;
    const wrote = opencode.writeAsset('tool', asset, { dryRun: false }, env);
    expect(wrote.ok).toBe(false);
    expect(get(root, 'opencode.json')).toBe('{ 这不是 JSON');
  });
});

describe('Claude Code:读取、无损往返与跨工具导入落点', () => {
  test('记忆:全局 CLAUDE.md + 项目逐项记忆,写回逐字节等价', () => {
    const root = seedClaudeCode();
    const env = claudeEnv(root);
    const listed = claudeCode.listMemories(env);

    expect(listed.assets.map((a) => a.id).sort()).toEqual(['CLAUDE', 'MEMORY', 'team-convention']);
    const global = listed.assets.find((a) => a.id === 'CLAUDE');
    const team = listed.assets.find((a) => a.id === 'team-convention');
    expect(global.scope).toBe('global');
    expect(team.scope).toBe('project');
    expect(team.title).toBe('团队约定');
    expect(team.tags).toEqual(['project']);

    for (const asset of listed.assets) {
      expect(claudeCode.writeAsset('memory', asset, { dryRun: false }, env).ok).toBe(true);
    }
    expect(get(root, 'CLAUDE.md')).toBe(CC_GLOBAL);
    expect(get(root, `projects/${CC_PROJECT}/memory/team-convention.md`)).toBe(CC_MEMORY);
    expect(get(root, `projects/${CC_PROJECT}/memory/MEMORY.md`)).toBe(CC_INDEX);
  });

  test('项目 slug 由 cwd 逐字符推算,连续非字母数字不折叠', () => {
    const root = mkRoot('claude-slug');
    put(root, 'CLAUDE.md', CC_GLOBAL);
    // Claude Code 把 'C:\khy-os' 的冒号与反斜杠各换成一个横杠 → 'C--khy-os'。折叠成
    // 'C-khy-os' 会指向一个不存在的目录 —— 项目级记忆会整目录静默漏检(全局 CLAUDE.md
    // 照样能读到,故这个漏检从返回值上看不出异常,只能靠本测试锁死)。
    put(root, 'projects/C--khy-os/memory/team-convention.md', CC_MEMORY);
    const env = { KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: root, KHYQUANT_CWD: 'C:\\khy-os' };
    expect(
      claudeCode
        .listMemories(env)
        .assets.map((a) => a.id)
        .sort()
    ).toEqual(['CLAUDE', 'team-convention']);

    // 尾部分隔符不参与推算(否则末尾多一个横杠,又是一个不存在的目录)
    const trailing = Object.assign({}, env, { KHYQUANT_CWD: 'C:\\khy-os\\' });
    expect(claudeCode.listMemories(trailing).assets.map((a) => a.id)).toContain(
      'team-convention'
    );

    // POSIX 路径的首位横杠必须保留:'/home/u/p' 在 Claude Code 侧就是 '-home-u-p'
    const posix = mkRoot('claude-slug-posix');
    put(posix, 'projects/-home-u-p/memory/team-convention.md', CC_MEMORY);
    const posixEnv = { KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT: posix, KHYQUANT_CWD: '/home/u/p' };
    expect(claudeCode.listMemories(posixEnv).assets.map((a) => a.id)).toEqual([
      'team-convention',
    ]);
  });
  test('工具:settings.json 逐字节等价,token 不进 IR', () => {
    const root = seedClaudeCode();
    const env = claudeEnv(root);
    const tool = claudeCode.listTools(env).assets[0];

    expect(tool.name).toBe('github');
    expect(tool.spec.env.GITHUB_TOKEN).toBe(M.REDACTED);
    expect(tool.spec.env.GITHUB_ORG).toBe('khy');
    expect(tool.source.redactedFields).toEqual(['env.GITHUB_TOKEN']);
    expect(JSON.stringify(tool)).not.toContain(CC_FAKE_TOKEN);

    expect(claudeCode.writeAsset('tool', tool, { dryRun: false }, env).ok).toBe(true);
    expect(get(root, 'settings.json')).toBe(CC_SETTINGS);
  });

  test('技能:主文件 + 附属资源写回逐字节等价', () => {
    const root = seedClaudeCode();
    const env = claudeEnv(root);
    const skill = claudeCode.listSkills(env).assets[0];

    expect(skill.name).toBe('code-review');
    expect(skill.files).toEqual(['checklist.md']);
    expect(claudeCode.writeAsset('skill', skill, { dryRun: false }, env).ok).toBe(true);
    expect(get(root, 'skills/code-review/SKILL.md')).toBe(CC_SKILL_ENTRY);
  });

  test('跨工具导入落到托管目录并登记索引,绝不改写用户的 CLAUDE.md', () => {
    const ccRoot = seedClaudeCode();
    const ocRoot = seedOpencode();
    const env = Object.assign(claudeEnv(ccRoot), { KHY_AGENT_ASSETS_OPENCODE_ROOT: ocRoot });
    const foreign = opencode
      .listMemories(env)
      .assets.find((a) => a.id === 'project-conventions');

    const res = claudeCode.writeAsset('memory', foreign, { dryRun: false }, env);
    expect(res.ok).toBe(true);
    expect(res.written).toEqual([
      `projects/${CC_PROJECT}/memory/project-conventions.md`,
      `projects/${CC_PROJECT}/memory/MEMORY.md`,
    ]);
    expect(get(ccRoot, 'CLAUDE.md')).toBe(CC_GLOBAL);
    expect(get(ccRoot, `projects/${CC_PROJECT}/memory/MEMORY.md`)).toContain(
      '(project-conventions.md)'
    );

    // 再导一次:索引已有该文件 → 不重复登记
    expect(claudeCode.writeAsset('memory', foreign, { dryRun: false }, env).written).toEqual([
      `projects/${CC_PROJECT}/memory/project-conventions.md`,
    ]);
    const index = get(ccRoot, `projects/${CC_PROJECT}/memory/MEMORY.md`);
    expect(index.split('(project-conventions.md)')).toHaveLength(2);
  });
});

describe('harness:tools.json 两种形态与 kind 映射', () => {
  test('数组形态被读成两个工具,kind 按映射表归位', () => {
    const root = seedHarness();
    const env = { KHY_AGENT_ASSETS_HARNESS_ROOT: root };
    const listed = harness.listTools(env);

    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => [a.name, a.toolKind])).toEqual([
      ['ripgrep', 'local_command'],
      ['fetch', 'mcp_server'],
    ]);
    expect(listed.assets[0].source.format).toBe('json:array');
  });

  test('记忆与技能可读可写,写回逐字节等价', () => {
    const root = seedHarness();
    const env = { KHY_AGENT_ASSETS_HARNESS_ROOT: root };
    const before = get(root, 'memory/deploy-notes.md');
    const mem = harness.listMemories(env).assets.find((a) => a.id === 'deploy-notes');

    expect(harness.writeAsset('memory', mem, { dryRun: false }, env).ok).toBe(true);
    expect(get(root, 'memory/deploy-notes.md')).toBe(before);
    expect(harness.listSkills(env).assets.map((a) => a.name)).toEqual(['greet']);
  });
});

// ── 干跑与凭据 ──────────────────────────────────────────────────────────

describe('干跑优先:默认不落盘,只有显式 dryRun=false 才写', () => {
  test('不传 opts / 传 dryRun:true 都只回计划,目标目录连建都不建', () => {
    const root = freshKhyRoot('khy-dry');
    const env = { KHY_AGENT_ASSETS_LOCAL_ROOT: root };
    const asset = M.validateAsset('memory', {
      id: 'dry-run-check',
      scope: 'project',
      title: '干跑检查',
      content: '正文\n',
      source: { tool: 'opencode', path: 'memory/dry-run-check.md' },
    }).asset;

    const implicit = khyOs.writeAsset('memory', asset, undefined, env);
    expect(implicit).toMatchObject({ ok: true, dryRun: true, written: [] });
    expect(implicit.plan).toEqual([
      { path: 'memory/dry-run-check.md', reason: '写入记忆正文', bytes: expect.any(Number) },
    ]);
    expect(fs.existsSync(root)).toBe(false);

    expect(khyOs.writeAsset('memory', asset, { dryRun: true }, env).written).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);

    const real = khyOs.writeAsset('memory', asset, { dryRun: false }, env);
    expect(real).toMatchObject({ ok: true, dryRun: false, written: ['memory/dry-run-check.md'] });
    expect(has(root, 'memory/dry-run-check.md')).toBe(true);
  });

  test('删除同样默认干跑', () => {
    const root = seedOpencode();
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: root };
    const res = opencode.removeAsset('memory', 'project:project-conventions', undefined, env);
    expect(res).toMatchObject({ ok: true, dryRun: true, removed: [] });
    expect(has(root, 'memory/project-conventions.md')).toBe(true);
  });
});

describe('凭据:占位符永不落盘,真实密钥永不被覆盖', () => {
  test('目标侧没有该密钥 → 整键删掉,而不是写入占位符', () => {
    const ocRoot = seedOpencode();
    const khyRoot = freshKhyRoot('khy-tool');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: ocRoot,
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    const tool = opencode.listTools(env).assets[0];

    expect(khyOs.writeAsset('tool', tool, { dryRun: false }, env).ok).toBe(true);
    const text = get(khyRoot, 'tools.json');
    expect(text).not.toContain(OC_FAKE_KEY);
    expect(text).not.toContain(M.REDACTED);
    expect(JSON.parse(text).filesystem.environment).toEqual({ WORKSPACE: 'repo' });
  });

  test('目标侧已有真实密钥 → 沿用目标侧现值,内容其余部分照常更新', () => {
    const ocRoot = seedOpencode();
    const khyRoot = freshKhyRoot('khy-tool2');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: ocRoot,
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    put(
      khyRoot,
      'tools.json',
      json({ filesystem: { environment: { API_KEY: 'target-side-secret', WORKSPACE: 'old' } } })
    );

    const tool = opencode.listTools(env).assets[0];
    expect(khyOs.writeAsset('tool', tool, { dryRun: false }, env).ok).toBe(true);
    const doc = JSON.parse(get(khyRoot, 'tools.json'));
    expect(doc.filesystem.environment.API_KEY).toBe('target-side-secret');
    expect(doc.filesystem.environment.WORKSPACE).toBe('repo');
  });
});

// ── 编排层 ──────────────────────────────────────────────────────────────

describe('编排层:发现 / 导入 / 冲突 / 降级', () => {
  test('一台都没装时全景发现仍然成功,逐家说明未检测到的原因', () => {
    const home = mkRoot('discover-home');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KHY_AGENT_ASSETS_LOCAL_ROOT: freshKhyRoot('khy-discover'),
    };
    const res = sync.discover({ env });

    expect(res.ok).toBe(true);
    // 顺序与内容都从注册表推导:新增一家只该动注册表那一行,不该回来改测试。
    expect(res.tools.map((t) => t.tool)).toEqual(registry.listSourceIds(env));
    expect(res.tools.filter((t) => t.detected).map((t) => t.tool)).toEqual(['khy-os']);
    for (const t of res.tools.filter((x) => !x.detected)) {
      expect(t.error).toMatch(/已查找|环境变量/);
    }
    expect(res.totalAssets).toBe(0);
  });

  test('装了 opencode 时按类型清点', () => {
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode() };
    const one = sync.listTool('opencode', { env });
    expect(one.detected).toBe(true);
    expect(one.byKind.memory).toHaveLength(2);
    expect(one.byKind.tool).toHaveLength(1);
    expect(one.byKind.skill).toHaveLength(2);
  });

  test('导入干跑:逐项回报「动作 + 目标 + 进度」,且一个文件都不落', () => {
    const khyRoot = freshKhyRoot('khy-import-dry');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    const seen = [];
    const res = sync.importAssets({
      from: 'opencode',
      kinds: ['memory'],
      env,
      onProgress: (p) => seen.push(p.message),
    });

    expect(res).toMatchObject({ ok: true, dryRun: true, from: 'opencode', to: 'khy-os' });
    expect(res.summary).toMatchObject({ total: 2, create: 2, conflict: 0, appliedCount: 2 });
    expect(res.applied.every((a) => a.written.length === 0)).toBe(true);
    expect(fs.existsSync(khyRoot)).toBe(false);

    const transferred = seen.filter((m) => m.startsWith('正在导入'));
    expect(transferred).toEqual([
      '正在导入 opencode 记忆 1/2:AGENTS',
      '正在导入 opencode 记忆 2/2:项目约定',
    ]);
  });

  test('落盘后再导一次全部 in-sync —— 哈希无视来源路径与 mtime 才做得到', () => {
    const khyRoot = freshKhyRoot('khy-import');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    const first = sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });
    expect(first.ok).toBe(true);
    expect(ls(khyRoot, 'memory')).toEqual(['AGENTS.md', 'project-conventions.md']);

    const second = sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });
    expect(second.summary).toMatchObject({ total: 2, 'in-sync': 2, conflict: 0, appliedCount: 0 });
  });

  test('三类一起落盘后再导一次也全部 in-sync —— 落盘形态与被抹凭据都不算内容差异', () => {
    const khyRoot = freshKhyRoot('khy-import-all');
    const ocRoot = seedOpencode();
    // 没有附属资源的目录型技能:导到 khy 侧会变成单文件型(skills/solo.md),
    // 主文件名从 SKILL.md 变成 solo.md。那是布局变化而非内容变化,不该判冲突。
    put(ocRoot, 'skill/solo/SKILL.md', '---\nname: solo\ndescription: 独立技能\n---\n正文一行。\n');
    const env = { KHY_AGENT_ASSETS_OPENCODE_ROOT: ocRoot, KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot };

    const first = sync.importAssets({ from: 'opencode', dryRun: false, env });
    expect(first.ok).toBe(true);
    expect(first.summary).toMatchObject({ total: 6, create: 6, conflict: 0 });
    expect(ls(khyRoot, 'skills')).toEqual(['deploy', 'review.md', 'solo.md']);

    // 幂等:同一份资产再导一次必须全 in-sync。否则「导入成功后立刻再同步」会凭空
    // 报冲突,并且每跑一次多生一批 .conflict-* 文件。
    const second = sync.importAssets({ from: 'opencode', dryRun: false, env });
    expect(second.summary).toMatchObject({ total: 6, 'in-sync': 6, conflict: 0, appliedCount: 0 });
    expect(second.conflicts).toEqual([]);
    expect(ls(khyRoot, 'skills').filter((f) => f.includes('.conflict-'))).toEqual([]);
  });

  test('同名不同内容:保留双方 + 冲突副本,目标侧原件一字不动,重复同步幂等', () => {
    const khyRoot = freshKhyRoot('khy-conflict');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });

    const mine = `${get(khyRoot, 'memory/project-conventions.md')}本地又补了一条。\n`;
    put(khyRoot, 'memory/project-conventions.md', mine);

    const res = sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({
      identity: 'project:project-conventions',
      resolution: 'keep-both',
    });
    expect(res.conflicts[0].copyIdentity).toMatch(
      /^project:project-conventions\.conflict-opencode-[0-9a-f]{8}$/
    );
    expect(get(khyRoot, 'memory/project-conventions.md')).toBe(mine);

    const copies = ls(khyRoot, 'memory').filter((f) => f.includes('.conflict-'));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^project-conventions\.conflict-opencode-[0-9a-f]{8}\.md$/);

    // 再同步一次:副本名内嵌内容哈希 → 落到同一个文件,不会越滚越多
    sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });
    expect(ls(khyRoot, 'memory').filter((f) => f.includes('.conflict-'))).toHaveLength(1);
  });

  test('onConflict=skip:冲突项只列清单,两侧都不动', () => {
    const khyRoot = freshKhyRoot('khy-skip');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    sync.importAssets({ from: 'opencode', kinds: ['memory'], dryRun: false, env });
    const mine = '完全换掉的内容\n';
    put(khyRoot, 'memory/project-conventions.md', mine);

    const res = sync.importAssets({
      from: 'opencode',
      kinds: ['memory'],
      dryRun: false,
      onConflict: 'skip',
      env,
    });
    expect(res.conflicts[0]).toMatchObject({ resolution: 'skip' });
    expect(get(khyRoot, 'memory/project-conventions.md')).toBe(mine);
    expect(ls(khyRoot, 'memory').filter((f) => f.includes('.conflict-'))).toEqual([]);
  });

  test('源工具没装 → 整条链路跳过而非失败', () => {
    const home = mkRoot('skip-home');
    const res = sync.importAssets({
      from: 'opencode',
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        KHY_AGENT_ASSETS_LOCAL_ROOT: freshKhyRoot('khy-skip2'),
      },
    });
    expect(res).toMatchObject({ ok: true, skipped: true });
    expect(res.reason).toContain('未检测到源工具');
  });

  test('目标侧声明不可写 → 记进 failures 并标 unsupported,不打断其余项', () => {
    const khyRoot = freshKhyRoot('khy-export');
    const harnessRoot = seedHarness();
    const env = {
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
      KHY_AGENT_ASSETS_HARNESS_ROOT: harnessRoot,
    };
    put(khyRoot, 'tools.json', json({ 'khy-local': { kind: 'local_command', command: 'khy' } }));

    const res = sync.exportAssets({ to: 'harness', kinds: ['tool'], dryRun: false, env });
    expect(res.ok).toBe(true);
    expect(res.applied).toEqual([]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ identity: 'khy-local', unsupported: true });
    expect(get(harnessRoot, 'tools.json')).toBe(HARNESS_TOOLS);
  });

  test('双向同步:两个方向各跑一遍,计划里两侧都能被搬', () => {
    const khyRoot = freshKhyRoot('khy-bidi');
    const env = {
      KHY_AGENT_ASSETS_OPENCODE_ROOT: seedOpencode(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot,
    };
    put(khyRoot, 'memory/only-in-khy.md', '---\nid: only-in-khy\ntitle: 只在本地\n---\n本地独有。\n');

    const res = sync.syncAssets({ a: 'opencode', b: 'khy-os', kinds: ['memory'], dryRun: false, env });
    expect(res.ok).toBe(true);
    expect(res.directions).toHaveLength(2);
    expect(has(khyRoot, 'memory/AGENTS.md')).toBe(true);
    expect(res.directions[1].applied.map((a) => a.identity)).toContain('project:only-in-khy');
  });

  test('门控关闭 → 明确拒绝并说明原因,不做半吊子降级', () => {
    const res = sync.discover({ env: { KHY_AGENT_ASSETS: 'off' } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('KHY_AGENT_ASSETS=off');
  });
});

// ── 假资产树:DeepSeek Harness ──────────────────────────────────────────

const DSH_FAKE_KEY = 'sk-fixture-111111111111';
const DSH_NEVER_KEY = 'sk-must-never-leak-222222';

/**
 * 手写 YAML:带注释、带 `!!js` 动态表达式。这两样正是「dump 回写有损」的实证理由,
 * 也是「一行动态配置不能毒死整篇解析」这条要求的来源。
 */
const DSH_PATCH = [
  '# 用户层插件补丁(手写,注释必须活下来)',
  'plugins:',
  "  - name: '@deepseek-ai/dsh-mcp-client'",
  '    id: mcp-filesystem',
  '    config:',
  '      serverName: filesystem',
  '      description: 本地文件访问',
  '      transport: stdio',
  '      command: npx',
  '      env:',
  `        API_KEY: ${DSH_FAKE_KEY}`,
  '        WORKSPACE: repo',
  "  - name: '@deepseek-ai/dsh-mcp-client'",
  '    id: mcp-search',
  '    disabled: !!js process.env.DSH_DISABLE_SEARCH',
  '    config:',
  '      serverName: search',
  '      transport: streamable-http',
  "  - name: '@deepseek-ai/dsh-some-other-plugin'",
  '    id: not-a-tool',
  '',
].join('\n');

const DSH_SKILL_ENTRY = ['---', 'name: code-review', 'description: 评审 diff', '---', '先看四条红线。', ''].join(
  '\n'
);
const DSH_SKILL_EXTRA = '1. 零硬编码\n2. 状态透明\n';
const DSH_SINGLE_SKILL = ['---', 'name: quick-note', 'description: 速记', '---', '随手记。', ''].join('\n');

function seedDsh() {
  const root = mkRoot('dsh');
  put(root, 'cordis.patch.yml', DSH_PATCH);
  put(root, 'skills/code-review/SKILL.md', DSH_SKILL_ENTRY);
  put(root, 'skills/code-review/reference.md', DSH_SKILL_EXTRA);
  put(root, 'skills/quick-note.md', DSH_SINGLE_SKILL);
  // 上游 skill-filesystem 刻意不做嵌套发现,`.system` 是内部目录 —— 两者都不该被报成技能,
  // 否则 khy 会报出一堆 dsh 自己根本不会加载的东西。
  put(root, 'skills/nested/deep/SKILL.md', DSH_SINGLE_SKILL);
  put(root, 'skills/.system/hidden/SKILL.md', DSH_SINGLE_SKILL);
  // 凭据文件:本适配器从不读它,靠下面「这串永不出现在返回值里」锁死。
  put(root, '.credentials.yaml', `apiKey: ${DSH_NEVER_KEY}\n`);
  return root;
}

describe('DeepSeek Harness:记忆显式不支持、工具只读、技能可写', () => {
  test('探测:khy 覆盖变量是硬的,DSH_HOME 只是候选,都没有时说清找过哪些位置', () => {
    const root = seedDsh();
    expect(dsh.detect({ KHY_AGENT_ASSETS_DSH_ROOT: root })).toMatchObject({
      ok: true,
      root,
      via: 'env:KHY_AGENT_ASSETS_DSH_ROOT',
    });
    expect(dsh.detect({ DSH_HOME: root })).toMatchObject({ ok: true, root, via: 'default' });

    const home = mkRoot('dsh-empty');
    const d = dsh.detect({ HOME: home });
    expect(d.ok).toBe(false);
    expect(d.error).toContain(path.join(home, '.dsh'));
    expect(d.error).toContain('KHY_AGENT_ASSETS_DSH_ROOT');
  });

  test('记忆:显式声明不支持并说明委托给谁 —— 既不返回空列表,也不抛', () => {
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: seedDsh() };
    expect(dsh.capabilities(env).kinds.memory).toMatchObject({ read: false, write: false });

    const listed = dsh.listMemories(env);
    expect(listed).toMatchObject({ ok: false, unsupported: true });
    // 空列表会被上层读成「装了但一条都没有」,与「这家根本不存这类资产」是两回事。
    expect(listed.assets).toBeUndefined();
    expect(listed.error).toContain('MCP 服务器');

    const wrote = dsh.writeAsset(
      'memory',
      { id: 'x', scope: 'project', title: 'x', content: '正文\n' },
      { dryRun: false },
      env
    );
    expect(wrote).toMatchObject({ ok: false, unsupported: true });
    expect(wrote.error).toContain('未写入任何文件');
  });

  test('工具:!!js 表达式不会毒死整篇解析,非 MCP 插件行不被误报,凭据在出口被抹', () => {
    const root = seedDsh();
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
    const listed = dsh.listTools(env);
    expect(listed.ok).toBe(true);
    // search 能出现,就证明上一行的 `!!js` 未知标签没有把整份 YAML 拖垮。
    expect(listed.assets.map((a) => a.name).sort()).toEqual(['filesystem', 'search']);

    const fsTool = listed.assets.find((a) => a.name === 'filesystem');
    expect(fsTool.toolKind).toBe('mcp_server');
    expect(fsTool.spec.env.API_KEY).toBe(M.REDACTED);
    expect(fsTool.spec.env.WORKSPACE).toBe('repo');
    expect(fsTool.source.redactedFields).toContain('env.API_KEY');
    expect(JSON.stringify(listed)).not.toContain(DSH_FAKE_KEY);

    const search = listed.assets.find((a) => a.name === 'search');
    expect(search.raw.disabled).toBe(`${dsh.JS_EXPR_PREFIX}process.env.DSH_DISABLE_SEARCH`);
  });

  test('工具:声明不可写,写/删都不动 YAML 一个字节(用户的注释因此活着)', () => {
    const root = seedDsh();
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
    const tool = dsh.listTools(env).assets[0];

    const wrote = dsh.writeAsset('tool', tool, { dryRun: false }, env);
    expect(wrote).toMatchObject({ ok: false, unsupported: true });
    expect(wrote.error).toContain('未写入任何文件');

    const removed = dsh.removeAsset('tool', 'filesystem', { dryRun: false }, env);
    expect(removed).toMatchObject({ ok: false, unsupported: true });
    expect(get(root, 'cordis.patch.yml')).toBe(DSH_PATCH);
  });

  test('技能:单文件与目录两种形态都读得到;嵌套与 .system 一律不报', () => {
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: seedDsh() };
    const listed = dsh.listSkills(env);
    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => a.name).sort()).toEqual(['code-review', 'quick-note']);
    expect(listed.assets.find((a) => a.name === 'code-review').source.format).toBe('dir:SKILL.md');
    expect(listed.assets.find((a) => a.name === 'quick-note').source.format).toBe('file:md');
  });

  test('技能:同工具往返逐字节等价;跨工具导入按 dsh 的 kebab-case 规矩落盘', () => {
    const root = seedDsh();
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
    const skill = dsh.listSkills(env).assets.find((a) => a.name === 'code-review');

    const wrote = dsh.writeAsset('skill', skill, { dryRun: false }, env);
    expect(wrote.written).toEqual(['skills/code-review/SKILL.md', 'skills/code-review/reference.md']);
    expect(get(root, 'skills/code-review/SKILL.md')).toBe(DSH_SKILL_ENTRY);
    expect(get(root, 'skills/code-review/reference.md')).toBe(DSH_SKILL_EXTRA);

    const imported = M.validateAsset('skill', {
      name: 'DeployFlow',
      description: '发布流程',
      entry: 'DeployFlow.md',
      contents: { 'DeployFlow.md': '# 发布流程\n' },
      source: { tool: 'khy-os', path: 'skills/DeployFlow.md', format: 'file:md' },
    }).asset;
    const plan = dsh.writeAsset('skill', imported, undefined, env);
    expect(plan).toMatchObject({ ok: true, dryRun: true, written: [] });
    expect(plan.plan[0].path).toBe('skills/deploy-flow.md');
    expect(has(root, 'skills/deploy-flow.md')).toBe(false);
  });

  test('凭据文件既不被读,也不出现在任何资产的来源路径里', () => {
    const root = seedDsh();
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: root };
    const results = [dsh.listTools(env), dsh.listSkills(env), dsh.listMemories(env)];
    expect(JSON.stringify(results)).not.toContain(DSH_NEVER_KEY);
    for (const res of results) {
      for (const a of res.assets || []) {
        expect(dsh.NEVER_READ).not.toContain(a.source.path);
      }
    }
  });
});

// ── 假资产树:OpenClaw ─────────────────────────────────────────────────

const OCW_FAKE_TOKEN = 'ghp_fixture1111111111111';
const OCW_SECRET = 'sk-secrets-section-333333';

/**
 * 刻意写成**字面 JSON 文本**而不是 JSON.stringify(对象字面量):
 * 对象字面量里的 `__proto__:` 是原型设置器而非自有属性,那样根本造不出这个 fixture。
 */
const OCW_CONFIG = [
  '{',
  '  "secrets": {',
  `    "ANTHROPIC_API_KEY": "${OCW_SECRET}"`,
  '  },',
  '  "mcp": {',
  '    "servers": {',
  '      "filesystem": {',
  '        "transport": "stdio",',
  '        "command": "npx",',
  '        "args": ["-y", "mcp-server-filesystem"],',
  '        "enabled": true,',
  '        "env": { "WORKSPACE": "repo" }',
  '      },',
  '      "remote-notes": {',
  '        "transport": "streamable-http",',
  `        "headers": { "Authorization": "Bearer ${OCW_FAKE_TOKEN}" },`,
  '        "enabled": false',
  '      },',
  '      "__proto__": { "transport": "stdio", "note": "上游保留名,不该被当成工具" }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const OCW_MEMORY_MD = '# 长期记忆\n\n- 用户偏好中文回复。\n';
const OCW_USER_MD = '# 用户\n\n昵称:khy。\n';
const OCW_DAILY = '# 2026-08-20\n\n今天把资产层接上了。\n';
const OCW_DREAM = '# 内部\n\n机器用的中间产物,不该被当成资产。\n';

/** 真实形态:metadata.openclaw 是两级嵌套,底座的行解析器认不全 —— 正好验「认不全也不丢」。 */
const OCW_SKILL_ENTRY = [
  '---',
  'name: deploy',
  'description: 发布流程',
  'metadata:',
  '  openclaw:',
  '    always: false',
  '---',
  '按 checklist 逐项确认。',
  '',
].join('\n');
const OCW_STATE_SKILL = ['---', 'name: state-level', 'description: 状态目录级技能', '---', '兜底技能。', ''].join(
  '\n'
);

function seedOpenclaw() {
  const root = mkRoot('openclaw');
  put(root, 'openclaw.json', OCW_CONFIG);
  put(root, 'workspace/MEMORY.md', OCW_MEMORY_MD);
  put(root, 'workspace/USER.md', OCW_USER_MD);
  put(root, 'workspace/memory/2026-08-20.md', OCW_DAILY);
  put(root, 'workspace/memory/.dreams/2026-08-20.md', OCW_DREAM);
  put(root, 'workspace/skills/deploy/SKILL.md', OCW_SKILL_ENTRY);
  put(root, 'skills/state-level/SKILL.md', OCW_STATE_SKILL);
  return root;
}

describe('OpenClaw:工作区记忆、mcp.servers 与保留名 __proto__', () => {
  test('探测:两个上游变量都只是候选,失败时列出真查过的目录', () => {
    const root = seedOpenclaw();
    expect(openclaw.detect({ OPENCLAW_STATE_DIR: root })).toMatchObject({ ok: true, root });
    expect(openclaw.detect({ OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json') })).toMatchObject({
      ok: true,
      root,
    });

    const home = mkRoot('ocw-empty');
    const d = openclaw.detect({ HOME: home });
    expect(d.ok).toBe(false);
    expect(d.error).toContain(path.join(home, '.openclaw'));
    expect(d.error).toContain('KHY_AGENT_ASSETS_OPENCLAW_ROOT');
  });

  test('记忆:MEMORY/USER 是用户级,每日笔记是项目级,.dreams 不当资产', () => {
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: seedOpenclaw() };
    const listed = openclaw.listMemories(env);
    expect(listed.ok).toBe(true);
    const byId = new Map(listed.assets.map((a) => [a.id, a]));
    expect([...byId.keys()].sort()).toEqual(['2026-08-20', 'MEMORY', 'USER']);
    expect(byId.get('MEMORY').scope).toBe('global');
    expect(byId.get('USER').scope).toBe('global');
    expect(byId.get('2026-08-20').scope).toBe('project');
    expect(JSON.stringify(listed)).not.toContain('机器用的中间产物');
  });

  test('记忆:裸 markdown 原地写回逐字节等价 —— 不替用户插一段 frontmatter', () => {
    const root = seedOpenclaw();
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };
    const mem = openclaw.listMemories(env).assets.find((a) => a.id === 'MEMORY');
    const wrote = openclaw.writeAsset('memory', mem, { dryRun: false }, env);
    expect(wrote.written).toEqual(['workspace/MEMORY.md']);
    expect(get(root, 'workspace/MEMORY.md')).toBe(OCW_MEMORY_MD);
  });

  test('记忆:跨工具导入落到 imports/khy-os,用户策展的 MEMORY.md 一个字节都不动', () => {
    const root = seedOpenclaw();
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };
    const imported = M.validateAsset('memory', {
      id: 'project-conventions',
      scope: 'project',
      title: '项目约定',
      content: '提交信息用 Conventional Commits。\n',
      source: { tool: 'khy-os', path: 'memory/project-conventions.md' },
    }).asset;

    const plan = openclaw.writeAsset('memory', imported, undefined, env);
    expect(plan).toMatchObject({ ok: true, dryRun: true, written: [] });
    expect(plan.plan[0].path).toBe('workspace/memory/imports/khy-os/project-conventions.md');

    openclaw.writeAsset('memory', imported, { dryRun: false }, env);
    expect(has(root, 'workspace/memory/imports/khy-os/project-conventions.md')).toBe(true);
    expect(get(root, 'workspace/MEMORY.md')).toBe(OCW_MEMORY_MD);
  });

  test('工具:__proto__ 不被当成工具、不污染原型、也不被静默抹掉;secrets 段从不出现', () => {
    const root = seedOpenclaw();
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };
    const listed = openclaw.listTools(env);
    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => a.name).sort()).toEqual(['filesystem', 'remote-notes']);
    expect(JSON.stringify(listed)).not.toContain(OCW_SECRET);
    expect(JSON.stringify(listed)).not.toContain(OCW_FAKE_TOKEN);

    const notes = listed.assets.find((a) => a.name === 'remote-notes');
    expect(notes.spec.headers.Authorization).toBe(M.REDACTED);
    expect(notes.source.redactedFields).toContain('headers.Authorization');

    const wrote = openclaw.writeAsset('tool', notes, { dryRun: false }, env);
    expect(wrote.ok).toBe(true);
    // 原型没被污染
    expect(Object.prototype.transport).toBeUndefined();
    expect({}.note).toBeUndefined();
    // 保留名条目仍在文件里(它是用户的内容,khy 不替他删)
    const after = JSON.parse(get(root, 'openclaw.json'));
    expect(Object.keys(after.mcp.servers).sort()).toEqual(['__proto__', 'filesystem', 'remote-notes']);
    // 占位符永不落盘,目标侧的真 token 原样保留
    expect(get(root, 'openclaw.json')).not.toContain(M.REDACTED);
    expect(after.mcp.servers['remote-notes'].headers.Authorization).toBe(`Bearer ${OCW_FAKE_TOKEN}`);
    // secrets 段没被顺手改掉
    expect(after.secrets.ANTHROPIC_API_KEY).toBe(OCW_SECRET);
  });

  test('工具:保留名本身拒绝写入', () => {
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: seedOpenclaw() };
    const bad = M.validateAsset('tool', {
      name: openclaw.RESERVED_SERVER_NAME,
      kind: 'mcp_server',
      spec: {},
    }).asset;
    const res = openclaw.writeAsset('tool', bad, { dryRun: false }, env);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未写入任何文件');
  });

  test('技能:工作区级优先于状态目录级;往返逐字节等价(嵌套 metadata 解析不全也不丢)', () => {
    const root = seedOpenclaw();
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };
    const listed = openclaw.listSkills(env);
    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => a.name).sort()).toEqual(['deploy', 'state-level']);
    expect(listed.assets.find((a) => a.name === 'deploy').source.path).toBe('workspace/skills/deploy');

    const deploy = listed.assets.find((a) => a.name === 'deploy');
    const wrote = openclaw.writeAsset('skill', deploy, { dryRun: false }, env);
    expect(wrote.written).toEqual(['workspace/skills/deploy/SKILL.md']);
    expect(get(root, 'workspace/skills/deploy/SKILL.md')).toBe(OCW_SKILL_ENTRY);
  });

  test('配置是 JSON5 形态(带注释)→ 读写都明确拒绝,绝不重写把注释抹掉', () => {
    const root = mkRoot('openclaw-json5');
    put(root, 'openclaw.json', '{\n  // 上游允许注释\n  "mcp": { "servers": {} },\n}\n');
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };

    const listed = openclaw.listTools(env);
    expect(listed.ok).toBe(false);
    expect(listed.error).toContain('JSON5');

    const tool = M.validateAsset('tool', { name: 'x', kind: 'mcp_server', spec: {} }).asset;
    const wrote = openclaw.writeAsset('tool', tool, { dryRun: false }, env);
    expect(wrote.ok).toBe(false);
    expect(get(root, 'openclaw.json')).toContain('// 上游允许注释');
  });

  test('工作区可由配置改名:声明什么就读写什么', () => {
    const root = mkRoot('openclaw-ws');
    put(root, 'openclaw.json', json({ agents: { defaults: { workspace: 'my-ws' } }, mcp: { servers: {} } }));
    put(root, 'my-ws/MEMORY.md', OCW_MEMORY_MD);
    const env = { KHY_AGENT_ASSETS_OPENCLAW_ROOT: root };
    const listed = openclaw.listMemories(env);
    expect(listed.assets.map((a) => a.source.path)).toEqual(['my-ws/MEMORY.md']);
  });
});

describe('新增一家 = 一个适配器文件 + 表里一行(验收标准 2)', () => {
  test('两家新工具走的是同一套注册表与编排层,没有任何厂商分支', () => {
    const env = {
      KHY_AGENT_ASSETS_DSH_ROOT: seedDsh(),
      KHY_AGENT_ASSETS_OPENCLAW_ROOT: seedOpenclaw(),
      KHY_AGENT_ASSETS_LOCAL_ROOT: freshKhyRoot('khy-newcomers'),
    };
    const found = sync.discover({ env });
    expect(found.ok).toBe(true);
    const byId = new Map(found.tools.map((t) => [t.tool, t]));
    expect(byId.get('deepseek-harness').detected).toBe(true);
    expect(byId.get('openclaw').detected).toBe(true);
  });

  test('从 dsh 导入:不可用的记忆类降级成错误说明,不打断技能这一类', () => {
    const khyRoot = freshKhyRoot('khy-from-dsh');
    const env = { KHY_AGENT_ASSETS_DSH_ROOT: seedDsh(), KHY_AGENT_ASSETS_LOCAL_ROOT: khyRoot };
    const res = sync.importAssets({
      from: 'deepseek-harness',
      kinds: ['memory', 'skill'],
      dryRun: false,
      env,
    });
    expect(res.ok).toBe(true);
    expect(res.applied.map((a) => a.identity).sort()).toEqual(['code-review', 'quick-note']);
  });

  test('模型出口(AgentAssetsTool)的厂商清单也从注册表推导 —— 否则新接的一家对模型不存在', () => {
    // 这条曾经真的漏过:适配器与注册表都改好了,但工具 schema 的 enum/description 还
    // 停在旧清单上,模型永远选不到新接的那家 —— 「表里一行」的验收在出口处被架空了。
    const tool = require('../../tools/AgentAssetsTool');
    const ids = registry.AGENT_ASSET_SOURCES.map((s) => s.id);
    expect(tool.inputSchema.tool.enum).toEqual(ids);
    for (const id of ids) {
      expect(tool.inputSchema.tool.description).toContain(id);
      expect(tool.searchHint).toContain(id);
    }
    for (const label of registry.AGENT_ASSET_SOURCES.map((s) => s.label)) {
      expect(tool.description).toContain(label);
    }
  });
});
