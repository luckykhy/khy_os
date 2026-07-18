/**
 * Management resource: custom OpenAI-compatible providers.
 *
 * Source of truth: the provider-metadata file under getDataHome()
 * (services/customProviderRegistry.js). Registration/removal go through
 * customProviderRegistrar, the single source that also wires key pool + env
 * routing. CLI (`khy manage custom-providers ...`) and the Web management page
 * both invoke these ops through managementRegistry, so the two surfaces stay
 * identical.
 *
 * API keys are never returned: list reports only metadata + a keyCount.
 */
const path = require('path');
const { getDataHome } = require('../../../utils/dataHome');
const customRegistry = require('../../customProviderRegistry');
const registrar = require('../../customProviderRegistrar');
const pool = require('../../apiKeyPool');

const REGISTRY_FILE = path.join(getDataHome(), 'custom_providers.json');

function _keyCount(poolKey) {
  try {
    return (pool.getPoolStatus(poolKey) || []).length;
  } catch {
    return 0;
  }
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'custom-providers',
  label: '自定义 AI 提供商',
  source: 'file',
  sourceDetail: REGISTRY_FILE,
  capabilities: ['list', 'add', 'remove'],
  schema: {
    add: {
      displayName: { type: 'string', required: true },
      poolKey: { type: 'string', required: true },
      endpoint: { type: 'string', required: true },
      keyInput: { type: 'string', required: true },
      defaultModel: { type: 'string', required: true },
      extraModels: { type: 'string', required: false },
      tier: { type: 'string', required: false },
    },
    remove: {
      poolKey: { type: 'string', required: true },
      removeKeys: { type: 'boolean', required: false },
    },
  },
  ops: {
    async list() {
      const providers = customRegistry.listProviders().map((p) => ({
        name: p.name,
        poolKey: p.poolKey,
        endpoint: p.endpoint,
        defaultModel: p.defaultModel,
        models: Array.isArray(p.models) ? p.models.slice() : [],
        ...(p.tier ? { tier: p.tier } : {}),
        keyCount: _keyCount(p.poolKey),
      }));
      return { providers, presets: registrar.getPresets() };
    },
    async add(args) {
      const result = registrar.registerCustomProvider({
        displayName: args.displayName,
        poolKey: args.poolKey,
        endpoint: args.endpoint,
        keyInput: args.keyInput,
        defaultModel: args.defaultModel,
        extraModels: args.extraModels,
        tier: args.tier,
        ensureInit: true,
      });
      // Never echo the raw key back to either surface.
      const { firstKey, ...safe } = result;
      return safe;
    },
    async remove(args) {
      if (!args || !args.poolKey) throw new Error('poolKey is required');
      return registrar.unregisterCustomProvider(args.poolKey, {
        removeKeys: args.removeKeys === true,
      });
    },
  },
};

module.exports = contract;
