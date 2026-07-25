'use strict';

/**
 * backgroundTaskSpec — pure decisions for user-launched background tasks.
 *
 * A "background task" is one `khy tasks run` invocation: it is enqueued into the
 * durable task store and executed by a detached `scripts/task-runner.js` process
 * that survives REPL/CLI exit. This module decides, from user input, the task
 * record shape and the exact child-process argv the runner should spawn. It
 * performs NO IO and never throws — all inputs are passed in and callers do the
 * spawning / store writes (judgment/execution separation).
 *
 * Two kinds, unified as "spawn a child, tee to a log, mark terminal on exit":
 *   - shell : run a shell command   → platform shell (`cmd /c` | `/bin/sh -c`)
 *   - agent : run an AI goal headless → `node <khy> ai -p <prompt>` (one-shot
 *             print mode, see bin/khy.js `-p/--print`)
 */

const VALID_KINDS = Object.freeze(['shell', 'agent']);

function _str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Build the durable task record + child argv for a background task.
 *
 * @param {object} input
 * @param {string} input.kind      'shell' | 'agent'
 * @param {string} [input.command] shell command (required for kind 'shell')
 * @param {string} [input.prompt]  agent goal (required for kind 'agent')
 * @param {string} [input.cwd]     working directory for the child
 * @param {string} [input.platform] process.platform ('win32' selects cmd.exe)
 * @param {string} [input.nodeExec] node executable path (agent kind)
 * @param {string} [input.khyEntry] path to bin/khy.js (agent kind)
 * @returns {{ok:true,type:string,payload_json:object,argv:{file:string,args:string[]}}
 *          | {ok:false,error:string}}
 */
function buildTaskSpec(input) {
  const safe = input && typeof input === 'object' ? input : {};
  const kind = _str(safe.kind).trim().toLowerCase();
  const platform = _str(safe.platform);
  const nodeExec = _str(safe.nodeExec) || 'node';
  const khyEntry = _str(safe.khyEntry);
  const cwd = _str(safe.cwd).trim();
  const command = _str(safe.command).trim();
  const prompt = _str(safe.prompt).trim();

  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, error: `未知任务类型: ${_str(safe.kind) || '(空)'}（支持 shell | agent）` };
  }

  if (kind === 'shell') {
    if (!command) return { ok: false, error: 'shell 任务需要非空的命令。' };
    const argv = platform === 'win32'
      ? { file: 'cmd', args: ['/c', command] }
      : { file: '/bin/sh', args: ['-c', command] };
    return {
      ok: true,
      type: 'local_bash',
      payload_json: {
        source: 'bg_task',
        kind: 'shell',
        command,
        cwd: cwd || null,
        runner_pid: null,
        child_pid: null,
      },
      argv,
    };
  }

  // kind === 'agent'
  if (!prompt) return { ok: false, error: 'agent 任务需要非空的目标(prompt)。' };
  if (!khyEntry) return { ok: false, error: 'agent 任务需要 khy 入口路径。' };
  return {
    ok: true,
    type: 'local_agent',
    payload_json: {
      source: 'bg_task',
      kind: 'agent',
      prompt,
      cwd: cwd || null,
      runner_pid: null,
      child_pid: null,
    },
    argv: { file: nodeExec, args: [khyEntry, 'ai', '-p', prompt] },
  };
}

/**
 * Decide which pid to kill when stopping a background task. Prefer the detached
 * runner pid (killing it tears down its child); fall back to the child pid.
 *
 * @param {object} task durable task record
 * @returns {{pid: number|null}}
 */
function buildStopPlan(task) {
  const safe = task && typeof task === 'object' ? task : {};
  const payload = safe.payload_json && typeof safe.payload_json === 'object' ? safe.payload_json : {};
  const runnerPid = Number(payload.runner_pid);
  const childPid = Number(payload.child_pid);
  if (Number.isInteger(runnerPid) && runnerPid > 0) return { pid: runnerPid };
  if (Number.isInteger(childPid) && childPid > 0) return { pid: childPid };
  return { pid: null };
}

/**
 * One-line summary of a background task for list output.
 * @param {object} task
 * @returns {string}
 */
function describeTask(task) {
  const safe = task && typeof task === 'object' ? task : {};
  const payload = safe.payload_json && typeof safe.payload_json === 'object' ? safe.payload_json : {};
  const kind = _str(payload.kind) || '?';
  const detail = kind === 'agent' ? _str(payload.prompt) : _str(payload.command);
  const trimmed = detail.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[${kind}] ${trimmed}`.trim();
}

module.exports = { VALID_KINDS, buildTaskSpec, buildStopPlan, describeTask };
