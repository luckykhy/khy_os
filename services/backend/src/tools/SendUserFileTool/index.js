const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

class SendUserFileTool extends BaseTool {
  static toolName = 'SendUserFile';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['send_file'];
  static searchHint = 'send file to user download share';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Present a file to the user for download or viewing.
Use when the user needs to receive a generated file.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        description: { type: 'string', description: 'Description of the file' },
      },
      required: ['file_path'],
    };
  }

  async execute(params) {
    if (!fs.existsSync(params.file_path)) {
      return { error: `File not found: ${params.file_path}` };
    }
    const stat = fs.statSync(params.file_path);
    return {
      success: true,
      file: params.file_path,
      name: path.basename(params.file_path),
      size: stat.size,
      description: params.description || path.basename(params.file_path),
    };
  }
}

module.exports = SendUserFileTool;
