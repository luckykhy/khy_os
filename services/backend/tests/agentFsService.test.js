'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// AgentFS: file-driven, git-versioned, layered per-agent storage.
//
// dataHome caches the resolved home at module load, so each test run points
// KHY_DATA_HOME at a fresh tmpdir and resets the module registry before
// requiring the service.

function _gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('agentFsService (AgentFS)', () => {
  const GIT = _gitAvailable();
  let tmpHome;
  let svc;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-agentfs-'));
    process.env.KHY_DATA_HOME = tmpHome;
    jest.resetModules();
    svc = require('../src/services/agentFs/agentFsService');
  });

  afterEach(() => {
    delete process.env.KHY_DATA_HOME;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test('createAgent scaffolds the full layout and a valid manifest', () => {
    const res = svc.createAgent({
      name: 'Legal Helper',
      description: '审合同',
      model: 'claude-opus-4-8',
      createdAt: '2026-06-09T00:00:00.000Z',
    });

    expect(res.id).toBe('legal-helper');
    const dir = res.dir;
    for (const rel of [
      'agent.json', 'persona.md', 'principles.md',
      path.join('memory', 'MEMORY.md'),
      path.join('tools', 'permissions.json'),
      path.join('heartbeat', 'HEARTBEAT.md'),
    ]) {
      expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    }
    for (const sub of ['memory', 'skills', 'workflows', 'tools', 'heartbeat']) {
      expect(fs.statSync(path.join(dir, sub)).isDirectory()).toBe(true);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf-8'));
    expect(manifest.id).toBe('legal-helper');
    expect(manifest.name).toBe('Legal Helper');
    expect(manifest.model).toBe('claude-opus-4-8');
    expect(manifest.schema).toBe('agentfs');
    expect(manifest.version).toBe(1);
  });

  test('createAgent rejects an explicit id of a non-ASCII / Chinese name', () => {
    // Chinese name slugifies to empty → must require explicit id.
    expect(() => svc.createAgent({ name: '法务助手' })).toThrow(/无法从名称|id/);
    const res = svc.createAgent({ name: '法务助手', id: 'fawu', createdAt: '2026-06-09T00:00:00.000Z' });
    expect(res.id).toBe('fawu');
    expect(res.manifest.name).toBe('法务助手');
  });

  test('duplicate create is refused', () => {
    svc.createAgent({ name: 'dup', createdAt: '2026-06-09T00:00:00.000Z' });
    expect(() => svc.createAgent({ name: 'dup' })).toThrow(/已存在/);
  });

  test('id validation rejects path traversal and absolute paths', () => {
    expect(() => svc._agentDir('../evil')).toThrow();
    expect(() => svc._agentDir('/etc/passwd')).toThrow();
    expect(() => svc._agentDir('a/b')).toThrow();
    expect(() => svc._agentDir('-leading')).toThrow();
    expect(() => svc._agentDir('UPPER')).toThrow();
    // valid id passes
    expect(() => svc._agentDir('ok-1_id')).not.toThrow();
  });

  test('listAgents and getAgent round-trip', () => {
    svc.createAgent({ name: 'alpha', createdAt: '2026-06-09T00:00:00.000Z' });
    svc.createAgent({ name: 'beta', createdAt: '2026-06-09T00:00:00.000Z' });
    const ids = svc.listAgents().map(a => a.id);
    expect(ids).toEqual(['alpha', 'beta']);
    expect(svc.getAgent('alpha').manifest.name).toBe('alpha');
    expect(svc.getAgent('nope')).toBeNull();
  });

  test('loadLayered is cumulative: bytes(L0) < bytes(L1) < bytes(L2)', () => {
    const { id } = svc.createAgent({ name: 'layered', createdAt: '2026-06-09T00:00:00.000Z' });
    // Give L1/L2 something to grow with.
    svc.writeAsset(id, path.join('memory', 'MEMORY.md'), '# Memory\n- pointer to note-1\n');
    svc.writeAsset(id, path.join('memory', 'note-1.md'), '# Note 1\n'.padEnd(600, 'x') + '\n');

    const l0 = svc.loadLayered(id, 'L0');
    const l1 = svc.loadLayered(id, 'L1');
    const l2 = svc.loadLayered(id, 'L2');

    expect(l0.level).toBe('L0');
    expect(l0.bytes).toBeLessThan(l1.bytes);
    expect(l1.bytes).toBeLessThan(l2.bytes);

    // L0 carries identity + red lines but not full memory.
    expect(l0.text).toContain('layered');
    expect(l0.text).toContain('red lines');
    expect(l0.text).not.toContain('note-1.md');

    // L2 pulls in the full memory file content.
    expect(l2.text).toContain('note-1.md');

    // Unknown level falls back to L0.
    expect(svc.loadLayered(id, 'BOGUS').level).toBe('L0');
  });

  test('readAsset/writeAsset round-trip with traversal guard', () => {
    const { id } = svc.createAgent({ name: 'rw', createdAt: '2026-06-09T00:00:00.000Z' });
    expect(svc.writeAsset(id, 'persona.md', '# Persona\n## Tone\n- terse\n')).toBeTruthy();
    expect(svc.readAsset(id, 'persona.md')).toContain('terse');
    expect(svc.readAsset(id, 'missing.md')).toBeNull();
    expect(() => svc.writeAsset(id, '../escape.md', 'x')).toThrow(/穿越/);
  });

  // ── git-dependent assertions (skipped cleanly when git is absent) ──
  (GIT ? test : test.skip)('createAgent makes a first commit; writeAsset adds history', () => {
    const { id, dir, versioned } = svc.createAgent({ name: 'versioned', createdAt: '2026-06-09T00:00:00.000Z' });
    expect(versioned).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);

    const before = svc.history(id);
    expect(before.length).toBeGreaterThanOrEqual(1);

    svc.writeAsset(id, 'persona.md', '# Persona\nedited\n', { message: 'test: edit persona' });
    const after = svc.history(id);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].subject).toContain('edit persona');
  });

  (GIT ? test : test.skip)('revertTo restores a prior commit', () => {
    const { id } = svc.createAgent({ name: 'revert', createdAt: '2026-06-09T00:00:00.000Z' });
    svc.writeAsset(id, 'persona.md', 'VERSION_A\n', { message: 'A' });
    const histA = svc.history(id);
    const commitA = histA[0].hash;
    svc.writeAsset(id, 'persona.md', 'VERSION_B\n', { message: 'B' });
    expect(svc.readAsset(id, 'persona.md')).toContain('VERSION_B');

    const res = svc.revertTo(id, commitA);
    expect(res.reverted).toBe(true);
    expect(svc.readAsset(id, 'persona.md')).toContain('VERSION_A');
  });

  // ── Phase 2: active companion pointer + prompt section ──
  test('active pointer set/get/clear round-trip', () => {
    svc.createAgent({ name: 'one', createdAt: '2026-06-09T00:00:00.000Z' });
    svc.createAgent({ name: 'two', createdAt: '2026-06-09T00:00:00.000Z' });
    expect(svc.getActiveAgentId()).toBeNull();

    svc.setActiveAgent('one');
    expect(svc.getActiveAgentId()).toBe('one');
    svc.setActiveAgent('two');
    expect(svc.getActiveAgentId()).toBe('two');

    svc.clearActiveAgent();
    expect(svc.getActiveAgentId()).toBeNull();
    // clear is idempotent
    expect(() => svc.clearActiveAgent()).not.toThrow();
  });

  test('setActiveAgent rejects a missing agent', () => {
    expect(() => svc.setActiveAgent('ghost')).toThrow(/不存在/);
  });

  test('getActiveAgentId ignores a deleted agent', () => {
    const { id, dir } = svc.createAgent({ name: 'tmp', createdAt: '2026-06-09T00:00:00.000Z' });
    svc.setActiveAgent(id);
    expect(svc.getActiveAgentId()).toBe(id);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(svc.getActiveAgentId()).toBeNull();
  });

  test('companionPromptSection is null when none active, populated when active', () => {
    expect(svc.companionPromptSection()).toBeNull();

    const { id } = svc.createAgent({ name: 'promo', createdAt: '2026-06-09T00:00:00.000Z' });
    svc.writeAsset(id, 'principles.md', '# Principles\n- never leak secrets\n');
    svc.setActiveAgent(id);

    const section = svc.companionPromptSection({ level: 'L1' });
    expect(section).toContain('Active Companion');
    expect(section).toContain('promo');
    expect(section).toContain('never leak secrets');
  });

  test('activeStamp changes on switch and on edit', () => {
    const a = svc.createAgent({ name: 'sa', createdAt: '2026-06-09T00:00:00.000Z' }).id;
    const b = svc.createAgent({ name: 'sb', createdAt: '2026-06-09T00:00:00.000Z' }).id;
    expect(svc.activeStamp()).toBe('none');

    svc.setActiveAgent(a);
    const stampA = svc.activeStamp();
    svc.setActiveAgent(b);
    expect(svc.activeStamp()).not.toBe(stampA);

    svc.setActiveAgent(a);
    const before = svc.activeStamp();
    svc.writeAsset(a, 'persona.md', '# Persona\nchanged\n');
    expect(svc.activeStamp()).not.toBe(before);
  });

  // ── Five-asset model (借鉴分析 #2) ──────────────────────────────────────────
  test('ASSET_MODEL declares the five governable assets', () => {
    const keys = svc.ASSET_MODEL.map(a => a.key);
    expect(keys).toEqual(['persona', 'playbook', 'memory', 'toolBody', 'receipts']);
  });

  test('describeAssets reports presence and sizes for a fresh agent', () => {
    const id = svc.createAgent({ name: 'asset agent', createdAt: '2026-06-09T00:00:00.000Z' }).id;
    const assets = svc.describeAssets(id);
    const byKey = Object.fromEntries(assets.map(a => [a.key, a]));

    expect(byKey.persona.present).toBe(true);
    expect(byKey.persona.files.some(f => f.rel === 'persona.md')).toBe(true);
    expect(byKey.memory.present).toBe(true);
    expect(byKey.toolBody.present).toBe(true);
    // workflows/ is scaffolded empty → playbook has no files yet.
    expect(byKey.playbook.present).toBe(false);
    // receipts is external; none recorded for a brand-new agent.
    expect(byKey.receipts.count).toBe(0);
    expect(byKey.receipts.present).toBe(false);
  });

  test('describeAssets does not throw when an asset file is missing', () => {
    const id = svc.createAgent({ name: 'gap agent', createdAt: '2026-06-09T00:00:00.000Z' }).id;
    const dir = svc.getAgent(id).dir;
    fs.unlinkSync(path.join(dir, 'persona.md'));
    fs.unlinkSync(path.join(dir, 'principles.md'));
    const assets = svc.describeAssets(id);
    const persona = assets.find(a => a.key === 'persona');
    expect(persona.present).toBe(false);
    expect(persona.files).toHaveLength(0);
  });

  test('receipts associate with the active companion and filter by id', () => {
    const id = svc.createAgent({ name: 'receipt agent', createdAt: '2026-06-09T00:00:00.000Z' }).id;
    svc.setActiveAgent(id);
    const rcpt = require('../src/services/receiptService');
    rcpt.startReceipt({ sessionId: 'sess-1', goal: 'do something' });
    rcpt.appendToolCall({
      sessionId: 'sess-1', tool: 'read_file', params: { path: '/x' },
      result: { success: true }, permission: 'allow', stepType: 'hardened', risk: 'safe',
    });
    rcpt.finalizeReceipt({ sessionId: 'sess-1', status: 'ok' });

    const mine = rcpt.listReceipts({ companionId: id });
    expect(mine).toHaveLength(1);
    expect(mine[0].companionId).toBe(id);
    expect(rcpt.listReceipts({ companionId: 'nobody' })).toHaveLength(0);

    // describeAssets reflects the recorded receipt.
    const receiptsAsset = svc.describeAssets(id).find(a => a.key === 'receipts');
    expect(receiptsAsset.count).toBe(1);
    expect(receiptsAsset.present).toBe(true);
  });
});
