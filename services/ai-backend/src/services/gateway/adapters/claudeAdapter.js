/**
 * Claude Code Adapter — invoke Claude Code CLI as a standalone IDE adapter.
 *
 * Extends the existing cliToolAdapter pattern but supports:
 * - Model selection (--model flag)
 * - Model listing
 * - Dedicated IDE registration in the gateway
 */
const { execFileSync, spawn } = require('child_process');

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Known Claude Code models (detected dynamically where possible)
const KNOWN_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', isDefault: false, tier: 'ultra', category: 'reasoning' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', isDefault: true, tier: 'high', category: 'general' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', isDefault: false, tier: 'medium', category: 'fast' },
];

let _available = null;

function commandExists(cmd) {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(lookup, [cmd], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Detect if Claude Code CLI is available.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _available = commandExists('claude');
  return _available;
}

/**
 * List available models.
 */
async function listModels() {
  return KNOWN_MODELS.map(m => ({
    ...m,
    provider: 'claude',
    description: '',
  }));
}

/**
 * Process a stream-json event from Claude Code.
 */
function processStreamEvent(event, onChunk, appendContent) {
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        onChunk({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text) {
        onChunk({ type: 'text', text: block.text });
        appendContent(block.text);
      }
    }
  } else if (event.type === 'result' && event.total_cost_usd) {
    onChunk({ type: 'cost', cost: event.total_cost_usd });
  }
}

/**
 * Generate a response using Claude Code CLI.
 */
async function generate(prompt, options = {}) {
  if (!detect()) {
    return { success: false, content: '', provider: 'Claude Code', adapter: 'claude', attempts: [] };
  }

  const onChunk = options.onChunk || (() => {});
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (options.model) args.push('--model', options.model);

  try {
    const content = await new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
        env: process.env,
      });

      let fullContent = '';
      let buffer = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            processStreamEvent(event, onChunk, (text) => { fullContent += text; });
          } catch { /* not valid JSON */ }
        }
      });

      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_BUFFER) stderr += chunk;
      });

      child.on('close', (code) => {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            processStreamEvent(event, onChunk, (text) => { fullContent += text; });
          } catch { /* ignore */ }
        }
        if (code === 0 || fullContent.trim()) resolve(fullContent.trim());
        else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      child.on('error', reject);
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });

    return {
      success: true,
      content,
      provider: `Claude Code (${options.model || 'default'})`,
      adapter: 'claude',
      attempts: [{ provider: 'Claude Code', success: true }],
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      provider: 'Claude Code',
      adapter: 'claude',
      attempts: [{ provider: 'Claude Code', success: false, error: err.message }],
    };
  }
}

function getStatus() {
  detect();
  return {
    name: 'Claude Code',
    type: 'claude',
    available: _available,
    detail: _available ? 'claude CLI 可用' : '未检测到 claude 命令',
  };
}

function destroy() { _available = null; }

module.exports = { detect, listModels, generate, getStatus, destroy };
