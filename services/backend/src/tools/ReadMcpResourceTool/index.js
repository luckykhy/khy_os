const { BaseTool } = require('../_baseTool');

class ReadMcpResourceTool extends BaseTool {
  static toolName = 'ReadMcpResource';
  static category = 'mcp';
  static risk = 'safe';
  static aliases = ['read_mcp_resource'];
  static searchHint = 'mcp resource read content';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Read content from a specific MCP server resource.
Use ListMcpResources first to discover available resources.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: 'Name of the MCP server' },
        uri: { type: 'string', description: 'Resource URI to read' },
      },
      required: ['server_name', 'uri'],
    };
  }

  async execute(params) {
    try {
      const mcp = require('../../services/mcp');
      const content = await mcp.readResource(params.server_name, params.uri);
      return { success: true, content };
    } catch (err) {
      return { error: err.message };
    }
  }

  getActivityDescription(input) { return `读取 MCP 资源：${input.uri}`; }
}

module.exports = ReadMcpResourceTool;
