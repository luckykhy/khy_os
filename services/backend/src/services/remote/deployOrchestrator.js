'use strict';

/**
 * deployOrchestrator — end-to-end "build → ship → run" deploy pipeline that
 * stitches together existing remote primitives:
 *
 *   1. build a Docker bundle locally (publish._buildDockerBundle)
 *   2. resolve the target host from ~/.ssh/config (sshConfigService) and
 *      validate its key permissions (sshCredentialGuard)
 *   3. (dry-run, default) create a pending approval ticket + risk plan WITHOUT
 *      touching the remote — no upload, no execution
 *   4. (apply, confirm:true) require an APPROVED ticket, scp the bundle up
 *      (remoteFileTransferService), then run the deploy commands remotely
 *      (remoteExecService)
 *
 * Security posture (per product requirement "关注安全性，避免潜在漏洞"):
 *   - Force approval: every deploy creates a ticket and apply refuses to run
 *     until that ticket is approved out-of-band, EVEN THOUGH `docker compose up`
 *     only classifies as `moderate` (which the exec service would otherwise run
 *     without approval). Approval is enforced here, in the orchestrator.
 *   - Default dry-run: a deploy call with no `confirm:true` never mutates the
 *     remote; it only plans and emits a ticket.
 *   - Triple gate for a real apply: confirm:true + approved approvalTicketId +
 *     KHY_REMOTE_SSH_ENABLE_EXEC=true.
 *   - Zero hardcoding: host/user/port/key come only from ~/.ssh/config; the
 *     remote deploy directory is validated against the workspace allowlist.
 *
 * Cross-invocation state (dry-run → human approval → apply) is held in an
 * in-memory map keyed by ticket id, matching the in-memory ticket/session model
 * of the rest of the remote subsystem (single process lifetime).
 */

// 收敛到 utils/envFlagByName 单一真源(逐字节委托,调用点不变)
const _envFlag = require('../../utils/envFlagByName');

