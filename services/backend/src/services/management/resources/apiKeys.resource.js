/**
 * Management resource: API key pool.
 *
 * Source of truth: the on-disk key pool file under getDataHome()
 * (services/apiKeyPool.js). Both the CLI (`khy manage api-keys ...`) and the
 * Web management page invoke these ops through managementRegistry, so the two
 * surfaces can never diverge.
 */
const apiKeyPool = require('../../apiKeyPool');
const { getDataHome } = require('../../../utils/dataHome');
const path = require('path');

const POOL_FILE = path.join(getDataHome(), 'api_keys.json');

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'api-keys',
  label: 'API Key Pool',
  source: 'file',
  sourceDetail: POOL_FILE,
  capabilities: ['list', 'add', 'remove', 'enable', 'disable'],
  schema: {
    add: {
      provider: { type: 'string', required: true },
      key: { type: 'string', required: true },
      endpoint: { type: 'string', required: false },
      priority: { type: 'number', required: false },
      label: { type: 'string', required: false },
    },
    remove: {
      provider: { type: 'string', required: true },
      keyId: { type: 'string', required: true },
    },
    enable: {
      provider: { type: 'string', required: true },
      keyId: { type: 'string', required: true },
    },
    disable: {
      provider: { type: 'string', required: true },
      keyId: { type: 'string', required: true },
    },
  },
  ops: {
    async list() {
      return { providers: apiKeyPool.getAllStatus() };
    },
    async add(args) {
      if (!args || !args.provider) throw new Error('provider is required');
      if (!args.key) throw new Error('key is required');
      const keyId = apiKeyPool.addKey(args.provider, {
        key: args.key,
        endpoint: args.endpoint,
        priority: args.priority,
        label: args.label,
      });
      return { keyId };
    },
    async remove(args) {
      if (!args || !args.provider || !args.keyId) {
        throw new Error('provider and keyId are required');
      }
      apiKeyPool.removeKey(args.provider, args.keyId);
      return { removed: args.keyId };
    },
    async enable(args) {
      if (!args || !args.provider || !args.keyId) {
        throw new Error('provider and keyId are required');
      }
      apiKeyPool.enableKey(args.provider, args.keyId);
      return { enabled: args.keyId };
    },
    async disable(args) {
      if (!args || !args.provider || !args.keyId) {
        throw new Error('provider and keyId are required');
      }
      apiKeyPool.disableKey(args.provider, args.keyId);
      return { disabled: args.keyId };
    },
  },
};

module.exports = contract;
