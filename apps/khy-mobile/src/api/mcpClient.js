// khy.mcpClient —— Model Context Protocol (MCP) 客户端实现
//
// 参考：OpenClaude MCP 集成 (https://github.com/Gitlawb/openclaude)
// 支持传输：Stdio（本地进程）、SSE（Server-Sent Events）、HTTP（JSON-RPC）
//
// MCP 协议核心：
// 1. 连接初始化（initialize）→ 交换能力声明
// 2. 工具发现（tools/list）→ 获取可用工具列表
// 3. 工具调用（tools/call）→ 执行工具并获取结果
// 4. 资源访问（resources/list, resources/read）→ 访问外部数据

const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * MCP 客户端基类
 * 定义通用接口，具体传输方式由子类实现
 */
class MCPClientBase {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.connected = false;
    this.serverInfo = null;
    this.tools = new Map();
    this.resources = [];
    this.requestId = 0;
    this.pendingRequests = new Map();
  }

  // 子类必须实现的传输层方法
  async connect() { throw new Error('Not implemented'); }
  async disconnect() { throw new Error('Not implemented'); }
  async sendRequest(method, params = {}) { throw new Error('Not implemented'); }

  /**
   * 初始化 MCP 连接
   */
  async initialize() {
    const response = await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'khy-mobile', version: '1.0.0' },
    });

    this.serverInfo = response;
    this.connected = true;

    // 发送 initialized 通知
    await this.sendNotification('notifications/initialized', {});

    return response;
  }

  /**
   * 发现可用工具
   */
  async listTools() {
    const response = await this.sendRequest('tools/list', {});
    const tools = response?.tools || [];
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, {
        ...tool,
        mcpServerName: this.name,
      });
    }
    return Array.from(this.tools.values());
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(name, args = {}) {
    const response = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    // 解析响应
    const content = response?.content || [];
    const isError = response?.isError || false;

    return {
      content: content.map((item) => {
        if (item.type === 'text') return item.text;
        if (item.type === 'image') return `[Image: ${item.mimeType}]`;
        return JSON.stringify(item);
      }).join('\n'),
      isError,
      raw: response,
    };
  }

  /**
   * 列出可用资源
   */
  async listResources() {
    const response = await this.sendRequest('resources/list', {});
    this.resources = response?.resources || [];
    return this.resources;
  }

  /**
   * 读取资源内容
   */
  async readResource(uri) {
    const response = await this.sendRequest('resources/read', { uri });
    const contents = response?.contents || [];
    return contents.map((c) => {
      if (c.text) return c.text;
      if (c.blob) return `[Binary: ${c.mimeType}]`;
      return JSON.stringify(c);
    }).join('\n');
  }

  /**
   * 发送通知（无响应）
   */
  async sendNotification(method, params = {}) {
    // 子类实现
  }

  /**
   * 获取工具定义（OpenAI 格式）
   */
  getToolSchemas() {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function',
      function: {
        name: `mcp__${this.name}__${tool.name}`,
        description: tool.description || `MCP tool from ${this.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * 检查工具是否属于此服务器
   */
  hasTool(fullName) {
    const prefix = `mcp__${this.name}__`;
    return fullName.startsWith(prefix);
  }

  /**
   * 提取原始工具名
   */
  getToolName(fullName) {
    const prefix = `mcp__${this.name}__`;
    return fullName.slice(prefix.length);
  }
}

/**
 * Stdio 传输 - 通过本地进程通信
 * 适用于：本地 MCP 服务器（如文件系统、数据库）
 */
class StdioMCPClient extends MCPClientBase {
  constructor(name, config) {
    super(name, config);
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.process = null;
  }

  async connect() {
    // 在移动端，Stdio 需要通过原生插件或嵌入式 Linux 执行
    // 这里提供接口，实际执行需要通过 linuxExec 或原生桥接
    const { execLinuxCommand } = await import('./linux.js').catch(() => ({ execLinuxCommand: null }));

    if (!execLinuxCommand) {
      throw new Error('Stdio MCP 需要嵌入式 Linux 环境');
    }

    // 检查命令是否可用
    const check = await execLinuxCommand(`which ${this.command} 2>/dev/null || echo "NOT_FOUND"`);
    if (check.output.includes('NOT_FOUND')) {
      throw new Error(`命令未找到: ${this.command}`);
    }

    this.connected = true;
    return this.initialize();
  }

  async disconnect() {
    this.connected = false;
  }

  async sendRequest(method, params = {}) {
    // Stdio 模式：通过 linuxExec 发送 JSON-RPC 请求
    const request = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };

    // 构建命令：通过 stdin 发送 JSON-RPC 请求
    const requestJson = JSON.stringify(request).replace(/'/g, "'\\''");
    const cmd = `echo '${requestJson}' | ${this.command} ${this.args.join(' ')}`;

    const { execLinuxCommand } = await import('./linux.js');
    const result = await execLinuxCommand(cmd);

    // 解析 JSON-RPC 响应
    try {
      const response = JSON.parse(result.output);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.result;
    } catch (e) {
      throw new Error(`MCP 响应解析失败: ${e.message}`);
    }
  }
}

/**
 * SSE 传输 - Server-Sent Events
 * 适用于：远程 MCP 服务器（HTTP SSE 模式）
 */
class SSEMCPClient extends MCPClientBase {
  constructor(name, config) {
    super(name, config);
    this.url = config.url;
    this.headers = config.headers || {};
    this.eventSource = null;
  }

  async connect() {
    // SSE 连接
    const response = await fetch(this.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...this.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`SSE 连接失败: ${response.status}`);
    }

    // 解析 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 读取 endpoint 事件
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: endpoint')) {
          const dataLine = lines[lines.indexOf(line) + 1];
          if (dataLine?.startsWith('data: ')) {
            this.endpointUrl = new URL(dataLine.slice(6), this.url).href;
            this.connected = true;
            reader.cancel();
            break;
          }
        }
      }
      if (this.connected) break;
    }

    return this.initialize();
  }

  async disconnect() {
    this.connected = false;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  async sendRequest(method, params = {}) {
    if (!this.endpointUrl) {
      throw new Error('SSE 未连接');
    }

    const response = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP 请求失败: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }
}

/**
 * HTTP 传输 - JSON-RPC over HTTP
 * 适用于：远程 MCP 服务器（标准 HTTP 模式）
 */
class HTTPMCPClient extends MCPClientBase {
  constructor(name, config) {
    super(name, config);
    this.url = config.url;
    this.headers = config.headers || {};
  }

  async connect() {
    // HTTP 模式：直接发送 initialize 请求
    this.connected = true;
    return this.initialize();
  }

  async disconnect() {
    this.connected = false;
  }

  async sendRequest(method, params = {}) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP 请求失败: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }
}

/**
 * MCP 服务器管理器
 * 管理多个 MCP 服务器的连接和工具注册
 */
class MCPManager {
  constructor() {
    this.servers = new Map();
  }

  /**
   * 添加 MCP 服务器配置
   */
  addServer(name, config) {
    let client;
    switch (config.type) {
      case 'stdio':
        client = new StdioMCPClient(name, config);
        break;
      case 'sse':
        client = new SSEMCPClient(name, config);
        break;
      case 'http':
        client = new HTTPMCPClient(name, config);
        break;
      default:
        throw new Error(`不支持的传输类型: ${config.type}`);
    }
    this.servers.set(name, client);
    return client;
  }

  /**
   * 连接所有服务器
   */
  async connectAll() {
    const results = {};
    for (const [name, client] of this.servers) {
      try {
        await client.connect();
        await client.listTools();
        results[name] = { success: true, tools: client.tools.size };
      } catch (error) {
        results[name] = { success: false, error: error.message };
      }
    }
    return results;
  }

  /**
   * 断开所有服务器
   */
  async disconnectAll() {
    for (const client of this.servers.values()) {
      try {
        await client.disconnect();
      } catch { /* 忽略断开错误 */ }
    }
  }

  /**
   * 获取所有工具定义（OpenAI 格式）
   */
  getAllToolSchemas() {
    const schemas = [];
    for (const client of this.servers.values()) {
      if (client.connected) {
        schemas.push(...client.getToolSchemas());
      }
    }
    return schemas;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(fullName, args) {
    for (const client of this.servers.values()) {
      if (client.hasTool(fullName)) {
        const toolName = client.getToolName(fullName);
        return client.callTool(toolName, args);
      }
    }
    throw new Error(`未找到 MCP 工具: ${fullName}`);
  }

  /**
   * 获取服务器状态
   */
  getStatus() {
    const status = {};
    for (const [name, client] of this.servers) {
      status[name] = {
        connected: client.connected,
        tools: client.tools.size,
        serverInfo: client.serverInfo,
      };
    }
    return status;
  }
}

// 单例模式
let mcpManagerInstance = null;

export function getMCPManager() {
  if (!mcpManagerInstance) {
    mcpManagerInstance = new MCPManager();
  }
  return mcpManagerInstance;
}

export { MCPClientBase, StdioMCPClient, SSEMCPClient, HTTPMCPClient, MCPManager };
