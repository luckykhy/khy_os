'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('teachingService.captureTeaching', () => {
  let tmp;
  let svc;
  let teaching;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-teach-'));
    process.env.KHY_DATA_HOME = tmp;
    jest.resetModules();
    svc = require('../../src/services/agentFs/agentFsService');
    teaching = require('../../src/services/teachingService');
  });

  afterEach(() => {
    delete process.env.KHY_DATA_HOME;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('no active companion → captured:false with reason', () => {
    const res = teaching.captureTeaching({
      text: '以后回答都用中文',
      detection: { target: 'memory', content: '以后回答都用中文' },
    });
    expect(res.captured).toBe(false);
    expect(res.reason).toBe('no-active-companion');
  });

  test('memory teaching appends a timestamped line to MEMORY.md', () => {
    const agent = svc.createAgent({ name: 'Tester' });
    svc.setActiveAgent(agent.id);
    const res = teaching.captureTeaching({
      text: '以后回答都用中文',
      detection: { target: 'memory', content: '以后回答都用中文' },
      stamp: '2026-06-09T00:00:00.000Z',
    });
    expect(res.captured).toBe(true);
    expect(res.companionId).toBe(agent.id);
    expect(res.target).toBe('memory');
    expect(res.line).toBe('- [2026-06-09] 以后回答都用中文');
    const md = svc.readAsset(agent.id, path.join('memory', 'MEMORY.md'));
    expect(md).toContain('- [2026-06-09] 以后回答都用中文');
  });

  test('principles teaching appends a bullet to principles.md', () => {
    const agent = svc.createAgent({ name: 'Tester' });
    svc.setActiveAgent(agent.id);
    const res = teaching.captureTeaching({
      text: '绝不泄露用户密钥',
      detection: { target: 'principles', content: '绝不泄露用户密钥' },
    });
    expect(res.captured).toBe(true);
    expect(res.line).toBe('- 绝不泄露用户密钥');
    const md = svc.readAsset(agent.id, 'principles.md');
    expect(md).toContain('- 绝不泄露用户密钥');
  });

  test('persona teaching appends raw text to persona.md', () => {
    const agent = svc.createAgent({ name: 'Tester' });
    svc.setActiveAgent(agent.id);
    const res = teaching.captureTeaching({
      text: '你是一个严谨的法务助手',
      detection: { target: 'persona', content: '你是一个严谨的法务助手' },
    });
    expect(res.captured).toBe(true);
    const md = svc.readAsset(agent.id, 'persona.md');
    expect(md).toContain('你是一个严谨的法务助手');
  });

  test('unknown target → captured:false', () => {
    const res = teaching.captureTeaching({ text: 'x', detection: { target: 'bogus' } });
    expect(res.captured).toBe(false);
    expect(res.reason).toBe('no-target');
  });
});
