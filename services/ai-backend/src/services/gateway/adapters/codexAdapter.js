/**
 * Codex Adapter — invoke OpenAI Codex CLI as a standalone IDE adapter.
 *
 * Uses `codex` CLI command, supports model selection and non-streaming output.
 */
const { execFileSync, spawn } = require('child_process');

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const KNOWN_MODELS = [
  { id: 'o4-mini', name: 'o4-mini', isDefault: true },
  { id: 'o3', name: 'o3', isDefault: false },
  { id: 'gpt-4.1', name: 'GPT-4.1', isDefault: false },
];

let _available = null;

function commandExists(cmd) {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(lookup, [cmd], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _available = commandExists('codex');
  return _available;
}

async function listModels() {
  return KNOWN_MODELS.map(m => ({
    ...m,
    provider: 'codex',
    description: '',
  }));
}

async function generate(prompt, options = {}) {
  if (!detect()) {
    return { success: false, content: '', provider: 'Codex', adapter: 'codex', attempts: [] };
  }

  const args = ['--quiet'];
  if (options.model) args.push('--model', options.model);

  try {
    const content = await new Promise((resolve, reject) => {
      const child = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_BUFFER) stdout += chunk;
        if (options.onChunk) options.onChunk({ type: 'text', text: chunk.toString() });
      });
      child.stderr.on('data', (chunk) => { if (stderr.length < MAX_BUFFER) stderr += chunk; });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `codex exited with code ${code}`));
      });

      child.on('error', reject);
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });

    return {
      success: true,
      content,
      provider: `Codex (${options.model || 'default'})`,
      adapter: 'codex',
      attempts: [{ provider: 'Codex', success: true }],
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      provider: 'Codex',
      adapter: 'codex',
      attempts: [{ provider: 'Codex', success: false, error: err.message }],
    };
  }
}

function getStatus() {
  detect();
  return {
    name: 'OpenAI Codex',
    type: 'codex',
    available: _available,
    detail: _available ? 'codex CLI 可用' : '未检测到 codex 命令',
  };
}

function destroy() { _available = null; }

module.exports = { detect, listModels, generate, getStatus, destroy };
