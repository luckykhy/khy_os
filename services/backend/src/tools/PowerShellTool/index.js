const { BaseTool } = require('../_baseTool');
const { spawn } = require('child_process');
const { searchExecutable } = require('../platformUtils');

class PowerShellTool extends BaseTool {
  static toolName = 'PowerShell';
  static category = 'execution';
  static risk = 'high';
  static aliases = ['powershell', 'pwsh'];
  static searchHint = 'powershell windows command script';
  static shouldDefer = true;

  isEnabled() {
    return !!(searchExecutable('pwsh') || searchExecutable('powershell'));
  }

  isConcurrencySafe() { return false; }

  prompt() {
    return `Execute PowerShell commands. Available when pwsh or powershell is installed.
Use for Windows-specific tasks, .NET operations, or PowerShell scripting.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms', default: 120000 },
      },
      required: ['command'],
    };
  }

  async execute(params) {
    const shell = searchExecutable('pwsh') ? 'pwsh' : 'powershell';

    return new Promise((resolve) => {
      const output = [];
      const proc = spawn(shell, ['-NoProfile', '-Command', params.command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: params.timeout || 120000,
      });
      proc.stdout.on('data', d => output.push(d.toString()));
      proc.stderr.on('data', d => output.push(d.toString()));
      proc.on('close', code => resolve({ success: code === 0, exitCode: code, output: output.join('') }));
      proc.on('error', err => resolve({ success: false, error: err.message }));
    });
  }

  getActivityDescription(input) { return `执行 PowerShell：${input.command.slice(0, 60)}`; }
}

module.exports = PowerShellTool;
