/**
 * Unit tests for MCP tool visibility in the tool registry.
 */
const tools = require('../src/tools');

function registerTool(name, overrides = {}, options = {}) {
  tools.register({
    name,
    description: overrides.description || name,
    category: overrides.category || 'custom',
    risk: overrides.risk || 'low',
    inputSchema: overrides.inputSchema || {},
    execute: overrides.execute || (async () => ({ success: true, tool: name })),
    isEnabled: overrides.isEnabled,
    isReadOnly: overrides.isReadOnly,
    isConcurrencySafe: overrides.isConcurrencySafe,
    isDestructive: overrides.isDestructive,
    maxResultSizeChars: overrides.maxResultSizeChars,
  }, options);
}

describe('tool registry MCP support', () => {
  beforeEach(() => {
    tools.reload();
  });

  test('includes MCP tools in query APIs and counts', () => {
    const toolName = 'mcp_visibility_test_tool';
    const beforeCount = tools.count();

    registerTool(toolName, {
      isEnabled: () => true,
      isReadOnly: true,
      isConcurrencySafe: true,
      isDestructive: true,
    }, { isMcp: true });

    expect(tools.count()).toBe(beforeCount + 1);
    expect(tools.get(toolName)).toBeDefined();
    expect(tools.getAll().has(toolName)).toBe(true);
    expect(tools.getEnabled().has(toolName)).toBe(true);
    expect(tools.getReadOnly().has(toolName)).toBe(true);
    expect(tools.getConcurrencySafe().has(toolName)).toBe(true);
    expect(tools.getDestructive({}).has(toolName)).toBe(true);
    expect(tools.getDefinitions().some(t => t.name === toolName)).toBe(true);
    expect(tools.getEnabledDefinitions().some(t => t.name === toolName)).toBe(true);
  });

  test('keeps built-in tool precedence over MCP tool name collisions', () => {
    const toolName = 'tool_collision_test';
    registerTool(toolName, { description: 'built-in source' });
    registerTool(toolName, { description: 'mcp source' }, { isMcp: true });

    expect(tools.get(toolName).description).toBe('built-in source');
    expect(tools.getAll().get(toolName).description).toBe('built-in source');
    expect(tools.assembleToolPool([]).get(toolName).description).toBe('built-in source');
  });

  test('uses MCP maxResultSizeChars in applyResultBudget', () => {
    const toolName = 'mcp_result_budget_test';
    registerTool(toolName, { maxResultSizeChars: 5 }, { isMcp: true });

    const result = tools.applyResultBudget(toolName, '0123456789');
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith('01234')).toBe(true);
  });
});
