const { BaseTool } = require('../_baseTool');

class LSPTool extends BaseTool {
  static toolName = 'LSP';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['lsp', 'language_server'];
  static searchHint = 'language server protocol symbols definitions references completion rename format';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Query language server for code intelligence.
Provides symbol definitions, references, hover, diagnostics, completion,
rename preview, formatting, code actions, signature help, and workspace symbol search.
Requires a compatible language server to be available.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'LSP action to perform',
          enum: [
            'definition', 'references', 'hover', 'symbols', 'diagnostics',
            'completion', 'rename', 'formatting', 'codeActions', 'signatureHelp', 'workspaceSymbols',
          ],
        },
        file_path: { type: 'string', description: 'Path to the source file' },
        line: { type: 'number', description: 'Line number (0-based)' },
        character: { type: 'number', description: 'Character offset (0-based)' },
        query: { type: 'string', description: 'Symbol name to search for (symbols/workspaceSymbols)' },
        new_name: { type: 'string', description: 'New name for rename action' },
        range: { type: 'object', description: 'Range for codeActions: {start:{line,character}, end:{line,character}}' },
        options: { type: 'object', description: 'Formatting options: {tabSize, insertSpaces}' },
        timeoutMs: { type: 'number', description: 'Optional hard timeout in milliseconds for the LSP request (default 20000, range 1000–120000). Backstops an unresponsive language server so the call does not hang.' },
      },
      required: ['action'],
    };
  }

  async execute(params) {
    const lsp = this._getLspClient();
    if (!lsp) {
      return {
        success: false,
        note: 'LSP server not connected. Use grep/glob for code navigation, or configure a language server.',
        action: params.action,
        file: params.file_path,
      };
    }

    const dispatch = async () => {
      switch (params.action) {
        case 'definition':
          return { success: true, locations: await lsp.gotoDefinition(params.file_path, params.line, params.character) };
        case 'references':
          return { success: true, locations: await lsp.findReferences(params.file_path, params.line, params.character) };
        case 'hover':
          return { success: true, hover: await lsp.hover(params.file_path, params.line, params.character) };
        case 'symbols':
          return { success: true, symbols: await lsp.documentSymbols(params.file_path) };
        case 'diagnostics':
          return { success: true, diagnostics: lsp.getDiagnostics(params.file_path) };
        case 'completion':
          return { success: true, items: await lsp.completion(params.file_path, params.line, params.character) };
        case 'rename':
          return { success: true, edits: await lsp.rename(params.file_path, params.line, params.character, params.new_name) };
        case 'formatting':
          return { success: true, edits: await lsp.formatting(params.file_path, params.options) };
        case 'codeActions':
          return { success: true, actions: await lsp.codeActions(params.file_path, params.range, null) };
        case 'signatureHelp':
          return { success: true, signatures: await lsp.signatureHelp(params.file_path, params.line, params.character) };
        case 'workspaceSymbols':
          return { success: true, symbols: await lsp.workspaceSymbols(params.query) };
        default:
          return { success: false, error: `Unknown action: ${params.action}` };
      }
    };

    try {
      // 模型可设墙钟兜底:语言服务器 RPC 无原生超时,若 LS 卡死则本调用不会永挂。
      // 门控关 → resolveToolTimeoutMs 回退默认,withDeadline 仍套(默认 20s);任务需要可自设。
      const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');
      const timeoutMs = resolveToolTimeoutMs({
        paramMs: params && params.timeoutMs,
        envKey: 'KHY_LSP_TIMEOUT_MS',
        defaultMs: 20000,
        min: 1000,
        max: 120000,
      });
      const raced = await withDeadline(() => dispatch(), timeoutMs);
      if (raced && raced.__timedOut) {
        return { success: false, error: `LSP "${params.action}" 超时:已达 ${raced.timeoutMs}ms 硬上限`, action: params.action };
      }
      if (raced && raced.__error) {
        return { success: false, error: (raced.__error && raced.__error.message) || String(raced.__error), action: params.action };
      }
      return raced;
    } catch (err) {
      return { success: false, error: err.message, action: params.action };
    }
  }

  _getLspClient() {
    try {
      const { serviceRegistry } = require('../../services/serviceRegistry');
      return serviceRegistry?.get?.('lspClient') || null;
    } catch {
      return null;
    }
  }

  getActivityDescription(input) { return `执行 LSP ${input.action}：${input.file_path || input.query || ''}`; }
}

module.exports = LSPTool;
