'use strict';

/**
 * deploy.test.js — unit locks for the `deploy` tool (src/tools/deploy.js).
 *
 * The tool is a thin wrapper over the singleton deployOrchestrator. The remote
 * subsystem is mocked so the tests assert the tool contract: schema, default
 * dry-run, explicit content (not a JSON dump), transparent meta, and the
 * failure path.
 */

const mockDeploy = jest.fn();

jest.mock('../../src/services/remote', () => ({
  deployOrchestrator: { deploy: mockDeploy },
}));

const deployTool = require('../../src/tools/deploy');

describe('deploy tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('schema requires target and exposes execution metadata', () => {
    expect(deployTool.name).toBe('deploy');
    expect(deployTool.category).toBe('execution');
    expect(deployTool.risk).toBe('high');
    expect(deployTool.isReadOnly()).toBe(false);
    expect(deployTool.isConcurrencySafe()).toBe(false);

    const missing = deployTool.validate({});
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/target is required/i);

    const ok = deployTool.validate({ target: 'web' });
    expect(ok.valid).toBe(true);
  });

  test('defaults to dry-run (confirm omitted) and renders a readable plan', async () => {
    mockDeploy.mockResolvedValue({
      success: true,
      mode: 'dry-run',
      status: 'awaiting_approval',
      hostAlias: 'web',
      archivePath: '/tmp/b.tar.gz',
      bundleName: 'b',
      deployDir: '~/srv',
      remoteTarPath: 'b.tar.gz',
      plannedCommands: ['mkdir -p ~/srv', 'tar -xzf ...', 'cd ~/srv/b && docker compose up -d --build'],
      risk: { highest_risk: 'moderate' },
      ticketId: 'ticket-123',
      execEnabled: false,
    });

    const res = await deployTool.execute({ target: 'web' });

    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ hostAlias: 'web', confirm: false }));
    expect(res.success).toBe(true);
    expect(res.mode).toBe('dry-run');
    expect(typeof res.content).toBe('string');
    expect(res.content).toContain('DRY-RUN');
    expect(res.content).toContain('ticket-123');
    expect(res.content).not.toMatch(/^\{/); // not a raw JSON dump
    expect(res.meta.mode).toBe('dry-run');
    expect(res.meta.hostAlias).toBe('web');
    expect(res.meta.execEnabled).toBe(false);
  });

  test('passes confirm + approvalTicketId through for a real apply', async () => {
    mockDeploy.mockResolvedValue({
      success: true,
      mode: 'apply',
      status: 'completed',
      hostAlias: 'web',
      execEnabled: true,
      execResult: { summary: { total_steps: 3, succeeded_steps: 3 } },
    });

    const res = await deployTool.execute({ target: 'web', confirm: true, approvalTicketId: 'ticket-123' });

    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({
      hostAlias: 'web', confirm: true, approvalTicketId: 'ticket-123',
    }));
    expect(res.success).toBe(true);
    expect(res.content).toContain('APPLY');
    expect(res.content).toContain('3/3');
    expect(res.meta.execEnabled).toBe(true);
  });

  test('failure path surfaces error as content and success:false', async () => {
    mockDeploy.mockResolvedValue({
      success: false,
      mode: 'dry-run',
      status: 'host_not_found',
      hostAlias: 'ghost',
      error: 'No host alias "ghost" found in SSH config.',
      execEnabled: false,
    });

    const res = await deployTool.execute({ target: 'ghost' });

    expect(res.success).toBe(false);
    expect(res.content).toContain('host_not_found');
    expect(res.content).toContain('ghost');
    expect(res.meta.hostAlias).toBe('ghost');
  });

  test('orchestrator throwing is caught into a structured failure', async () => {
    mockDeploy.mockRejectedValue(new Error('boom'));

    const res = await deployTool.execute({ target: 'web' });

    expect(res.success).toBe(false);
    expect(res.status).toBe('deploy_error');
    expect(res.content).toContain('boom');
  });
});
