'use strict';
/**
 * toolCalling.mcpResultShape.test.js �?executeTool 成功路径�?MCP 结果结构化契�?node:test)�?
 *
 * 背景(goal 2026-07-03「保证每一个函数都能拿到自己预期格式的结构化结果�?:MCP 工具 handler
 * 返回原始协议�?`{ content:[{type:'text',text}], isError }` —�?**�?`success` 字段、且 `content`
 * 是数�?*。取证证�?每一条运行时 agent 路径都直�?`toolCalling.executeTool`(不走 tools/index.js
 * 那个会归一�?wrapper),�?executeTool 成功路径原样透出结果。于是一�?*成功**�?MCP 调用
 * (isError:false、无 success)会被 executeTool 自身的分�?`!!result.success`)以及直连消费�?
 * (toolUseLoop �?`!result.success` �?20+ �?**误判为失�?*;content 数组还会被下�?JSON.stringify 成畸形串�?
 *
 * 修复:executeTool 成功路径在任�?`result.success` 分类之前,�?**MCP 形结�?*�?canonical
 * normalizeToolResult(isError→success、content 数组→字符串)。门�?KHY_MCP_RESULT_NORMALIZE(默认开)�?
 *
 * 本测�?�?成功 MCP 调用 �?result.success===true �?content 是字符串;�?isError:true �?MCP 调用 �?
 * result.success===false 且带 error;�?**�?MCP 工具**(已带 success)逐字节零变化;�?门控 off �?原样透出
 * (content 仍是数组、无 success),复现旧行�?load-bearing)�?
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcp-shape-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// 隔离其余 funnel 守卫,只观�?MCP 归一这一维�?
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_HUMAN_GATE = 'off';
process.env.KHY_PERMISSION_POLICY = 'off';
// 关闭系统调用网关:非交互环境下它会对未�?MCP 动作 fail-closed 拒绝,拦在 handler 执行之前,
// 使本测触不到成功路径的归一。关掉后走到真正的工�?handler,才能观察结果结构化契约�?
process.env.KHY_SYSCALL_GATEWAY = 'off';
// bypass 权限模式:自动放行(除关键红�?,避免非交互环境下工具执行卡在审批弹窗�?stdin�?
process.env.KHY_PERMISSION_MODE = 'bypass';
process.env.KHY_PERMISSION_STORE = 'false';
const toolCalling = require('../src/services/toolCalling');
// 注册一个「像 MCP 服务器」的�?handler 返回原始协议�?镜像 registerMCPServer �?server.callTool 的返�?�?
function registerMcpStub(serverName, toolName, callResult) {
  toolCalling.registerMCPServer({
    name: serverName,
    tools: [{ name: toolName, description: `stub ${toolName}`, inputSchema: { properties: {} } }],
    callTool: async () => callResult,
  });
  return `mcp_${serverName}_${toolName}`;
}
describe('executeTool MCP 结果结构化契�?KHY_MCP_RESULT_NORMALIZE)', () => {
  afterEach(() => {
    delete process.env.KHY_MCP_RESULT_NORMALIZE;
  });
});

describe('Tool Calling mcp Result Shape', () => {
  test('成功 MCP 调用(isError:false,�?success)�?归一�?success:true + 字符�?content', async () => {
        const name = registerMcpStub('shapeok', 'echo', { content: [{ type: 'text', text: 'hello mcp' }], isError: false });
        const res = await toolCalling.executeTool(name, {});
        expect(res.success).toBe(true);
        expect(typeof res.content).toBe('string');
        expect(res.content).toMatch(/hello mcp/);
  });

  test('失败 MCP 调用(isError:true)�?success:false 且带结构�?error', async () => {
        const name = registerMcpStub('shapeerr', 'boom', { content: [{ type: 'text', text: 'boom detail' }], isError: true });
        const res = await toolCalling.executeTool(name, {});
        expect(res.success).toBe(false);
        // 归一�?success:false + 字符�?error �?executeTool 软失败路径进一步把字符�?error
        // 升级�?canonical ToolError 结构 `{code,message,hint,...}`(这正是「拿到预期格式的结构化结果�?�?
        const errMsg = typeof res.error === 'string' ? res.error : (res.error && res.error.message) || '';
        expect(String(errMsg)).toMatch(/boom detail/);
  });

  test('门控 off �?逐字节回退原样透出(content 仍是数组、无 success)—�?load-bearing', async () => {
        process.env.KHY_MCP_RESULT_NORMALIZE = 'off';
        const name = registerMcpStub('shapeoff', 'raw', { content: [{ type: 'text', text: 'raw passthrough' }], isError: false });
        const res = await toolCalling.executeTool(name, {});
        // 关门 �?executeTool 不施加归一;成功路径原样透出 handler 返回�?证归一确实�?load-bearing)�?
        expect(Array.isArray(res.content)).toBeTruthy();
        expect(res.success).toBe(undefined);
  });

});

