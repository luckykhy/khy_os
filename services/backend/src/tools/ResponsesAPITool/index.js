const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class ResponsesAPITool extends BaseTool {
  static toolName = 'ResponsesAPI';
  static category = 'data';
  static risk = 'low';
  static aliases = ['responses_api', 'response_api', 'structured_response'];
  static searchHint = 'responses api structured output parsing';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Parse structured responses from model output.

Operations:
- "parse_response" — Parse a model response for structured data
- "extract_json" — Extract JSON from model response
- "validate_schema" — Validate response against JSON schema`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['parse_response', 'extract_json', 'validate_schema'],
          description: 'Operation to perform',
        },
        response: {
          type: 'string',
          description: 'Model response text to parse',
        },
        schema: {
          type: 'object',
          description: 'JSON schema for validation',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_RESPONSES_TIMEOUT_MS',
      defaultMs: 10000,
      min: 100,
      max: 30000,
    });

    try {
      const responses = require('../../services/responses');

      switch (params.operation) {
        case 'parse_response':
          if (!params.response) return { success: false, error: 'response is required' };
          return await withDeadline(
            () => responses.parseResponse(params.response),
            timeoutMs
          );

        case 'extract_json':
          if (!params.response) return { success: false, error: 'response is required' };
          return await withDeadline(
            () => responses.extractJson(params.response),
            timeoutMs
          );

        case 'validate_schema':
          if (!params.response) return { success: false, error: 'response is required' };
          return await withDeadline(
            () => responses.validateSchema(params.response, params.schema),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Responses API error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `响应解析：${input.operation || ''}`;
  }
}

module.exports = ResponsesAPITool;
