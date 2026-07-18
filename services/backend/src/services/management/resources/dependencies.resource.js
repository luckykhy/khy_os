/**
 * Management resource: runtime/toolchain and application dependencies.
 *
 * Source of truth: live inspection of the host (installed binaries) plus the
 * dependency registry (services/dependency/*). This resource is the single
 * funnel behind both `khy manage dependencies ...` and the Web dependency page.
 *
 * Tiering is re-validated here on every install — the caller's `installable`
 * flag is never trusted. High-risk / elevation-needing items are returned as
 * manual-only (command + docs), never silently installed.
 */
const inventory = require('../../dependencyInventory');
const resolver = require('../../dependency/resolver');
const { runInstall } = require('../../dependency/installRunner');

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'dependencies',
  label: 'Dependencies',
  source: 'process',
  sourceDetail: 'host:dependency-inventory',
  capabilities: ['list', 'install'],
  schema: {
    install: { id: { type: 'string', required: true } },
  },
  ops: {
    async list() {
      return inventory.listInventory();
    },
    async install(args) {
      if (!args || !args.id) throw new Error('id is required');
      const depId = args.id;
      const env = resolver.defaultEnv();
      const plan = resolver.buildInstallPlan(depId, env);
      if (!plan) throw new Error(`unknown or non-installable dependency: ${depId}`);

      // Server-side tier re-validation — never trust the caller's flag.
      if (!inventory._isPlanAutoInstallable(plan)) {
        return {
          success: false,
          manualOnly: true,
          displayCommand: plan.displayCommand,
          docsUrl: plan.docsUrl,
          reason: plan.requiresElevation || plan.scope !== 'project'
            ? 'System-level / elevation-required dependency: command provided, run it manually.'
            : 'High-risk dependency: command provided, run it manually.',
        };
      }

      if (plan.needsNetwork) {
        try {
          const net = require('../../networkDetector');
          if (typeof net.isOnline === 'function' && net.isOnline() === false) {
            return { success: false, offline: true, error: 'Offline: cannot download this dependency. Reconnect and retry.' };
          }
        } catch { /* networkDetector unavailable → do not block install */ }
      }

      const result = await runInstall(plan, { cwd: env.cwd });
      return {
        success: !!result.ok,
        depId,
        command: result.command,
        steps: result.steps,
        error: result.error || null,
        hint: result.hint || null,
      };
    },
  },
};

module.exports = contract;
