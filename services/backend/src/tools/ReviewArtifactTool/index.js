const { BaseTool } = require('../_baseTool');
const fs = require('fs');

class ReviewArtifactTool extends BaseTool {
  static toolName = 'ReviewArtifact';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['review_artifact', 'review_code'];
  static searchHint = 'review code artifact verify quality';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Review a generated artifact (code, config, etc.) for correctness.
Reads the file and returns its content for review.
Use this before finalizing changes to verify quality.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to review' },
        focus: { type: 'string', description: 'What to focus on: security, correctness, style, all', enum: ['security', 'correctness', 'style', 'all'], default: 'all' },
      },
      required: ['file_path'],
    };
  }

  async execute(params) {
    const filePath = params.file_path;
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 1024) {
      return { error: 'File too large for review (>1MB)' };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      success: true,
      file: filePath,
      size: stat.size,
      lines: content.split('\n').length,
      content,
      focus: params.focus || 'all',
    };
  }

  getActivityDescription(input) { return `审查文件：${input.file_path}`; }
}

module.exports = ReviewArtifactTool;
