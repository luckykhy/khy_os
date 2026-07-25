'use strict';

/**
 * LSP Client — Language Server Protocol integration for precise code navigation.
 *
 * Manages connections to language servers for:
 *   - Go-to-definition
 *   - Find references
 *   - Hover information
 *   - Document symbols
 *   - Diagnostics
 *
 * Auto-detects language servers based on project files.
 *
 * @module lspClient
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { safeKill, searchExecutable } = require('../tools/platformUtils');
const crypto = require('crypto');
const log = require('../utils/logger');

// ── Language Server Registry ──

const SERVER_REGISTRY = {
  javascript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    detect: ['package.json', 'tsconfig.json', 'jsconfig.json'],
    install: 'npm install -g typescript-language-server typescript',
  },
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx'],
    detect: ['tsconfig.json'],
    install: 'npm install -g typescript-language-server typescript',
  },
  python: {
    command: 'pylsp',
    args: [],
    extensions: ['.py'],
    detect: ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'requirements.txt'],
    install: 'pip install python-lsp-server',
    alternatives: ['pyright-langserver'],
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    detect: ['Cargo.toml'],
    install: 'rustup component add rust-analyzer',
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    detect: ['go.mod', 'go.sum'],
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  java: {
    command: 'jdtls',
    args: [],
    extensions: ['.java'],
    detect: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    install: 'See https://github.com/eclipse-jdtls/eclipse.jdt.ls',
  },
  c: {
    command: 'clangd',
    args: [],
    extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'],
    detect: ['CMakeLists.txt', 'Makefile', 'compile_commands.json'],
    install: 'apt install clangd / brew install llvm',
  },
  vue: {
    command: 'vue-language-server',
    args: ['--stdio'],
    extensions: ['.vue'],
    detect: ['vue.config.js', 'vite.config.js', 'nuxt.config.js'],
    install: 'npm install -g @vue/language-server',
  },
};

// ── LSP JSON-RPC Protocol ──

let _requestId = 0;

function _createRequest(method, params) {
  const id = ++_requestId;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  return { id, data: header + msg };
}

function _createNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  return header + msg;
}

function _fileUri(filePath) {
  const absPath = path.resolve(filePath);
  return 'file://' + (process.platform === 'win32' ? '/' + absPath.replace(/\\/g, '/') : absPath);
}

// ── LSP Client Class ──

class LspClient {
  /**
   * @param {object} options
   * @param {string} options.rootPath - Project root directory
   * @param {string} [options.language] - Force a specific language server
   */
  constructor(options) {
    this._rootPath = path.resolve(options.rootPath || process.cwd());
    this._forcedLanguage = options.language || null;
    this._process = null;
    this._initialized = false;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._buffer = '';
    this._capabilities = {};
    this._serverInfo = null;
    this._language = null;
    this._diagnostics = new Map(); // uri → diagnostics[]
  }

  get initialized() { return this._initialized; }
  get language() { return this._language; }
  get capabilities() { return this._capabilities; }

  /**
   * Auto-detect and start the appropriate language server.
   * @returns {Promise<void>}
   */
  async start() {
    const lang = this._forcedLanguage || this._detectLanguage();
    if (!lang) {
      throw new Error(`No language server detected for ${this._rootPath}. Supported: ${Object.keys(SERVER_REGISTRY).join(', ')}`);
    }

    this._language = lang;
    const config = SERVER_REGISTRY[lang];
    if (!config) throw new Error(`Unknown language: ${lang}`);

    // Check if command exists
    if (!searchExecutable(config.command)) {
      throw new Error(`Language server "${config.command}" not found. Install: ${config.install}`);
    }

    log.info(`Starting ${config.command} for ${lang} in ${this._rootPath}`);

    this._process = spawn(config.command, config.args, {
      cwd: this._rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this._process.on('error', (err) => {
      log.error(`LSP spawn error: ${err.message}`);
      this._initialized = false;
    });

    // Parse stdout for JSON-RPC messages
    this._process.stdout.on('data', (chunk) => this._onData(chunk));
    this._process.stderr.on('data', (chunk) => {
      log.debug(`LSP stderr: ${chunk.toString('utf8').trim()}`);
    });
    this._process.on('exit', (code) => {
      log.info(`LSP server exited with code ${code}`);
      this._initialized = false;
    });

    // Initialize
    await this._initialize();
    this._initialized = true;
  }

  /**
   * Send LSP initialize request.
   * @private
   */
  async _initialize() {
    const result = await this._request('initialize', {
      processId: process.pid,
      rootUri: _fileUri(this._rootPath),
      rootPath: this._rootPath,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [{ uri: _fileUri(this._rootPath), name: path.basename(this._rootPath) }],
    });

    this._capabilities = result.capabilities || {};
    this._serverInfo = result.serverInfo || null;

    // Send initialized notification
    this._notify('initialized', {});

    log.info(`LSP initialized: ${this._serverInfo ? this._serverInfo.name : 'unknown'}`);
  }

  /**
   * Go to definition of the symbol at a position.
   * @param {string} filePath
   * @param {number} line - 0-based line number
   * @param {number} character - 0-based column
   * @returns {Promise<Array<{uri: string, range: object}>>}
   */
  async gotoDefinition(filePath, line, character) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/definition', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
    });

    return this._normalizeLocations(result);
  }

  /**
   * Find all references to the symbol at a position.
   * @param {string} filePath
   * @param {number} line
   * @param {number} character
   * @param {boolean} [includeDeclaration=true]
   * @returns {Promise<Array<{uri: string, range: object}>>}
   */
  async findReferences(filePath, line, character, includeDeclaration) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/references', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
      context: { includeDeclaration: includeDeclaration !== false },
    });

    return this._normalizeLocations(result);
  }

  /**
   * Get hover information at a position.
   * @param {string} filePath
   * @param {number} line
   * @param {number} character
   * @returns {Promise<{contents: string, range?: object} | null>}
   */
  async hover(filePath, line, character) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/hover', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
    });

    if (!result) return null;

    let contents = '';
    if (typeof result.contents === 'string') {
      contents = result.contents;
    } else if (result.contents && result.contents.value) {
      contents = result.contents.value;
    } else if (Array.isArray(result.contents)) {
      contents = result.contents.map((c) => (typeof c === 'string' ? c : c.value || '')).join('\n');
    }

    return { contents, range: result.range || null };
  }

  /**
   * Get document symbols (outline).
   * @param {string} filePath
   * @returns {Promise<Array<{name: string, kind: number, range: object, children?: any[]}>>}
   */
  async documentSymbols(filePath) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/documentSymbol', {
      textDocument: { uri: _fileUri(filePath) },
    });

    return result || [];
  }

  /**
   * Get diagnostics for a file.
   * @param {string} filePath
   * @returns {Array<object>}
   */
  getDiagnostics(filePath) {
    const uri = _fileUri(filePath);
    return this._diagnostics.get(uri) || [];
  }

  // ── Extended LSP methods ─────────────────────────────────────────

  /**
   * Get completion items at a position.
   * @param {string} filePath
   * @param {number} line - 0-based
   * @param {number} character - 0-based
   * @param {object} [context] - CompletionContext
   * @param {number} [context.triggerKind=1] - 1=Invoked, 2=TriggerCharacter, 3=Incomplete
   * @param {string} [context.triggerCharacter] - The trigger character if triggerKind=2
   * @returns {Promise<Array<{label: string, kind?: number, detail?: string, insertText?: string}>>}
   */
  async completion(filePath, line, character, context) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/completion', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
      context: context || { triggerKind: 1 },
    });

    if (!result) return [];
    const items = Array.isArray(result) ? result : (result.items || []);
    return items.map(item => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail || '',
      insertText: item.insertText || item.label,
      sortText: item.sortText,
    }));
  }

  /**
   * Rename a symbol at a position across the workspace.
   * @param {string} filePath
   * @param {number} line
   * @param {number} character
   * @param {string} newName
   * @returns {Promise<{changes: Object<string, Array<{range: object, newText: string}>>}>}
   */
  async rename(filePath, line, character, newName) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/rename', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
      newName,
    });

    if (!result) return { changes: {} };

    // Normalize WorkspaceEdit
    const changes = {};
    if (result.changes) {
      for (const [uri, edits] of Object.entries(result.changes)) {
        changes[uri.replace('file://', '')] = edits;
      }
    }
    if (result.documentChanges) {
      for (const docChange of result.documentChanges) {
        if (docChange.textDocument && docChange.edits) {
          const fp = (docChange.textDocument.uri || '').replace('file://', '');
          changes[fp] = docChange.edits;
        }
      }
    }
    return { changes };
  }

  /**
   * Format an entire document.
   * @param {string} filePath
   * @param {object} [options] - FormattingOptions
   * @param {number} [options.tabSize=2]
   * @param {boolean} [options.insertSpaces=true]
   * @returns {Promise<Array<{range: object, newText: string}>>}
   */
  async formatting(filePath, options) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/formatting', {
      textDocument: { uri: _fileUri(filePath) },
      options: {
        tabSize: options?.tabSize ?? 2,
        insertSpaces: options?.insertSpaces !== false,
      },
    });

    return result || [];
  }

  /**
   * Get code actions for a range (quick fixes, refactors, etc.).
   * @param {string} filePath
   * @param {object} range - { start: {line, character}, end: {line, character} }
   * @param {Array} [diagnostics] - Diagnostics to include in context
   * @returns {Promise<Array<{title: string, kind?: string, edit?: object, command?: object}>>}
   */
  async codeActions(filePath, range, diagnostics) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/codeAction', {
      textDocument: { uri: _fileUri(filePath) },
      range,
      context: {
        diagnostics: diagnostics || this.getDiagnostics(filePath),
      },
    });

    if (!result) return [];
    return result.map(action => ({
      title: action.title,
      kind: action.kind,
      edit: action.edit || null,
      command: action.command || null,
      isPreferred: action.isPreferred || false,
    }));
  }

  /**
   * Get signature help (function parameter hints) at a position.
   * @param {string} filePath
   * @param {number} line
   * @param {number} character
   * @returns {Promise<{signatures: Array<{label: string, parameters?: Array, documentation?: string}>, activeSignature?: number, activeParameter?: number} | null>}
   */
  async signatureHelp(filePath, line, character) {
    this._ensureInitialized();
    await this._openDocument(filePath);

    const result = await this._request('textDocument/signatureHelp', {
      textDocument: { uri: _fileUri(filePath) },
      position: { line, character },
    });

    if (!result) return null;
    return {
      signatures: (result.signatures || []).map(sig => ({
        label: sig.label,
        parameters: sig.parameters || [],
        documentation: typeof sig.documentation === 'string'
          ? sig.documentation
          : sig.documentation?.value || '',
      })),
      activeSignature: result.activeSignature ?? 0,
      activeParameter: result.activeParameter ?? 0,
    };
  }

  /**
   * Search workspace symbols by query string.
   * @param {string} query - Symbol name pattern
   * @returns {Promise<Array<{name: string, kind: number, location: object, containerName?: string}>>}
   */
  async workspaceSymbols(query) {
    this._ensureInitialized();

    const result = await this._request('workspace/symbol', { query: query || '' });

    if (!result) return [];
    return result.map(sym => ({
      name: sym.name,
      kind: sym.kind,
      location: {
        uri: sym.location?.uri,
        filePath: (sym.location?.uri || '').replace('file://', ''),
        range: sym.location?.range,
      },
      containerName: sym.containerName || '',
    }));
  }

  /**
   * Shutdown the language server.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._process) return;

    try {
      await this._request('shutdown', null);
      this._notify('exit', null);
    } catch { /* server may already be dead */ }

    // Force kill after 3s
    const p = this._process;
    setTimeout(() => {
      try { safeKill(p, 'SIGKILL', 0); } catch { /* ignore */ }
    }, 3000);

    this._process = null;
    this._initialized = false;
    this._pending.clear();
  }

  // ── Internal Methods ──

  _ensureInitialized() {
    if (!this._initialized) throw new Error('LSP client not initialized. Call start() first.');
  }

  /**
   * Open a document for tracking (textDocument/didOpen).
   * @private
   */
  async _openDocument(filePath) {
    const uri = _fileUri(filePath);
    const ext = path.extname(filePath);
    const langId = this._extToLanguageId(ext);

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // File doesn't exist, skip
    }

    this._notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: langId,
        version: 1,
        text: content,
      },
    });
  }

  _extToLanguageId(ext) {
    const map = {
      '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
      '.vue': 'vue',
    };
    return map[ext] || 'plaintext';
  }

  _normalizeLocations(result) {
    if (!result) return [];
    if (Array.isArray(result)) {
      return result.map((loc) => ({
        uri: loc.uri || loc.targetUri,
        range: loc.range || loc.targetRange,
        filePath: (loc.uri || loc.targetUri || '').replace('file://', ''),
      }));
    }
    if (result.uri) {
      return [{
        uri: result.uri,
        range: result.range,
        filePath: result.uri.replace('file://', ''),
      }];
    }
    return [];
  }

  /**
   * Detect the primary language of the project.
   * @private
   */
  _detectLanguage() {
    for (const [lang, config] of Object.entries(SERVER_REGISTRY)) {
      for (const marker of config.detect) {
        if (fs.existsSync(path.join(this._rootPath, marker))) {
          return lang;
        }
      }
    }
    return null;
  }

  /**
   * Send a JSON-RPC request and wait for response.
   * @private
   */
  _request(method, params) {
    return new Promise((resolve, reject) => {
      const { id, data } = _createRequest(method, params);

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out (30s)`));
      }, 30_000);
      timer.unref?.();

      this._pending.set(id, { resolve, reject, timer });
      try {
        this._process.stdin.write(data);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`LSP stdin write failed: ${err.message}`));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @private
   */
  _notify(method, params) {
    if (!this._process || !this._process.stdin.writable) return;
    this._process.stdin.write(_createNotification(method, params));
  }

  /**
   * Parse incoming JSON-RPC messages from stdout.
   * @private
   */
  _onData(chunk) {
    this._buffer += chunk.toString('utf8');

    // Parse Content-Length delimited messages
    while (true) {
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;

      const header = this._buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this._buffer = this._buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this._buffer.length < bodyStart + contentLength) break; // Wait for more data

      const body = this._buffer.substring(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.substring(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        this._handleMessage(msg);
      } catch (err) {
        log.debug('LSP parse error:', err.message);
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message.
   * @private
   */
  _handleMessage(msg) {
    // Response to a request
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);

      if (msg.error) {
        reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Notification from server
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = msg.params || {};
      if (uri) this._diagnostics.set(uri, diagnostics || []);
      return;
    }

    // Log unknown messages
    if (msg.method) {
      log.debug(`LSP notification: ${msg.method}`);
    }
  }
}

/**
 * Detect available language servers for a project.
 * @param {string} rootPath
 * @returns {Array<{language: string, command: string, available: boolean}>}
 */
function detectLanguageServers(rootPath) {
  const result = [];
  const { execSync } = require('child_process');

  for (const [lang, config] of Object.entries(SERVER_REGISTRY)) {
    const hasMarker = config.detect.some((m) => fs.existsSync(path.join(rootPath, m)));
    if (!hasMarker) continue;

    const available = !!searchExecutable(config.command);

    result.push({
      language: lang,
      command: config.command,
      available,
      install: config.install,
      extensions: config.extensions,
    });
  }

  return result;
}

module.exports = {
  LspClient,
  detectLanguageServers,
  SERVER_REGISTRY,
};
