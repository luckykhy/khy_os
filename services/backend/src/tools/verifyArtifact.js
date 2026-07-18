/**
 * Tool: verify_artifact — check cross-platform delivery readiness.
 * Bridges the deliveryValidator service for AI tool-use.
 */
'use strict';

const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'verify_artifact',
  description: 'Check whether a project can be delivered on macOS, Linux, and Windows. Returns score (0-100), issues, and per-platform readiness. Supports Node.js, Python, WASM, Docker projects.',
  category: 'execution',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,

  inputSchema: {
    cwd: { type: 'string', required: false, description: 'Project directory (defaults to process.cwd)' },
    type: { type: 'string', required: false, description: 'Force project type: nodejs, python, wasm, docker (auto-detect if omitted)' },
    platform: { type: 'string', required: false, description: 'Check specific platform only: darwin, linux, win32' },
    verbose: { type: 'boolean', required: false, description: 'Include info-level issues (default false)' },
  },

  getActivityDescription(input) {
    return `检查交付就绪度${input?.cwd ? `：${input.cwd}` : ''}`;
  },

  async execute(params) {
    const validator = require('../services/deliveryValidator');
    const projectPath = params.cwd || process.cwd();

    const report = await validator.validate(projectPath, {
      types: params.type ? [params.type] : null,
      platforms: params.platform ? [params.platform] : null,
      verbose: params.verbose || false,
    });

    return {
      success: report.verdict !== 'fail',
      data: report,
    };
  },
});
