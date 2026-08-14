'use strict';

/**
 * analyzeBinary.js — read-only binary inspection tool (ELF / PE).
 *
 * Thin defineTool wrapper over services/binaryAnalyzer. Lets the agent inspect
 * a compiled artifact's format/architecture/platform/dependencies and assess
 * cross-platform compatibility, or compare two binaries. Read-only and
 * concurrency-safe: it only reads files and never writes or executes them.
 *
 * Auto-registered by the tools/ readdir loader (flat .js + defineTool format).
 */

const { defineTool } = require('./_baseTool');
const { analyzeBinary, compareBinaries } = require('../services/binaryAnalyzer');

module.exports = defineTool({
  name: 'analyzeBinary',
  description:
    'Inspect a compiled binary (ELF or PE): detect format, architecture, platform, ' +
    'linked dependencies, and cross-platform compatibility. ' +
    'Actions: analyze (one file), compare (two files). Read-only — never executes the binary.',
  category: 'analysis',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,

  inputSchema: {
    action: {
      type: 'string',
      required: false,
      description: "Action to perform: 'analyze' (default) or 'compare'",
      enum: ['analyze', 'compare'],
    },
    filePath: {
      type: 'string',
      required: true,
      description: 'Path to the binary to analyze (or the first file when comparing)',
      maxLength: 4096,
    },
    filePathB: {
      type: 'string',
      required: false,
      description: "Path to the second binary (required for action 'compare')",
      maxLength: 4096,
    },
  },

  getActivityDescription(input) {
    const action = (input && input.action) || 'analyze';
    if (action === 'compare') {
      return `对比二进制：${input.filePath || '?'} ↔ ${input.filePathB || '?'}`;
    }
    return `分析二进制：${(input && input.filePath) || '?'}`;
  },

  async execute(params) {
    const action = (params && params.action) || 'analyze';
    const filePath = params && params.filePath;
    if (!filePath) {
      return { success: false, error: 'filePath is required' };
    }

    if (action === 'compare') {
      if (!params.filePathB) {
        return { success: false, error: "action 'compare' requires filePathB" };
      }
      const result = await compareBinaries(filePath, params.filePathB);
      return { success: true, action: 'compare', result };
    }

    const result = await analyzeBinary(filePath);
    if (result && result.error) {
      return { success: false, error: result.error, ...result };
    }
    return { success: true, action: 'analyze', result };
  },
});
