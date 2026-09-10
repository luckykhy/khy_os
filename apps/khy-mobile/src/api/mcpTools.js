// khy.mcpTools —— MCP 工具封装
// 将 MCP 服务器工具包装为 khy.local.* 格式的工具

import { getMCPManager } from './mcpClient.js';

/**
 * 获取所有 MCP 工具定义（OpenAI 格式）
 */
export function mcpToolSchemas() {
  const manager = getMCPManager();
  return manager.getAllToolSchemas();
}

/**
 * 执行 MCP 工具
 */
export async function executeMCPTool(fullName, args) {
  const manager = getMCPManager();
  const result = await manager.callTool(fullName, args);
  return { ok: !result.isError, content: result.content };
}

/**
 * 检查工具是否为 MCP 工具
 */
export function isMCPTool(fullName) {
  return fullName.startsWith('mcp__');
}

/**
 * 获取 MCP 服务器状态
 */
export function getMCPStatus() {
  const manager = getMCPManager();
  return manager.getStatus();
}

/**
 * 添加 MCP 服务器
 */
export function addMCPServer(name, config) {
  const manager = getMCPManager();
  return manager.addServer(name, config);
}

/**
 * 连接所有 MCP 服务器
 */
export async function connectAllMCPServers() {
  const manager = getMCPManager();
  return manager.connectAll();
}

/**
 * 断开所有 MCP 服务器
 */
export async function disconnectAllMCPServers() {
  const manager = getMCPManager();
  return manager.disconnectAll();
}

/**
 * 列出 MCP 服务器上的所有资源
 */
export async function listMCPResources(serverName) {
  const manager = getMCPManager();
  const client = manager.servers.get(serverName);
  if (!client) throw new Error(`未找到 MCP 服务器: ${serverName}`);
  return client.listResources();
}

/**
 * 读取 MCP 资源
 */
export async function readMCPResource(serverName, uri) {
  const manager = getMCPManager();
  const client = manager.servers.get(serverName);
  if (!client) throw new Error(`未找到 MCP 服务器: ${serverName}`);
  return client.readResource(uri);
}
