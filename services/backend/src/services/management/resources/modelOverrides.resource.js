/**
 * Management resource: per-adapter model overrides.
 *
 * Source of truth: the model-overrides file under getDataHome()
 * (services/gateway/modelCuration.js). Lets the user hide/add/rename models and
 * set a per-adapter default. CLI (`khy manage model-overrides ...`) and the Web
 * management page both invoke these ops through managementRegistry.
 */
const path = require('path');
const { getDataHome } = require('../../../utils/dataHome');
const curation = require('../../gateway/modelCuration');

const OVERRIDES_FILE = process.env.KHY_MODEL_OVERRIDES_FILE
  ? path.resolve(process.env.KHY_MODEL_OVERRIDES_FILE)
  : path.join(getDataHome(), 'model_overrides.json');

function _parseList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return undefined;
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'model-overrides',
  label: '按适配器模型增删改',
  source: 'file',
  sourceDetail: OVERRIDES_FILE,
  capabilities: ['list', 'set', 'clear'],
  schema: {
    set: {
      adapterKey: { type: 'string', required: true },
      hidden: { type: 'string', required: false },
      added: { type: 'string', required: false },
      defaultModel: { type: 'string', required: false },
    },
    clear: {
      adapterKey: { type: 'string', required: true },
    },
  },
  ops: {
    async list() {
      return { overrides: curation.getOverrides() };
    },
    async set(args) {
      if (!args || !args.adapterKey) throw new Error('adapterKey is required');
      const patch = {};
      if ('hidden' in args) {
        const v = _parseList(args.hidden);
        if (v !== undefined) patch.hidden = v;
      }
      if ('added' in args) {
        const v = _parseList(args.added);
        if (v !== undefined) patch.added = v;
      }
      if ('defaultModel' in args && String(args.defaultModel || '').trim()) {
        patch.defaultModel = String(args.defaultModel).trim();
      }
      const normalized = curation.setAdapterOverride(args.adapterKey, patch);
      return { adapterKey: args.adapterKey, override: normalized };
    },
    async clear(args) {
      if (!args || !args.adapterKey) throw new Error('adapterKey is required');
      const cleared = curation.clearAdapterOverride(args.adapterKey);
      return { adapterKey: args.adapterKey, cleared };
    },
  },
};

module.exports = contract;
