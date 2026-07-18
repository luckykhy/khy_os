'use strict';

/**
 * toolCalling.mcpResultShape.test.js — executeTool 成功路径的 MCP 结果结构化契约(node:test)。
 *
 * 背景(goal 2026-07-03「保证每一个函数都能拿到自己预期格式的结构化结果」):MCP 工具 handler
 * 返回原始协议形 `{ content:[{type:'text',text}], isError }` —— **无 `success` 字段、且 `content`
 * 是数组**。取证证实:每一条运行时 agent 路径都直连 `toolCalling.executeTool`(不走 tools/index.js
 * 那个会归一的 wrapper),而 executeTool 成功路径原样透出结果。于是一次**成功**的 MCP 调用
 * (isError:false、无 success)会被 executeTool 自身的分类(`!!result.success`)以及直连消费者
 * (toolUseLoop 的 `!result.success` 等 20+ 处)**误判为失败**;content 数组还会被下游 JSON.stringify 成畸形串。
 *
 * 修复:executeTool 成功路径在任何 `result.success` 分类之前,对 **MCP 形结果**走 canonical
 * normalizeToolResult(isError→success、content 数组→字符串)。门控 KHY_MCP_RESULT_NORMALIZE(默认开)。
 *
 * 本测证:① 成功 MCP 调用 → result.success===true 且 content 是字符串;② isError:true 的 MCP 调用 →
 * result.success===false 且带 error;③ **非 MCP 工具**(已带 success)逐字节零变化;④ 门控 off → 原样透出
 * (content 仍是数组、无 success),复现旧行为(load-bearing)。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcp-shape-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// 隔离其余 funnel 守卫,只观察 MCP 归一这一维。
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_HUMAN_GATE = 'off';
process.env.KHY_PERMISSION_POLICY = 'off';
// 关闭系统调用网关:非交互环境下它会对未知 MCP 动作 fail-closed 拒绝,拦在 handler 执行之前,
// 使本测触不到成功路径的归一。关掉后走到真正的工具 handler,才能观察结果结构化契约。
process.env.KHY_SYSCALL_GATEWAY = 'off';
// bypass 权限模式:自动放行(除关键红线),避免非交互环境下工具执行卡在审批弹窗读 stdin。
process.env.KHY_PERMISSION_MODE = 'bypass';
process.env.KHY_PERMISSION_STORE = 'false';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolCalling = require('../src/services/toolCalling');

// 注册一个「像 MCP 服务器」的桩:handler 返回原始协议形(镜像 registerMCPServer 里 server.callTool 的返回)。
function registerMcpStub(serverName, toolName, callResult) {
  toolCalling.registerMCPServer({
    name: serverName,
    tools: [{ name: toolName, description: `stub ${toolName}`, inputSchema: { properties: {} } }],
    callTool: async () => callResult,
  });
  return `mcp_${serverName}_${toolName}`;
}

describe('executeTool MCP 结果结构化契约(KHY_MCP_RESULT_NORMALIZE)', () => {
  afterEach(() => {
    delete process.env.KHY_MCP_RESULT_NORMALIZE;
  });

  test('成功 MCP 调用(isError:false,无 success)→ 归一成 success:true + 字符串 content', async () => {
    const name = registerMcpStub('shapeok', 'echo', { content: [{ type: 'text', text: 'hello mcp' }], isError: false });
    const res = await toolCalling.executeTool(name, {});
    assert.equal(res.success, true, '成功 MCP 调用必须解析为 success:true(修复前=undefined 被读成失败)');
    assert.equal(typeof res.content, 'string', 'content 必须归一为字符串(修复前=数组会被下游 stringify 成畸形串)');
    assert.match(res.content, /hello mcp/);
  });

  test('失败 MCP 调用(isError:true)→ success:false 且带结构化 error', async () => {
    const name = registerMcpStub('shapeerr', 'boom', { content: [{ type: 'text', text: 'boom detail' }], isError: true });
    const res = await toolCalling.executeTool(name, {});
    assert.equal(res.success, false);
    // 归一置 success:false + 字符串 error 后,executeTool 软失败路径进一步把字符串 error
    // 升级为 canonical ToolError 结构 `{code,message,hint,...}`(这正是「拿到预期格式的结构化结果」)。
    const errMsg = typeof res.error === 'string' ? res.error : (res.error && res.error.message) || '';
    assert.match(String(errMsg), /boom detail/);
  });

  test('门控 off → 逐字节回退原样透出(content 仍是数组、无 success)—— load-bearing', async () => {
    process.env.KHY_MCP_RESULT_NORMALIZE = 'off';
    const name = registerMcpStub('shapeoff', 'raw', { content: [{ type: 'text', text: 'raw passthrough' }], isError: false });
    const res = await toolCalling.executeTool(name, {});
    // 关门 → executeTool 不施加归一;成功路径原样透出 handler 返回值(证归一确实是 load-bearing)。
    assert.ok(Array.isArray(res.content), '门控关时 content 应保持数组(原样透出,复现旧行为)');
    assert.equal(res.success, undefined, '门控关时不应注入 success(原始 MCP 形无 success)');
  });
});