/** POSIX single-quote a value for safe interpolation into a remote shell command. */
function _shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class DeployOrchestrator {
  constructor(deps = {}) {
    this._connectionManager = deps.connectionManager;
    this._approvalBridge = deps.approvalBridge;
    this._execService = deps.execService;
    this._fileTransferService = deps.fileTransferService;
    this._sshConfigService = deps.sshConfigService;
    this._sshCredentialGuard = deps.sshCredentialGuard;
    this._workspaceResolver = deps.workspaceResolver;
    // (projectRoot) => { archivePath, bundleName, ... }
    this._buildDockerBundle = deps.buildDockerBundle;
    // ticket_id -> { connectionId, idempotencyKey, commands, archivePath, bundleName, remoteTarPath, deployDir, hostAlias }
    this._pendingDeploys = new Map();
  }

  _resolveHost(hostAlias) {
    const listed = this._sshConfigService.listHosts();
    const hosts = (listed && Array.isArray(listed.hosts)) ? listed.hosts : [];
    const hostEntry = hosts.find((h) => h && h.alias === hostAlias) || null;
    return { hostEntry, configPath: listed && listed.configPath };
  }

  _buildDeployCommands({ deployDir, bundleName, remoteTarPath }) {
    const dirQ = _shellSingleQuote(deployDir);
    const tarQ = _shellSingleQuote(remoteTarPath);
    const bundleDirQ = _shellSingleQuote(`${deployDir}/${bundleName}`);
    return [
      `mkdir -p ${dirQ}`,
      `tar -xzf ${tarQ} -C ${dirQ}`,
      `cd ${bundleDirQ} && docker compose up -d --build`,
    ];
  }

  /**
   * @param {object} params
   * @param {string} params.hostAlias  SSH config alias of the target host.
   * @param {string} [params.projectRoot]  Project to bundle (default cwd).
   * @param {string} [params.remoteWorkspace]  Remote deploy dir override.
   * @param {boolean} [params.confirm]  true = real apply; default false = dry-run.
   * @param {string} [params.approvalTicketId]  Required when confirm:true.
   */
  async deploy(params = {}) {
    const hostAlias = String(params.hostAlias || '').trim();
    if (!hostAlias) {
      return { success: false, mode: params.confirm ? 'apply' : 'dry-run', status: 'host_alias_required', error: 'A target host alias is required.' };
    }
    if (params.confirm === true) {
      return this._apply({ approvalTicketId: params.approvalTicketId, traceId: params.traceId, onEvent: params.onEvent });
    }
    return this._dryRun({
      hostAlias,
      projectRoot: params.projectRoot,
      remoteWorkspace: params.remoteWorkspace,
      traceId: params.traceId,
      onEvent: params.onEvent,
    });
  }

  async _dryRun({ hostAlias, projectRoot, remoteWorkspace, traceId, onEvent }) {
    const execEnabled = _envFlag('KHY_REMOTE_SSH_ENABLE_EXEC', false);

    // 1. Resolve host (zero-hardcoding: only from ~/.ssh/config).
    const { hostEntry, configPath } = this._resolveHost(hostAlias);
    if (!hostEntry) {
      return {
        success: false,
        mode: 'dry-run',
        status: 'host_not_found',
        hostAlias,
        error: `No host alias "${hostAlias}" found in SSH config (${configPath || '~/.ssh/config'}).`,
        execEnabled,
      };
    }

    // 2. Validate credentials (key exists, permissions <= 600).
    const cred = this._sshCredentialGuard.validateHostCredentials(hostEntry);
    if (!cred.ok) {
      return {
        success: false,
        mode: 'dry-run',
        status: 'credential_invalid',
        hostAlias,
        error: cred.message,
        code: cred.code,
        execEnabled,
      };
    }

    // 3. Resolve remote deploy dir (workspace allowlist enforced).
    let deployDir;
    try {
      deployDir = this._workspaceResolver.resolveWorkspace({ requestedWorkspace: remoteWorkspace, hostEntry });
    } catch (err) {
      return {
        success: false,
        mode: 'dry-run',
        status: 'workspace_rejected',
        hostAlias,
        error: err.message,
        code: err.code || 'workspace_rejected',
        execEnabled,
      };
    }

    // 4. Build the Docker bundle locally (safe, no remote side effect).
    let bundle;
    try {
      bundle = this._buildDockerBundle(projectRoot);
    } catch (err) {
      return {
        success: false,
        mode: 'dry-run',
        status: 'bundle_failed',
        hostAlias,
        error: err.message || String(err),
        execEnabled,
      };
    }
    const { archivePath, bundleName } = bundle;
    const remoteTarPath = `${bundleName}.tar.gz`; // lands in remote home; no pre-mkdir needed
    const commands = this._buildDeployCommands({ deployDir, bundleName, remoteTarPath });

    // 5. Open a session. Workspace is home so exec's `cd` always succeeds; the
    //    deploy dir is referenced explicitly inside the commands.
    const session = this._connectionManager.connect({
      hostEntry,
      workspace: '~',
      purpose: 'deploy',
      traceId: traceId || null,
    });

    // 6. Force-approval: always create a ticket for the deploy commands.
    const idempotencyKey = `deploy-${bundleName}`;
    const ticket = this._approvalBridge.createTicket({
      traceId: traceId || null,
      connectionId: session.connectionId,
      hostAlias,
      commands,
      idempotencyKey,
      riskContext: { kind: 'deploy', host_alias: hostAlias, deploy_dir: deployDir },
    });

    // 7. Risk plan for each command (no execution).
    const plan = this._execService.planDryRun({
      connectionId: session.connectionId,
      commands,
      traceId: traceId || null,
      riskContext: { kind: 'deploy', host_alias: hostAlias },
    });

    this._pendingDeploys.set(ticket.ticket_id, {
      connectionId: session.connectionId,
      idempotencyKey,
      commands,
      archivePath,
      bundleName,
      remoteTarPath,
      deployDir,
      hostAlias,
    });

    if (typeof onEvent === 'function') {
      try { onEvent({ kind: 'deploy_planned', host_alias: hostAlias, ticket_id: ticket.ticket_id }); } catch { /* ignore */ }
    }

    return {
      success: true,
      mode: 'dry-run',
      status: 'awaiting_approval',
      hostAlias,
      archivePath,
      bundleName,
      deployDir,
      remoteTarPath,
      plannedCommands: commands,
      risk: plan.risk_summary,
      ticketId: ticket.ticket_id,
      connectionId: session.connectionId,
      execEnabled,
      hint: `Approve ticket ${ticket.ticket_id} (POST /api/remote/ssh/approvals/decision), then call deploy again with confirm:true and approvalTicketId=${ticket.ticket_id}.`
        + (execEnabled ? '' : ' NOTE: set KHY_REMOTE_SSH_ENABLE_EXEC=true to allow the real apply.'),
    };
  }

  async _apply({ approvalTicketId, traceId, onEvent }) {
    const execEnabled = _envFlag('KHY_REMOTE_SSH_ENABLE_EXEC', false);
    const ticketId = String(approvalTicketId || '').trim();
    if (!ticketId) {
      return { success: false, mode: 'apply', status: 'approval_ticket_required', error: 'confirm:true requires an approvalTicketId from a prior dry-run.', execEnabled };
    }

    const ctx = this._pendingDeploys.get(ticketId);
    if (!ctx) {
      return { success: false, mode: 'apply', status: 'unknown_deploy_ticket', error: 'No pending deploy for this ticket; run a dry-run first (deploy without confirm).', execEnabled };
    }

    const ticket = this._approvalBridge.getTicket(ticketId);
    if (!ticket) {
      return { success: false, mode: 'apply', status: 'ticket_not_found', error: 'Approval ticket not found or expired.', execEnabled };
    }
    if (ticket.status !== 'approved') {
      return { success: false, mode: 'apply', status: 'ticket_not_approved', error: `Approval ticket status is "${ticket.status}"; it must be approved before applying.`, ticketId, execEnabled };
    }

    // Gate early so we do not consume the ticket when execution is disabled.
    if (!execEnabled) {
      return {
        success: false,
        mode: 'apply',
        status: 'execution_disabled',
        hostAlias: ctx.hostAlias,
        ticketId,
        error: 'Remote deploy execution is disabled. Set KHY_REMOTE_SSH_ENABLE_EXEC=true to apply.',
        execEnabled,
      };
    }

    // Force single-use: consume the approval here (exec service treats the
    // moderate `docker compose up` as not-requiring-approval, so it would not
    // consume the ticket itself).
    const consume = this._approvalBridge.consumeApprovedTicket(ticketId, ctx.idempotencyKey);
    if (!consume.ok) {
      return { success: false, mode: 'apply', status: 'approval_consume_failed', error: consume.message, code: consume.code, ticketId, execEnabled };
    }

    // 1. Ship the bundle.
    const upload = await this._fileTransferService.upload({
      connectionId: ctx.connectionId,
      localPath: ctx.archivePath,
      remotePath: ctx.remoteTarPath,
      idempotencyKey: `${ctx.idempotencyKey}:scp`,
      traceId: traceId || null,
      onEvent,
    });
    if (!upload || !upload.ok) {
      return {
        success: false,
        mode: 'apply',
        status: upload && upload.status ? upload.status : 'upload_failed',
        hostAlias: ctx.hostAlias,
        ticketId,
        uploaded: upload || null,
        error: (upload && (upload.error || upload.message)) || 'Bundle upload failed.',
        execEnabled,
      };
    }

    // 2. Run the deploy commands remotely.
    const execResult = await this._execService.requestExecution({
      connectionId: ctx.connectionId,
      commands: ctx.commands,
      idempotencyKey: ctx.idempotencyKey,
      approvalTicketId: ticketId,
      traceId: traceId || null,
      riskContext: { kind: 'deploy', host_alias: ctx.hostAlias },
      onEvent,
    });

    this._pendingDeploys.delete(ticketId);

    const ok = execResult && execResult.status === 'completed';
    return {
      success: !!ok,
      mode: 'apply',
      status: execResult ? execResult.status : 'execution_error',
      hostAlias: ctx.hostAlias,
      deployDir: ctx.deployDir,
      bundleName: ctx.bundleName,
      ticketId,
      uploaded: upload,
      execResult,
      execEnabled,
    };
  }
}

module.exports = {
  DeployOrchestrator,
  createDeployOrchestrator: (deps) => new DeployOrchestrator(deps),
};
