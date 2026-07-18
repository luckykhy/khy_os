'use strict';

const { BaseTool } = require('../_baseTool');

/**
 * StructuredOutputTool —— 结构化最终输出。对齐 Claude Code 的 StructuredOutput
 * (SyntheticOutputTool)。非交互(headless `khy -p --output-format json`)模式下,模型在
 * 回合末**调用一次**本工具,把最终答复按调用方要求的 JSON Schema 产出。
 *
 * 背后的逻辑(schema 校验)收敛在纯叶子 services/output/jsonSchemaValidate.js(零依赖确定性子集
 * 校验器,对齐 CC 的 Ajv 角色但不引入新依赖)。本壳只负责:解析 schema 来源(入参 `_schema`
 * 优先,否则注入的 env KHY_OUTPUT_SCHEMA)、剥离元字段、调叶子校验、命中失败时回带可读错误供模型自纠。
 *
 *   · 有 schema 且通过 → { success:true, structured_output:<data> }
 *   · 有 schema 未通过 → { success:false, schemaMismatch:true, errors, message }(模型据此自纠)
 *   · 无 schema        → { success:true, structured_output:<data> }(原样透传,对齐 CC 基础工具)
 *
 * 只读、并发安全、不写盘。门控 KHY_STRUCTURED_OUTPUT 默认开;关 → 返回 disabled(等价工具缺席,
 * 字节回退)。**绝不**引入新 host/port/path/model 硬编码;schema 全部来自调用方/注入 env。
 */
class StructuredOutputTool extends BaseTool {
  static toolName = 'StructuredOutput';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['structured_output'];
  static searchHint = '结构化输出 最终答复 JSON schema 校验 非交互 headless structured output final response';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      '把你的最终答复按调用方要求的结构化格式(JSON Schema)返回。',
      '在回合末**调用本工具恰好一次**以提交结构化输出。',
      '若提供了 schema 且校验未通过,会返回错误,请据错误修正后重新调用。',
    ].join('\n');
  }

  get inputSchema() {
    // 动态结构:接受任意字段(实际约束由调用方 schema 在 execute 内施加)。
    return {
      type: 'object',
      properties: {
        _schema: {
          type: 'object',
          description: '可选:本次输出要遵循的 JSON Schema(通常由非交互调用方注入,不必由模型填写)。',
        },
      },
      required: [],
    };
  }

  _enabled(env) {
    const FALSY = new Set(['0', 'false', 'off', 'no']);
    const raw = env && env.KHY_STRUCTURED_OUTPUT;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !FALSY.has(v);
  }

  /** 解析 schema 来源:入参 `_schema`(对象)优先,否则注入 env KHY_OUTPUT_SCHEMA(JSON 串,防御性解析)。 */
  _resolveSchema(params, env) {
    if (params && params._schema && typeof params._schema === 'object') return params._schema;
    const raw = env && env.KHY_OUTPUT_SCHEMA;
    if (typeof raw === 'string' && raw.trim()) {
      try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') return parsed; } catch { /* 非法 JSON → 视为无 schema */ }
    }
    return null;
  }

  async execute(params = {}) {
    if (!this._enabled(process.env)) {
      return { success: false, disabled: true, message: 'StructuredOutput 已关闭(KHY_STRUCTURED_OUTPUT=off)。' };
    }

    // 剥离元字段 `_schema`,其余即「结构化数据」本体。
    const data = {};
    if (params && typeof params === 'object') {
      for (const k of Object.keys(params)) { if (k !== '_schema') data[k] = params[k]; }
    }

    const schema = this._resolveSchema(params, process.env);
    if (!schema) {
      // 无 schema:原样透传(对齐 CC 基础 SyntheticOutputTool 行为)。
      return { success: true, structured_output: data, schemaApplied: false };
    }

    const { validateAgainstSchema, formatSchemaErrors } = require('../../services/output/jsonSchemaValidate');
    const { valid, errors } = validateAgainstSchema(data, schema);
    if (!valid) {
      const detail = formatSchemaErrors(errors);
      return {
        success: false,
        schemaMismatch: true,
        errors,
        message: `结构化输出不满足要求的 schema: ${detail}`,
      };
    }
    return { success: true, structured_output: data, schemaApplied: true };
  }

  getActivityDescription() {
    return '提交结构化输出';
  }
}

module.exports = StructuredOutputTool;
