const { BaseTool } = require('../_baseTool');

class McpAuthTool extends BaseTool {
  static toolName = 'McpAuth';
  static category = 'mcp';
  static risk = 'medium';
  static aliases = ['mcp_auth', 'mcp_login'];
  static searchHint = 'mcp authenticate login oauth';

  isConcurrencySafe() { return false; }

  prompt() {
    return `Authenticate with an MCP server that requires credentials.
Handles OAuth flows, API key setup, and token management for MCP servers.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'Name of the MCP server to authenticate with' },
        method: { type: 'string', description: 'Authentication method', enum: ['oauth', 'api_key', 'token'] },
        credentials: { type: 'object', description: 'Credentials object (varies by method)' },
      },
      required: ['server_name'],
    };
  }

  async execute(params) {
    try {
      const mcp = require('../../services/mcp');
      const result = await mcp.authenticate(params.server_name, {
        method: params.method || 'oauth',
        credentials: params.credentials,
      });
      return { success: true, authenticated: true, server: params.server_name, ...result };
    } catch (err) {
      return { error: err.message, server: params.server_name };
    }
  }
}

module.exports = McpAuthTool;
