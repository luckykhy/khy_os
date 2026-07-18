'use strict';

/**
 * deployOrchestrator.test.js — unit locks for the deploy pipeline orchestration.
 *
 * All heavy deps are faked. A real RemoteApprovalBridge is used for realistic
 * ticket lifecycle. Asserts the security contract: default dry-run never touches
 * the remote, apply requires an approved ticket + exec gate, and host/credential
 * failures short-circuit before any session/exec.
 */

const { createDeployOrchestrator } = require('../../src/services/remote/deployOrchestrator');
const { createRemoteApprovalBridge } = require('../../src/services/remote/remoteApprovalBridge');

function buildDeps(overrides = {}) {
  const sessions = new Map();
  let counter = 0;

  const connectionManager = {
    connect: jest.fn(({ hostEntry, workspace, traceId }) => {
      const connectionId = `conn-${++counter}`;
      const session = {
        connectionId,
        hostAlias: hostEntry.alias,
        host: hostEntry.host,
        port: hostEntry.port,
        remoteUser: hostEntry.user,
        remoteWorkspace: workspace,
        traceId: traceId || null,
      };
      sessions.set(connectionId, session);
      return { ...session };
    }),
    getSession: jest.fn((id) => sessions.get(id) || null),
    touch: jest.fn(() => true),
  };

  const approvalBridge = createRemoteApprovalBridge();

  const execService = {
    planDryRun: jest.fn(() => ({ risk_summary: { highest_risk: 'moderate', reason: 'docker compose', approval_required: false } })),
    requestExecution: jest.fn(async () => ({ status: 'completed', summary: { total_steps: 3, succeeded_steps: 3, failed_steps: 0 } })),
  };

  const fileTransferService = {
    upload: jest.fn(async () => ({ ok: true, status: 'uploaded', remote_path: 'bundle.tar.gz' })),
  };

  const sshConfigService = {
    listHosts: jest.fn(() => ({
      configPath: '/home/u/.ssh/config',
      hosts: [{ alias: 'web', host: 'web.example.com', port: 22, user: 'deploy', identityFile: null, remoteWorkspace: '~/srv' }],
    })),
  };

  const sshCredentialGuard = {
    validateHostCredentials: jest.fn(() => ({ ok: true, code: 'identity_file_valid', message: 'ok' })),
  };

  const workspaceResolver = {
    resolveWorkspace: jest.fn(() => '~/srv'),
  };

  const buildDockerBundle = jest.fn(() => ({ archivePath: '/tmp/dist/khy-os-docker-1.0.0-x.tar.gz', bundleName: 'khy-os-docker-1.0.0-x' }));

  return {
    connectionManager,
    approvalBridge,
    execService,
    fileTransferService,
    sshConfigService,
    sshCredentialGuard,
    workspaceResolver,
    buildDockerBundle,
    ...overrides,
  };
}

describe('DeployOrchestrator', () => {
  const originalEnableExec = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;

  afterEach(() => {
    if (originalEnableExec === undefined) delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    else process.env.KHY_REMOTE_SSH_ENABLE_EXEC = originalEnableExec;
  });

  test('dry-run builds bundle, plans, emits ticket, and never touches the remote', async () => {
    const deps = buildDeps();
    const orch = createDeployOrchestrator(deps);

    const res = await orch.deploy({ hostAlias: 'web', projectRoot: '/proj' });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('dry-run');
    expect(res.status).toBe('awaiting_approval');
    expect(res.ticketId).toBeTruthy();
    expect(res.deployDir).toBe('~/srv');
    expect(res.plannedCommands).toHaveLength(3);
    expect(res.plannedCommands[2]).toContain('docker compose up -d --build');
    // No remote side effects in dry-run.
    expect(deps.fileTransferService.upload).not.toHaveBeenCalled();
    expect(deps.execService.requestExecution).not.toHaveBeenCalled();
    expect(deps.execService.planDryRun).toHaveBeenCalledTimes(1);
  });

  test('apply requires an approved ticket (pending ticket is rejected)', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    const deps = buildDeps();
    const orch = createDeployOrchestrator(deps);

    const dry = await orch.deploy({ hostAlias: 'web' });
    // Ticket not approved yet.
    const res = await orch.deploy({ hostAlias: 'web', confirm: true, approvalTicketId: dry.ticketId });

    expect(res.success).toBe(false);
    expect(res.status).toBe('ticket_not_approved');
    expect(deps.fileTransferService.upload).not.toHaveBeenCalled();
    expect(deps.execService.requestExecution).not.toHaveBeenCalled();
  });

  test('approved apply uploads the bundle then runs the remote commands', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    const deps = buildDeps();
    const orch = createDeployOrchestrator(deps);

    const dry = await orch.deploy({ hostAlias: 'web' });
    deps.approvalBridge.approveTicket(dry.ticketId, 'reviewer');

    const res = await orch.deploy({ hostAlias: 'web', confirm: true, approvalTicketId: dry.ticketId });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('apply');
    expect(res.status).toBe('completed');
    expect(deps.fileTransferService.upload).toHaveBeenCalledTimes(1);
    expect(deps.execService.requestExecution).toHaveBeenCalledTimes(1);
    // Ticket was consumed (single-use).
    const ticket = deps.approvalBridge.getTicket(dry.ticketId);
    expect(ticket.consumed_at).toBeTruthy();
  });

  test('apply is blocked by the exec gate and does not consume the ticket', async () => {
    delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    const deps = buildDeps();
    const orch = createDeployOrchestrator(deps);

    const dry = await orch.deploy({ hostAlias: 'web' });
    deps.approvalBridge.approveTicket(dry.ticketId, 'reviewer');

    const res = await orch.deploy({ hostAlias: 'web', confirm: true, approvalTicketId: dry.ticketId });

    expect(res.success).toBe(false);
    expect(res.status).toBe('execution_disabled');
    expect(deps.fileTransferService.upload).not.toHaveBeenCalled();
    const ticket = deps.approvalBridge.getTicket(dry.ticketId);
    expect(ticket.consumed_at).toBeFalsy();
  });

  test('unknown host alias fails before any session is opened', async () => {
    const deps = buildDeps();
    const orch = createDeployOrchestrator(deps);

    const res = await orch.deploy({ hostAlias: 'nope' });

    expect(res.success).toBe(false);
    expect(res.status).toBe('host_not_found');
    expect(deps.connectionManager.connect).not.toHaveBeenCalled();
    expect(deps.buildDockerBundle).not.toHaveBeenCalled();
  });

  test('insecure credentials are rejected before bundling', async () => {
    const deps = buildDeps();
    deps.sshCredentialGuard.validateHostCredentials = jest.fn(() => ({ ok: false, code: 'identity_file_insecure_mode', message: 'key too open' }));
    const orch = createDeployOrchestrator(deps);

    const res = await orch.deploy({ hostAlias: 'web' });

    expect(res.success).toBe(false);
    expect(res.status).toBe('credential_invalid');
    expect(deps.buildDockerBundle).not.toHaveBeenCalled();
  });
});
