/**
 * Management subsystem entry point.
 *
 * Registers every manageable resource exactly once into the single
 * managementRegistry funnel, then re-exports the registry so CLI and Web
 * adapters share one source of truth. Idempotent: safe to require repeatedly.
 */
const registry = require('./managementRegistry');

const RESOURCES = [
  require('./resources/users.resource'),
  require('./resources/apiKeys.resource'),
  require('./resources/dependencies.resource'),
  require('./resources/customProviders.resource'),
  require('./resources/modelOverrides.resource'),
  require('./resources/modelConfig.resource'),
  require('./resources/cron.resource'),
];

function ensureRegistered() {
  // Idempotent: only registers resources the registry doesn't already hold.
  // Re-runnable after a registry._reset() (used by tests), since the guard is
  // the per-contract presence check rather than a one-shot boolean.
  for (const contract of RESOURCES) {
    if (!registry.get(contract.id)) registry.register(contract);
  }
  return registry;
}

ensureRegistered();

module.exports = {
  ...registry,
  ensureRegistered,
};
