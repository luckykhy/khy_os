/**
 * Management resource: scheduled cron jobs.
 *
 * Source of truth: the cron-jobs file under getDataHome()/growth
 * (services/cronScheduler.js). CLI (`khy manage cron ...`) and the Web
 * management page both invoke these ops through managementRegistry.
 *
 * cronScheduler sits inside a large require cycle, so it is loaded lazily inside
 * each op (the CLI handler and aiManagementServer lazy-require their deps for
 * the same reason). sourceDetail is resolved here from the same env precedence
 * cronScheduler uses, so the contract can be built without importing it.
 */
const path = require('path');
const { getDataHome } = require('../../../utils/dataHome');

const cron = () => require('../../cronScheduler');

function _jobsFile() {
  if (process.env.KHY_CRON_JOBS_FILE) return process.env.KHY_CRON_JOBS_FILE;
  const growthDir = process.env.KHY_CRON_GROWTH_DIR || path.join(getDataHome(), 'growth');
  return path.join(growthDir, 'cron_jobs.json');
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'cron',
  label: '定时任务',
  source: 'file',
  sourceDetail: _jobsFile(),
  capabilities: ['list', 'add', 'remove', 'enable', 'disable'],
  schema: {
    add: {
      cron: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      channel: { type: 'string', required: false },
      noAgent: { type: 'boolean', required: false },
      contextFrom: { type: 'string', required: false },
      maxRuntimeMs: { type: 'number', required: false },
    },
    remove: { id: { type: 'string', required: true } },
    enable: { id: { type: 'string', required: true } },
    disable: { id: { type: 'string', required: true } },
  },
  ops: {
    async list() {
      return { jobs: cron().listJobs() };
    },
    async add(args) {
      if (!args || !args.cron || !args.prompt) {
        throw new Error('cron and prompt are required');
      }
      return cron().addJob({
        cron: args.cron,
        prompt: args.prompt,
        channel: args.channel,
        noAgent: args.noAgent === true,
        contextFrom: args.contextFrom,
        maxRuntimeMs: args.maxRuntimeMs,
      });
    },
    async remove(args) {
      if (!args || !args.id) throw new Error('id is required');
      return { removed: cron().removeJob(args.id), id: args.id };
    },
    async enable(args) {
      if (!args || !args.id) throw new Error('id is required');
      return { enabled: cron().enableJob(args.id), id: args.id };
    },
    async disable(args) {
      if (!args || !args.id) throw new Error('id is required');
      return { disabled: cron().disableJob(args.id), id: args.id };
    },
  },
};

module.exports = contract;
