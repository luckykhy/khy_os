'use strict';

/**
 * Builtin-source tools must receive the same up-front input-schema validation
 * that registry-source tools already get — Claude Code alignment: an invalid
 * tool input returns a structured error the model can recover from, instead of
 * surfacing as a deeper handler-time crash.
 *
 * Builtin tools are raw { name, parameters, handler } objects (not defineTool()
 * products), so they carry a declarative flat `parameters` schema but no
 * `.validate()` method. The executeTool dispatcher validates that schema with
 * validateParams() before invoking the handler.
 */
describe('toolCalling builtin-source schema validation', () => {
  const prevDangerous = process.env.KHYQUANT_DANGEROUS;
  const prevGateway = process.env.KHY_SYSCALL_GATEWAY;
  const prevCcValidation = process.env.KHY_CC_VALIDATION_ERROR;
  let toolCalling;

  beforeEach(() => {
    // Isolate the validation layer from the orthogonal syscall-approval gateway
    // (DESIGN-ARCH-026) and the interactive permission prompt.
    process.env.KHYQUANT_DANGEROUS = 'true';
    process.env.KHY_SYSCALL_GATEWAY = 'off';
    delete process.env.KHY_CC_VALIDATION_ERROR; // 默认开:断言 CC 分组消息
    toolCalling = require('../src/services/toolCalling');
    toolCalling.enableDangerousMode();
    toolCalling.setPreflightContext(
      new Set(['export_ollama_model', 'optimize_config', 'open_app'])
    );
  });

  afterEach(() => {
    if (toolCalling && typeof toolCalling.clearPreflightContext === 'function') {
      toolCalling.clearPreflightContext();
    }
    if (prevDangerous === undefined) delete process.env.KHYQUANT_DANGEROUS;
    else process.env.KHYQUANT_DANGEROUS = prevDangerous;
    if (prevGateway === undefined) delete process.env.KHY_SYSCALL_GATEWAY;
    else process.env.KHY_SYSCALL_GATEWAY = prevGateway;
    if (prevCcValidation === undefined) delete process.env.KHY_CC_VALIDATION_ERROR;
    else process.env.KHY_CC_VALIDATION_ERROR = prevCcValidation;
    jest.resetModules();
  });

  // 门控 KHY_CC_VALIDATION_ERROR 默认开:校验失败消息对齐 CC `formatZodValidationError` 的
  // 「<tool> failed due to the following issue(s):」分组,缺失必填用「The required parameter `x` is missing」。
  test('rejects a builtin call missing a single required field with a structured error', async () => {
    const result = await toolCalling.executeTool('export_ollama_model', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/export_ollama_model failed due to the following issue/);
    expect(result.error).toMatch(/The required parameter `model` is missing/);
  });

  test('reports every missing required field, not just the first', async () => {
    const result = await toolCalling.executeTool('optimize_config', {
      target: 'system_prompt',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed due to the following issues/); // 复数(>1)
    expect(result.error).toMatch(/The required parameter `content` is missing/);
    expect(result.error).toMatch(/The required parameter `reason` is missing/);
  });

  test('validation runs before the handler (no handler side effects on invalid input)', async () => {
    // export_ollama_model's handler would require('./modelImportService') and hit
    // Ollama; if validation short-circuits correctly the error is purely the
    // schema message, never a downstream model-import failure.
    const result = await toolCalling.executeTool('export_ollama_model', { dest: '/tmp/x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'export_ollama_model failed due to the following issue:\nThe required parameter `model` is missing'
    );
  });

  test('门控关 KHY_CC_VALIDATION_ERROR=off → 逐字节回退历史 `Validation failed: …`', async () => {
    process.env.KHY_CC_VALIDATION_ERROR = 'off';
    const result = await toolCalling.executeTool('export_ollama_model', { dest: '/tmp/x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Validation failed: model is required');
  });
});
