/**
 * deploy — end-to-end deployment tool for the CLI agent.
 *
 * Capability: "部署服务" (deploy). Builds a Docker bundle from the current
 * project, ships it to a remote host defined in ~/.ssh/config, and runs
 * `docker compose up -d --build` there. It is a thin wrapper over the singleton
 * deployOrchestrator in src/services/remote/.
 *
 * Security model (default-safe):
 *   - Default DRY-RUN: calling deploy without `confirm:true` never mutates the
 *     remote. It builds the bundle, plans the remote commands, and emits a
 *     pending approval ticket. The agent must surface the ticket for approval.
 *   - FORCE APPROVAL: a real apply (`confirm:true`) requires an already-approved
 *     `approvalTicketId` from the prior dry-run.
 *   - HARD GATE: even an approved apply only touches the remote when
 *     KHY_REMOTE_SSH_ENABLE_EXEC=true; otherwise it returns `execution_disabled`.
 *
 * Zero hardcoding: target host/user/port/key come solely from ~/.ssh/config; no
 * credentials are accepted as tool input. State transparency: `meta` always
 * reports mode/hostAlias/execEnabled and the providers that ran.
 */

const { defineTool } = require('./_baseTool');

/** Compact, LLM-facing summary so the result normalizer does not JSON-dump the payload. */
function _renderContent(result) {
  if (!result || typeof result !== 'object') {
    return 'Deploy produced no result.';
  }
  if (!result.success) {
    const base = `Deploy failed (${result.status || 'error'}): ${result.error || 'unknown error'}`;
    return result.hint ? `${base}\n${result.hint}` : base;
  }
  if (result.mode === 'dry-run') {
    const cmds = Array.isArray(result.plannedCommands) ? result.plannedCommands : [];
    const lines = [
      `Deploy DRY-RUN for "${result.hostAlias}" — bundle ${result.bundleName} ready at ${result.archivePath}.`,
      `Remote deploy dir: ${result.deployDir}`,
      'Planned remote commands:',
      ...cmds.map((c, i) => `  ${i + 1}. ${c}`),
      `Approval ticket: ${result.ticketId}`,
      result.hint || '',
    ];
    return lines.filter(Boolean).join('\n');
  }
  // apply
  const exec = result.execResult || {};
  const summary = exec.summary
    ? `${exec.summary.succeeded_steps || 0}/${exec.summary.total_steps || 0} steps succeeded`
    : (result.status || 'done');
  return `Deploy APPLY for "${result.hostAlias}" — status: ${result.status}. ${summary}.`;
}

module.exports = defineTool({
  name: 'deploy',
  description:
    'Deploy the current project to a remote host. Builds a Docker bundle, ships it over SSH '
    + '(host comes from ~/.ssh/config), and runs `docker compose up -d --build` remotely. '
    + 'Safe by default: without confirm:true it only does a DRY-RUN (builds + plans + emits an '
    + 'approval ticket, no remote changes). A real apply needs confirm:true plus an approved '
    + 'approvalTicketId and KHY_REMOTE_SSH_ENABLE_EXEC=true.',
  category: 'execution',
  risk: 'high',
  isReadOnly: false,
  isConcurrencySafe: false,
  searchHint: 'deploy',
  aliases: ['deploy_service', 'remote_deploy', '部署', '部署服务', '发布部署'],
  inputSchema: {
    target: {
      type: 'string',
      required: true,
      maxLength: 200,
      description: 'SSH config host alias of the deploy target (from ~/.ssh/config).',
    },
    projectRoot: {
      type: 'string',
      maxLength: 4096,
      description: 'Project directory to bundle. Defaults to the current working directory.',
    },
    remoteWorkspace: {
      type: 'string',
      maxLength: 4096,
      description: 'Remote deploy directory. Defaults to the host config workspace; validated against the allowlist.',
    },
    confirm: {
      type: 'boolean',
      default: false,
      description: 'false (default) = dry-run plan + approval ticket; true = real apply (needs approvalTicketId).',
    },
    approvalTicketId: {
      type: 'string',
      maxLength: 200,
      description: 'Approved ticket id from a prior dry-run. Required when confirm:true.',
    },
  },

  getActivityDescription(input) {
    const t = input && input.target ? String(input.target) : '';
    const apply = input && input.confirm === true;
    return `${apply ? '部署(应用)' : '部署(预演)'}到: "${t}"`;
  },

  async execute(params, _context) {
    const target = String((params && params.target) || '').trim();
    const confirm = !!(params && params.confirm === true);

    let deployOrchestrator;
    try {
      ({ deployOrchestrator } = require('../services/remote'));
    } catch (err) {
      const error = `Remote deploy subsystem is unavailable: ${err && err.message ? err.message : String(err)}`;
      return { success: false, status: 'subsystem_unavailable', error, content: error, meta: { mode: confirm ? 'apply' : 'dry-run' } };
    }

    let result;
    try {
      result = await deployOrchestrator.deploy({
        hostAlias: target,
        projectRoot: params && params.projectRoot ? String(params.projectRoot) : undefined,
        remoteWorkspace: params && params.remoteWorkspace ? String(params.remoteWorkspace) : undefined,
        confirm,
        approvalTicketId: params && params.approvalTicketId ? String(params.approvalTicketId) : undefined,
      });
    } catch (err) {
      const error = `Deploy error: ${err && err.message ? err.message : String(err)}`;
      return { success: false, status: 'deploy_error', error, content: error, meta: { mode: confirm ? 'apply' : 'dry-run', hostAlias: target } };
    }

    const meta = {
      mode: result.mode,
      hostAlias: result.hostAlias || target,
      execEnabled: !!result.execEnabled,
      providers: ['docker-bundle', 'ssh'],
    };

    return {
      ...result,
      content: _renderContent(result),
      meta,
    };
  },
});
