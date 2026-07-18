const { BaseTool } = require('../_baseTool');

class MCPTool extends BaseTool {
  static toolName = 'MCPTool';
  static category = 'mcp';
  static risk = 'medium';
  static aliases = ['mcp_tool', 'mcp_execute'];
  static searchHint = 'mcp model context protocol server tool';

  isConcurrencySafe() { return false; }

  prompt() {
    return `Execute a tool provided by an MCP (Model Context Protocol) server.
MCP servers extend capabilities by providing additional tools through a standardized protocol.
This tool dispatches the call to the appropriate MCP server.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'Name of the MCP server' },
        tool_name: { type: 'string', description: 'Name of the tool on the server' },
        arguments: { type: 'object', description: 'Arguments to pass to the tool' },
      },
      required: ['server_name', 'tool_name'],
    };
  }

  async execute(params) {
    try {
      const mcp = require('../../services/mcp');
      const result = await mcp.callTool(params.server_name, params.tool_name, params.arguments || {});
      return { success: true, result };
    } catch (err) {
      return { error: err.message };
    }
  }

  getActivityDescription(input) { return `调用 MCP 工具：${input.server_name}/${input.tool_name}`; }
}

module.exports = MCPTool;
