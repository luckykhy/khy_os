/**
 * Workflow Markdown export pipeline.
 *
 * Drives workflowExportService end-to-end against a throwaway SQLite DB and a
 * temp HOME, asserting that a complete graph produces a harness-discoverable
 * SKILL.md (+ one agent .md per subAgent), and that an incomplete graph is
 * rejected by the strict completeness gate.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-workflow-export-${process.pid}.db`);
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `khy-wf-home-${process.pid}-`));
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

const { sequelize, User } = require('@khy/shared/models');
const svc = require('../src/services/workflowService');
const exportSvc = require('../src/services/workflowExportService');

const COMPLETE_GRAPH = {
  nodes: [
    { id: 'n_start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: { inputs: [] } },
    { id: 'n_ask', type: 'askUserQuestion', name: '问标的', position: { x: 160, y: 0 }, data: { question: '选哪个标的？', options: ['BTC', 'ETH'], answerVar: 'sym' } },
    { id: 'n_agent', type: 'subAgent', name: '研究员', position: { x: 320, y: 0 }, data: { agentName: 'researcher', instructions: '研究 {{sym}} 的基本面。', model: 'sonnet', tools: ['WebSearch'], maxTurns: 5 } },
    { id: 'n_if', type: 'ifElse', name: '是否看多', position: { x: 480, y: 0 }, data: { expression: 'score > 0', trueLabel: '看多', falseLabel: '看空' } },
    { id: 'n_end', type: 'end', name: 'End', position: { x: 640, y: 0 }, data: { outputs: [] } },
  ],
  connections: [
    { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_ask', toPort: 'input', condition: null },
    { id: 'e2', from: 'n_ask', fromPort: 'default', to: 'n_agent', toPort: 'input', condition: null },
    { id: 'e3', from: 'n_agent', fromPort: 'default', to: 'n_if', toPort: 'input', condition: null },
    { id: 'e4', from: 'n_if', fromPort: 'branch-true', to: 'n_end', toPort: 'input', condition: null },
    { id: 'e5', from: 'n_if', fromPort: 'branch-false', to: 'n_end', toPort: 'input', condition: null },
  ],
};

let user;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  user = await User.create({ username: 'wf-exp', email: 'wf-exp@test.local', password: 'pw-exp-123', status: 'active' });
});

afterAll(async () => {
  await sequelize.close();
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('exportWorkflow — end to end', () => {
  let id;

  beforeAll(async () => {
    const wf = await svc.create(user.id, { name: '研究流程' });
    id = wf.id;
    await svc.save(user.id, id, { graph: COMPLETE_GRAPH });
  });

  test('writes SKILL.md and one agent file', async () => {
    const out = await exportSvc.exportWorkflow(user.id, id, { homeDir: TMP_HOME });

    expect(out.slug).toBe(`wf-${user.id}-研究流程`);
    expect(out.summary.nodes).toBe(5);
    expect(out.summary.agents).toBe(1);

    const skill = out.files.find((f) => f.kind === 'skill');
    const agent = out.files.find((f) => f.kind === 'agent');
    expect(skill).toBeTruthy();
    expect(agent).toBeTruthy();

    // Skill lands under ~/.khyquant/skills/<slug>/SKILL.md
    expect(skill.path).toBe(path.join(TMP_HOME, '.khyquant', 'skills', out.slug, 'SKILL.md'));
    expect(fs.existsSync(skill.path)).toBe(true);
    // Agent lands under ~/.khy/agents/<name>.md
    expect(agent.path).toBe(path.join(TMP_HOME, '.khy', 'agents', 'researcher.md'));
    expect(fs.existsSync(agent.path)).toBe(true);
  });

  test('SKILL.md has parseable frontmatter + mermaid + steps', async () => {
    await exportSvc.exportWorkflow(user.id, id, { homeDir: TMP_HOME });
    const slug = exportSvc.slugFor(user.id, '研究流程');
    const md = fs.readFileSync(path.join(TMP_HOME, '.khyquant', 'skills', slug, 'SKILL.md'), 'utf-8');

    expect(md).toMatch(/^---\n[\s\S]*?\n---\n/);          // frontmatter block
    expect(md).toContain(`name: ${slug}`);
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('## Execution Steps');
    expect(md).toContain('看多');                          // branch label on edge
    expect(md).toContain('researcher');                     // subAgent reference
  });

  test('agent .md carries name/description/model and the instructions body', async () => {
    await exportSvc.exportWorkflow(user.id, id, { homeDir: TMP_HOME });
    const md = fs.readFileSync(path.join(TMP_HOME, '.khy', 'agents', 'researcher.md'), 'utf-8');
    expect(md).toContain('name: researcher');
    expect(md).toContain('model: sonnet');
    expect(md).toContain('tools: [WebSearch]');
    expect(md).toContain('研究 {{sym}} 的基本面');
  });

  test('rejects export of an incomplete graph (no end node)', async () => {
    const wf = await svc.create(user.id, { name: '半成品' });
    await svc.save(user.id, wf.id, {
      graph: { nodes: [{ id: 's', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} }], connections: [] },
    });
    await expect(exportSvc.exportWorkflow(user.id, wf.id, { homeDir: TMP_HOME })).rejects.toThrow(/end/);
  });
});

describe('exportWorkflow — provider targeting', () => {
  let id;
  const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `khy-wf-root-${process.pid}-`));

  beforeAll(async () => {
    const wf = await svc.create(user.id, { name: '多端流程' });
    id = wf.id;
    await svc.save(user.id, id, { graph: COMPLETE_GRAPH });
  });

  afterAll(() => {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('default provider is khy and lands under home (regression lock)', async () => {
    const out = await exportSvc.exportWorkflow(user.id, id, { homeDir: TMP_HOME });
    expect(out.provider).toBe('khy');
    expect(out.summary.run).toBe(`goal: run ${out.slug}`);
    const skill = out.files.find((f) => f.kind === 'skill');
    expect(skill.path).toBe(path.join(TMP_HOME, '.khyquant', 'skills', out.slug, 'SKILL.md'));
    expect(out.files.find((f) => f.kind === 'agent').path)
      .toBe(path.join(TMP_HOME, '.khy', 'agents', 'researcher.md'));
  });

  test('claude-code writes to project .claude dirs with provider tool legend', async () => {
    const out = await exportSvc.exportWorkflow(user.id, id, { provider: 'claude-code', rootDir: TMP_ROOT });
    expect(out.provider).toBe('claude-code');
    expect(out.summary.run).toBe(`/${out.slug}`);

    const skill = out.files.find((f) => f.kind === 'skill');
    expect(skill.path).toBe(path.join(TMP_ROOT, '.claude', 'commands', out.slug, 'SKILL.md'));
    const agent = out.files.find((f) => f.kind === 'agent');
    expect(agent.path).toBe(path.join(TMP_ROOT, '.claude', 'agents', 'researcher.md'));

    const md = fs.readFileSync(skill.path, 'utf-8');
    expect(md).toContain('## 执行方式（Claude Code）');
    expect(md).toContain('AskUserQuestion 工具');
    expect(md).toContain('Task 工具');
  });

  test('codex writes a single skill (no agent dir) with codex tool names', async () => {
    const out = await exportSvc.exportWorkflow(user.id, id, { provider: 'codex', rootDir: TMP_ROOT });
    expect(out.provider).toBe('codex');
    expect(out.summary.run).toBe(`$${out.slug}`);
    expect(out.summary.agents).toBe(0);
    expect(out.files.some((f) => f.kind === 'agent')).toBe(false);

    const skill = out.files.find((f) => f.kind === 'skill');
    expect(skill.path).toBe(path.join(TMP_ROOT, '.codex', 'skills', out.slug, 'SKILL.md'));
    const md = fs.readFileSync(skill.path, 'utf-8');
    expect(md).toContain('ask_user_question 工具');
    expect(md).toContain('spawn_agent 工具');
  });

  test('rejects an unknown provider with a 400-style error', async () => {
    await expect(
      exportSvc.exportWorkflow(user.id, id, { provider: 'no-such-agent', rootDir: TMP_ROOT })
    ).rejects.toThrow(/Unknown export provider/);
  });
});
