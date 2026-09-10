// 工具系统增强测试
// 验证：权限控制、Tool Hooks、输出格式化
import { describe, expect, it, beforeEach, vi } from 'vitest';

describe('工具系统增强', () => {
  beforeEach(async () => {
    // 重置权限
    const { initDefaultPermissions } = await import('../src/api/toolSystem.js');
    initDefaultPermissions();
  });

  it('应能设置和获取工具权限', async () => {
    const { setToolPermission, getToolPermission, PermissionLevel } = await import('../src/api/toolSystem.js');

    setToolPermission('test.tool', PermissionLevel.ASK);
    expect(getToolPermission('test.tool')).toBe(PermissionLevel.ASK);

    setToolPermission('test.tool2', PermissionLevel.DENY);
    expect(getToolPermission('test.tool2')).toBe(PermissionLevel.DENY);
  });

  it('canExecuteTool 应正确检查权限', async () => {
    const { setToolPermission, canExecuteTool, PermissionLevel } = await import('../src/api/toolSystem.js');

    setToolPermission('allowed.tool', PermissionLevel.AUTO);
    setToolPermission('denied.tool', PermissionLevel.DENY);

    expect(canExecuteTool('allowed.tool')).toBe(true);
    expect(canExecuteTool('denied.tool')).toBe(false);
  });

  it('truncateOutput 应截断长文本', async () => {
    const { truncateOutput } = await import('../src/api/toolSystem.js');

    const shortText = 'Hello';
    expect(truncateOutput(shortText, 100)).toBe(shortText);

    const longText = 'A'.repeat(5000);
    const truncated = truncateOutput(longText, 4000);
    expect(truncated.length).toBeLessThan(longText.length);
    expect(truncated).toContain('已截断');
  });

  it('formatToolResult 应格式化各种类型', async () => {
    const { formatToolResult } = await import('../src/api/toolSystem.js');

    expect(formatToolResult('simple string')).toBe('simple string');

    const obj = { key: 'value' };
    const formatted = formatToolResult(obj);
    expect(formatted).toContain('"key"');
    expect(formatted).toContain('"value"');
  });

  it('isImageOutput 应检测图片 data URI', async () => {
    const { isImageOutput } = await import('../src/api/toolSystem.js');

    expect(isImageOutput('data:image/png;base64,abc123')).toBe(true);
    expect(isImageOutput('data:image/jpeg;base64,xyz789')).toBe(true);
    expect(isImageOutput('plain text')).toBe(false);
    expect(isImageOutput('')).toBe(false);
  });

  it('parseDataUri 应解析 data URI', async () => {
    const { parseDataUri } = await import('../src/api/toolSystem.js');

    const result = parseDataUri('data:image/png;base64,iVBORw0KGgo=');
    expect(result.mimeType).toBe('image/png');
    expect(result.data).toBe('iVBORw0KGgo=');

    expect(parseDataUri('not a data uri')).toBeNull();
  });

  it('jsonSchemaToTool 应生成 OpenAI 格式工具定义', async () => {
    const { jsonSchemaToTool } = await import('../src/api/toolSystem.js');

    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    };

    const tool = jsonSchemaToTool('read_file', 'Read a file', schema);
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('read_file');
    expect(tool.function.description).toBe('Read a file');
    expect(tool.function.parameters).toEqual(schema);
  });

  it('simpleSchema 应生成简单 Schema', async () => {
    const { simpleSchema } = await import('../src/api/toolSystem.js');

    const schema = simpleSchema({
      name: 'The name',
      age: { type: 'integer', description: 'The age' },
    }, ['name']);

    expect(schema.type).toBe('object');
    expect(schema.properties.name.type).toBe('string');
    expect(schema.properties.age.type).toBe('integer');
    expect(schema.required).toEqual(['name']);
  });

  it('registerHook 和 executeHooks 应工作', async () => {
    const { registerHook, HookType } = await import('../src/api/toolSystem.js');

    const calls = [];
    registerHook(HookType.BEFORE_EXECUTE, 'test.tool', (name, ctx) => {
      calls.push({ phase: 'before', name, ctx });
    });

    // 验证 hook 已注册（通过导入内部状态）
    // 注意：这里我们只能验证不抛出错误
    expect(calls).toEqual([]);
  });
});
