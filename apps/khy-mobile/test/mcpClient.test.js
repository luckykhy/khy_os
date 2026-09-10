// MCP 客户端测试
// 验证：MCP 协议实现、传输层、工具发现
import { describe, expect, it, beforeEach, vi } from 'vitest';

// 模拟 fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('MCP 客户端', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('HTTPMCPClient 应正确初始化', async () => {
    const { HTTPMCPClient } = await import('../src/api/mcpClient.js');
    const client = new HTTPMCPClient('test-server', {
      type: 'http',
      url: 'https://mcp.example.com/api',
    });

    expect(client.name).toBe('test-server');
    expect(client.connected).toBe(false);
    expect(client.tools.size).toBe(0);
  });

  it('SSEMCPClient 应正确初始化', async () => {
    const { SSEMCPClient } = await import('../src/api/mcpClient.js');
    const client = new SSEMCPClient('sse-server', {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
    });

    expect(client.name).toBe('sse-server');
    expect(client.url).toBe('https://mcp.example.com/sse');
  });

  it('StdioMCPClient 应正确初始化', async () => {
    const { StdioMCPClient } = await import('../src/api/mcpClient.js');
    const client = new StdioMCPClient('local-server', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    });

    expect(client.name).toBe('local-server');
    expect(client.command).toBe('npx');
    expect(client.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
  });

  it('MCPManager 应能添加和管理多个服务器', async () => {
    const { MCPManager } = await import('../src/api/mcpClient.js');
    const manager = new MCPManager();

    manager.addServer('server1', { type: 'http', url: 'https://mcp1.example.com' });
    manager.addServer('server2', { type: 'sse', url: 'https://mcp2.example.com/sse' });

    expect(manager.servers.size).toBe(2);
    expect(manager.servers.has('server1')).toBe(true);
    expect(manager.servers.has('server2')).toBe(true);
  });

  it('getToolSchemas 应返回所有服务器的工具', async () => {
    const { HTTPMCPClient } = await import('../src/api/mcpClient.js');
    const client = new HTTPMCPClient('test', { type: 'http', url: 'https://mcp.example.com' });

    // 模拟工具
    client.tools.set('test_tool', {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    });

    const schemas = client.getToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].function.name).toBe('mcp__test__test_tool');
    expect(schemas[0].function.description).toBe('A test tool');
  });

  it('hasTool 应正确识别工具归属', async () => {
    const { HTTPMCPClient } = await import('../src/api/mcpClient.js');
    const client = new HTTPMCPClient('myServer', { type: 'http', url: 'https://mcp.example.com' });

    expect(client.hasTool('mcp__myServer__someTool')).toBe(true);
    expect(client.hasTool('mcp__otherServer__someTool')).toBe(false);
    expect(client.hasTool('khy.local.fileRead')).toBe(false);
  });

  it('getToolName 应提取原始工具名', async () => {
    const { HTTPMCPClient } = await import('../src/api/mcpClient.js');
    const client = new HTTPMCPClient('server', { type: 'http', url: 'https://mcp.example.com' });

    expect(client.getToolName('mcp__server__myTool')).toBe('myTool');
    expect(client.getToolName('mcp__server__tool_with_underscore')).toBe('tool_with_underscore');
  });
});
