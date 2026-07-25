const { BaseTool } = require('../_baseTool');
const fs = require('fs');

class VerifyPlanExecutionTool extends BaseTool {
  static toolName = 'VerifyPlanExecution';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['verify_plan'];
  static searchHint = 'verify plan execution check completed';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Verify that a plan has been executed correctly.
Checks the current state against a plan file to determine completion status.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        plan_path: { type: 'string', description: 'Path to the plan file' },
        checks: { type: 'array', description: 'Specific items to verify', items: { type: 'string' } },
      },
      required: ['plan_path'],
    };
  }

  async execute(params) {
    if (!fs.existsSync(params.plan_path)) {
      return { error: `Plan file not found: ${params.plan_path}` };
    }
    const content = fs.readFileSync(params.plan_path, 'utf-8');
    return {
      success: true,
      plan_path: params.plan_path,
      plan_content: content,
      checks: params.checks || [],
      note: 'Plan loaded for verification. AI will analyze execution status.',
    };
  }
}

module.exports = VerifyPlanExecutionTool;
