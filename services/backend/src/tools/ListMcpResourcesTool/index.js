const { BaseTool } = require('../_baseTool');

class ListMcpResourcesTool extends BaseTool {
  static toolName = 'ListMcpResources';
  static category = 'mcp';
  static risk = 'safe';
  static aliases = ['list_mcp_resources'];
  static searchHint = 'mcp resources list available';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `List available resources from connected MCP servers.
Resources are data sources (files, databases, APIs) that MCP servers expose.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'Filter by server name (optional)' },
      },
    };
  }

  async execute(params) {
    try {
      const mcp = require('../../services/mcp');
      const resources = mcp.listResources(params.server_name);
      return { success: true, resources };
    } catch (err) {
      return { success: true, resources: [], note: 'No MCP servers connected or error: ' + err.message };
    }
  }
}

module.exports = ListMcpResourcesTool;
