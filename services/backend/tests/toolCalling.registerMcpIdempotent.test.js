'use strict';

/**
 * toolCalling.registerMcpIdempotent.test.js — registerMCPServer 幂等注册回归(node:test)。
 *
 * 背景:registerMCPServer 已实现幂等——重复注册同名 MCP server 时,先过滤掉旧的同名 server
 * 及其 `mcp_<server>_*` 工具,再重新 push,从而不产生重复的 function 名 / 不累加 server 条目。
 * 现有 tests/toolCalling.mcpResultShape.test.js 调用了它但未断言幂等,本测补齐该维度。
 *
 * 断言:
 *  ① 同名 server(含 2 个 tool)连续注册两次 → 属于该 server 的 `mcp_<server>_*` 工具数量
 *     与注册一次时相同(不翻倍、不重复);且 getMCPServers() 中该名 server 只有一条(强信号,
 *     因为 listTools/getToolDefinitions 会按名去重,能掩盖 _allTools 累加,而 _mcpServers 不去重)。
 *  ② 用不同 tool 集合重复注册 → 旧工具被替换而非累加(被移除的旧 tool 名消失,新 tool 名出现)。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcp-idem-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const toolCalling = require('../src/services/toolCalling');

function makeServer(name, toolNames) {
  return {
    name,
    tools: toolNames.map((t) => ({
      name: t,
      description: `stub ${t}`,
      inputSchema: { properties: {} },
    })),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

// 从暴露的工具列表里取属于某 server 的 `mcp_<server>_*` 函数名(排序去空)。
function mcpToolNamesFor(serverName) {
  const prefix = `mcp_${serverName}_`;
  return toolCalling
    .listTools()
    .map((t) => String(t && t.name || ''))
    .filter((n) => n.startsWith(prefix))
    .sort();
}

// _mcpServers 不去重:同名 server 出现几次,幂等被破坏时就会翻倍。
function mcpServerCount(serverName) {
  return toolCalling.getMCPServers().filter((s) => s && s.name === serverName).length;
}

describe('registerMCPServer 幂等注册(重复注册不产生重复 function 名)', () => {
  test('同名 server 注册两次 → 工具数量与注册一次相同,且 server 条目不翻倍', () => {
    const name = 'idemsrv';

    toolCalling.registerMCPServer(makeServer(name, ['echo', 'ping']));
    const afterOnce = mcpToolNamesFor(name);
    assert.equal(afterOnce.length, 2, '注册一次应有 2 个 mcp 工具');
    assert.equal(mcpServerCount(name), 1, '注册一次 server 条目应为 1');

    toolCalling.registerMCPServer(makeServer(name, ['echo', 'ping']));
    const afterTwice = mcpToolNamesFor(name);

    assert.deepEqual(afterTwice, afterOnce, '重复注册后工具名集合应与一次相同(不翻倍、不重复)');
    assert.equal(afterTwice.length, 2, '重复注册后工具数量仍为 2');
    assert.equal(mcpServerCount(name), 1, '幂等:_mcpServers 中同名 server 仍只有一条(累加则会 >1)');
  });

  test('用不同 tool 集合重复注册 → 旧工具被替换而非累加', () => {
    const name = 'replsrv';

    toolCalling.registerMCPServer(makeServer(name, ['alpha', 'beta']));
    assert.deepEqual(mcpToolNamesFor(name), [`mcp_${name}_alpha`, `mcp_${name}_beta`]);

    // 重新注册:去掉 beta、新增 gamma。
    toolCalling.registerMCPServer(makeServer(name, ['alpha', 'gamma']));
    const after = mcpToolNamesFor(name);

    assert.deepEqual(after, [`mcp_${name}_alpha`, `mcp_${name}_gamma`], '应替换为新 tool 集合');
    assert.ok(!after.includes(`mcp_${name}_beta`), '被移除的旧工具 beta 不应残留(替换而非累加)');
    assert.equal(mcpServerCount(name), 1, '替换注册后 server 条目仍为 1');
  });
});
