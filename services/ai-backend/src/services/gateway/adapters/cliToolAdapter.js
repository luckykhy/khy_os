/**
 * CLI Tool Adapter — detect and invoke local AI CLI tools
 * (Claude Code, Codex, Aider, etc.) via child processes.
 *
 * Supports streaming output for Claude Code (stream-json format)
 * so the user can see thinking and response in real-time.
 */
const { execFileSync, spawn } = require('child_process');

const TOOLS = [
  {
    name: 'Claude Code',
    cmd: 'claude',
    buildArgs: () => ['-p', '--output-format', 'stream-json', '--verbose'],
    useStdin: true,
    streaming: true,
    priority: 1,
  },
  {
    name: 'Codex',
    cmd: 'codex',
    buildArgs: () => ['--quiet'],
    useStdin: true,
    streaming: false,
    priority: 2,
  },
  {
    name: 'Aider',
    cmd: 'aider',
    buildArgs: () => ['--message', '__PROMPT__', '--yes', '--no-auto-commits'],
    useStdin: false,
    streaming: false,
    priority: 3,
  },
];

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

let _detected = null; // cached detection results

/**
 * Check if a command exists on the system PATH.
 */
function commandExists(cmd) {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(lookup, [cmd], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which CLI tools are available.
 * Returns boolean; caches the tool list internally.
 */
function detect(forceRefresh = false) {
  if (_detected !== null && !forceRefresh) return _detected.length > 0;

  _detected = TOOLS
    .filter(tool => commandExists(tool.cmd))
    .sort((a, b) => a.priority - b.priority);

  return _detected.length > 0;
}

/**
 * Get the list of detected tools (for status display).
 */
function getDetectedTools() {
  if (_detected === null) detect();
  return _detected;
}

/**
 * Invoke a streaming CLI tool (Claude Code) and emit chunks via callback.
 *
 * The onChunk callback receives objects like:
 *   { type: 'thinking', text: '...' }
 *   { type: 'text', text: '...' }
 *   { type: 'cost', cost: 0.05 }
 */
function invokeStreamingTool(tool, prompt, onChunk) {
  return new Promise((resolve, reject) => {
    const args = tool.buildArgs();
    const child = spawn(tool.cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      env: process.env,
    });

    let fullContent = '';
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(event, onChunk, (text) => { fullContent += text; });
        } catch {
          // not valid JSON, ignore
        }
      }
    });

    let stderr = '';
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER) stderr += chunk;
    });

    child.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          processStreamEvent(event, onChunk, (text) => { fullContent += text; });
        } catch { /* ignore */ }
      }

      if (code === 0 || fullContent.trim()) {
        resolve(fullContent.trim());
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    child.on('error', (err) => reject(err));

    // Pipe prompt via stdin
    if (tool.useStdin) {
      child.stdin.on('error', () => {}); // Ignore EPIPE if child exits early
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * Process a single stream-json event from Claude Code.
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
  } else if (event.type === 'result') {
    if (event.total_cost_usd) {
      onChunk({ type: 'cost', cost: event.total_cost_usd });
    }
    // Use result text as final content if we haven't collected any
    if (event.result && typeof event.result === 'string') {
      appendContent(''); // mark as received — actual content from assistant events
    }
  }
}

/**
 * Invoke a non-streaming CLI tool (Codex, Aider).
 */
function invokeToolAsync(tool, prompt) {
  return new Promise((resolve, reject) => {
    let args;
    if (tool.useStdin) {
      args = tool.buildArgs();
    } else {
      args = tool.buildArgs().map(a => a === '__PROMPT__' ? prompt : a);
    }

    const child = spawn(tool.cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;

    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) stdout += chunk;
    });

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    child.on('error', (err) => reject(err));

    if (tool.useStdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * Generate a response using the best available CLI tool.
 * Tries each detected tool in priority order.
 *
 * @param {string} prompt
 * @param {object} options
 * @param {function} [options.onChunk] - streaming callback for real-time output
 */
async function generate(prompt, options = {}) {
  const tools = getDetectedTools();
  if (tools.length === 0) {
    return { success: false, content: '', provider: '', adapter: 'cli' };
  }

  const attempts = [];
  const onChunk = options.onChunk || (() => {});

  for (const tool of tools) {
    try {
      let content;
      if (tool.streaming) {
        content = await invokeStreamingTool(tool, prompt, onChunk);
      } else {
        content = await invokeToolAsync(tool, prompt);
      }
      attempts.push({ provider: tool.name, success: true });
      return {
        success: true,
        content,
        provider: tool.name,
        adapter: 'cli',
        attempts,
      };
    } catch (err) {
      attempts.push({ provider: tool.name, success: false, error: err.message });
    }
  }

  return { success: false, content: '', provider: '', adapter: 'cli', attempts };
}

/**
 * Get adapter status for display.
 */
function getStatus() {
  detect(); // ensure detection has run
  const tools = getDetectedTools();
  return {
    name: 'CLI 工具桥接',
    type: 'cli',
    available: tools.length > 0,
    detail: tools.length > 0
      ? tools.map(t => t.name).join(', ')
      : '未检测到 (claude/codex/aider)',
  };
}

function destroy() {
  _detected = null;
}

module.exports = { detect, generate, getStatus, destroy, TOOLS };
