const { BaseTool } = require('../_baseTool');
const { spawn } = require('child_process');
const { platformShell } = require('../platformUtils');

/**
 * 门控:KHY_MONITOR_BACKGROUND 默认开。
 * 关(0/false/off/no)→ 逐字节回退到旧的"阻塞到进程退出再整段返回"行为。
 * 开 → 对齐 CC Monitor 的非阻塞契约:立即返回 {taskId, outputFile},
 *      输出实时写入可 Read 的磁盘文件,进程退出时经 <task_notification> 自动回报。
 */
function _monitorBackgroundEnabled(env) {
  const raw = env && env.KHY_MONITOR_BACKGROUND;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

const MAX_TAIL = 10000;

class MonitorTool extends BaseTool {
  static toolName = 'Monitor';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['monitor', 'watch'];
  static searchHint = 'monitor watch process command background streaming';
  static shouldDefer = true;

  // Background mode returns immediately, so it is concurrency-safe; the legacy
  // blocking fallback (gate off) is not. Reflect the active behavior honestly.
  isConcurrencySafe() { return _monitorBackgroundEnabled(process.env); }

  prompt() {
    return `Start a long-running command in the background and stream its output to a file.
Use this for commands that produce ongoing/streaming output — tailing logs, file
watchers, API polling loops, \`watch\`, build/test watchers.

- The command runs in the background; this tool returns immediately with a
  \`taskId\` and an \`outputFile\` path.
- Read the \`outputFile\` with the Read tool at any time to inspect current output.
- You receive a <task_notification> when the monitored process exits.
- Do NOT use this for one-shot commands that finish quickly — use shellCommand.
- Do NOT use this for commands needing interactive input — they will hang.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to monitor (should produce streaming output)' },
        description: { type: 'string', description: 'Human-readable description of what is being monitored (used as the task label)' },
        timeout: { type: 'number', description: 'Optional idle/wall cap in ms (max 600000). Omit to let the monitor run until it exits on its own.' },
      },
      required: ['command'],
    };
  }

  async execute(params) {
    if (!_monitorBackgroundEnabled(process.env)) {
      return this._executeBlocking(params);
    }
    return this._executeBackground(params);
  }

  /**
   * CC-aligned non-blocking path. Spawns the command, streams stdout/stderr to a
   * Read-able disk file, registers the run in the shared backgroundShells map so
   * the tool-use loop drains a <task_notification> on exit, and returns at once.
   */
  _executeBackground(params) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const command = String(params.command || '');
    const description = params.description || command;

    let dir;
    try {
      dir = require('../../utils/dataHome').getDataDir('monitor');
    } catch {
      dir = os.tmpdir();
    }
    const taskId = `mon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputFile = path.join(dir, `${taskId}.log`);

    // Register into the SAME registry shellCommand's run_in_background uses, so
    // the existing toolUseLoop drain emits the exit <task_notification>. The
    // entry shape mirrors that path (status/command/result) plus monitor extras.
    let backgroundShells = null;
    try { ({ backgroundShells } = require('../backgroundShellRegistry')); } catch { /* drain just won't fire */ }
    const entry = {
      status: 'running',
      command,
      description,
      startedAt: Date.now(),
      kind: 'monitor',
      outputFile,
    };
    if (backgroundShells) backgroundShells.set(taskId, entry);

    let stream = null;
    try { stream = fs.createWriteStream(outputFile, { flags: 'a' }); } catch { stream = null; }

    // Bounded in-memory tail feeds the exit notification summary; the full live
    // stream lives in outputFile.
    const tail = [];
    let tailLen = 0;
    const append = (buf) => {
      const str = buf.toString();
      if (stream) { try { stream.write(str); } catch { /* file gone */ } }
      tail.push(str);
      tailLen += str.length;
      while (tailLen > MAX_TAIL && tail.length > 1) { tailLen -= tail.shift().length; }
    };
    const closeStream = () => { if (stream) { try { stream.end(); } catch { /* already closed */ } } };

    // CC's Monitor has no timeout (a monitor runs until it exits). Honor that by
    // default; only apply a kill timer when the caller explicitly asks for one.
    const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };
    if (Number.isFinite(params.timeout) && params.timeout > 0) {
      spawnOpts.timeout = Math.min(params.timeout, 600000);
    }

    let proc;
    try {
      const sh = platformShell(command);
      proc = spawn(sh.cmd, sh.args, spawnOpts);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : String(err);
      entry.result = { output: '', exitCode: null };
      closeStream();
      return { success: false, taskId, outputFile, error: entry.error, description };
    }

    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    proc.on('close', (code) => {
      closeStream();
      entry.status = code === 0 ? 'completed' : 'failed';
      const out = tail.join('').slice(-MAX_TAIL);
      entry.result = { output: out, exitCode: code };
      if (code !== 0) entry.error = `monitor "${description}" exited with code ${code}`;
    });
    proc.on('error', (err) => {
      closeStream();
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : String(err);
      entry.result = { output: tail.join('').slice(-MAX_TAIL), exitCode: null };
    });

    return {
      success: true,
      taskId,
      backgroundTaskId: taskId,
      outputFile,
      description,
      output: `已在后台启动监控（task_id=${taskId}）。\n输出实时写入:${outputFile}（用 Read 工具随时查看）。\n进程退出时会通过 <task_notification> 自动回报,无需轮询。`,
    };
  }

  /**
   * Legacy byte-identical fallback (KHY_MONITOR_BACKGROUND=off): block until the
   * process exits and return the captured output inline.
   */
  _executeBlocking(params) {
    const timeout = Math.min(params.timeout || 120000, 600000);
    const output = [];

    return new Promise((resolve) => {
      const sh = platformShell(params.command);
      const proc = spawn(sh.cmd, sh.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });

      proc.stdout.on('data', (data) => output.push(data.toString()));
      proc.stderr.on('data', (data) => output.push(data.toString()));

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          exitCode: code,
          output: output.join('').slice(-10000),
          description: params.description || params.command,
        });
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message, output: output.join('') });
      });
    });
  }

  getActivityDescription(input) { return `监控任务：${input.description || input.command}`; }
}

module.exports = MonitorTool;
module.exports._monitorBackgroundEnabled = _monitorBackgroundEnabled;
