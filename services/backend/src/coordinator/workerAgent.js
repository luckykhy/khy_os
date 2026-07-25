/**
 * Worker Agent — manages worker lifecycle for coordinator mode.
 *
 * Workers are in-process async tasks that run with full tool sets.
 * They reuse the existing AI chat + tool execution pipeline.
 */
'use strict';

const crypto = require('crypto');
const { startWatchdog } = require('../services/resourceGuard');

// ── Structured Output Contract (G4) ──────────────────────────────
// Sub-agents must return results in this format so the parent agent
// can reliably parse findings for the next step.
const OUTPUT_CONTRACT = [
  '',
  '## Output Contract',
  'Structure your final response with these sections:',
  '',
  'SUMMARY: One paragraph — what you did and the outcome.',
  'CHANGES: Modified files with brief description. "None." if read-only task.',
  'EVIDENCE: Key findings with file:line references. Be precise.',
  'RISKS: What could go wrong or needs attention. "None." if clean.',
  'BLOCKERS: What stopped you or needs resolution. "None." if completed cleanly.',
].join('\n');

/**
 * Parse structured agent output into sections.
 * @param {string} raw - Raw agent output text
 * @returns {{ summary: string, changes: string, evidence: string, risks: string, blockers: string }}
 */
function parseAgentOutput(raw) {
  const sections = {};
  const keys = ['SUMMARY', 'CHANGES', 'EVIDENCE', 'RISKS', 'BLOCKERS'];
  for (const key of keys) {
    const re = new RegExp(
      `^${key}:\\s*(.+?)(?=^(?:${keys.join('|')}):|$)`, 'ms'
    );
    const m = (raw || '').match(re);
    sections[key.toLowerCase()] = m ? m[1].trim() : '';
  }
  return sections;
}

// ── Spawn Limits (zero-hardcoding: configurable via env or opts) ──

const WORKER_DEFAULTS = {
  maxSpawnDepth: parseInt(process.env.KHY_MAX_SPAWN_DEPTH, 10) || 3,
  maxConcurrentChildren: parseInt(process.env.KHY_MAX_CONCURRENT_CHILDREN, 10) || 3,
  childTimeoutMs: parseInt(process.env.KHY_CHILD_TIMEOUT_MS, 10) || 300_000,
};

// ── Worker Registry ────────────────────────────────────────────────

const _workers = new Map(); // id → WorkerState

/** @type {Map<string, Set<string>>} parentId → Set of child worker IDs */
const _childrenOf = new Map();

/**
 * @typedef {object} MailboxEntry
 * @property {number} seq - Monotonically increasing sequence number
 * @property {string} message - The follow-up message content
 * @property {number} sentAt - Timestamp when enqueued
 * @property {boolean} acked - Whether the worker acknowledged receipt
 */

/**
 * @typedef {object} Mailbox
 * @property {MailboxEntry[]} queue
 * @property {number} nextSeq
 * @property {number} maxSize
 * @property {number} ackedSeq
 */

/**
 * @typedef {object} WorkerState
 * @property {string} id
 * @property {string} task
 * @property {'pending'|'running'|'completed'|'error'|'stopped'} status
 * @property {string} result
 * @property {number} startedAt
 * @property {number} [completedAt]
 * @property {string} [error]
 * @property {AbortController} [abortController]
 * @property {Mailbox} mailbox - Bounded message queue with ACK support
 */

function _newId() {
  return 'w-' + crypto.randomBytes(3).toString('hex');
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Spawn a new worker to execute a task.
 * @param {string} taskDescription - Self-contained task prompt
 * @param {object} [opts]
 * @param {string} [opts.role] - Agent role (explore/planner/coder/reviewer/general)
 * @param {string} [opts.preferredAdapter] - Preferred gateway adapter (e.g. codex/claude)
 * @param {string} [opts.preferredModel] - Preferred model ID
 * @param {number} [opts.timeout] - Timeout in ms (default: 120000)
 * @param {boolean} [opts.processMode] - If true, fork a separate process (isolated heap)
 * @param {number} [opts.maxHeapMB] - Per-process heap limit (processMode only)
 * @param {object} [opts.parentContext] - AgentContext instance for context inheritance
 * @returns {Promise<WorkerState>}
 */
async function spawnWorker(taskDescription, opts = {}) {
  // ── Depth guard — prevent unbounded recursive spawning ─────────────
  const currentDepth = opts.parentContext?.depth || 0;
  if (currentDepth >= WORKER_DEFAULTS.maxSpawnDepth) {
    const rejected = {
      id: _newId(),
      task: taskDescription,
      status: 'error',
      result: '',
      startedAt: Date.now(),
      completedAt: Date.now(),
      error: `Spawn rejected: depth ${currentDepth} >= maxSpawnDepth ${WORKER_DEFAULTS.maxSpawnDepth}`,
      mailbox: { queue: [], nextSeq: 1, maxSize: 20, ackedSeq: 0 },
    };
    _workers.set(rejected.id, rejected);
    return rejected;
  }

  // ── Concurrency guard — limit children per parent ──────────────────
  const parentId = opts.parentContext?.id || '__root__';
  const siblings = _childrenOf.get(parentId);
  const activeCount = siblings
    ? [...siblings].filter(cid => {
        const w = _workers.get(cid);
        return w && (w.status === 'pending' || w.status === 'running');
      }).length
    : 0;
  if (activeCount >= WORKER_DEFAULTS.maxConcurrentChildren) {
    const rejected = {
      id: _newId(),
      task: taskDescription,
      status: 'error',
      result: '',
      startedAt: Date.now(),
      completedAt: Date.now(),
      error: `Spawn rejected: ${activeCount} active children >= maxConcurrentChildren ${WORKER_DEFAULTS.maxConcurrentChildren}`,
      mailbox: { queue: [], nextSeq: 1, maxSize: 20, ackedSeq: 0 },
    };
    _workers.set(rejected.id, rejected);
    return rejected;
  }

  // ── Process-isolated mode ──────────────────────────────────────────
  if (opts.processMode) {
    return _spawnProcessWorker(taskDescription, opts);
  }

  // ── In-process mode (default, backward compatible) ─────────────────
  const id = _newId();
  const abortController = new AbortController();

  const worker = {
    id,
    task: taskDescription,
    role: opts.role || 'coder',
    preferredAdapter: String(opts.preferredAdapter || '').trim(),
    preferredModel: String(opts.preferredModel || '').trim(),
    status: 'pending',
    result: '',
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    abortController,
    mailbox: {
      queue: [],
      nextSeq: 1,
      maxSize: opts.maxMailboxSize || 20,
      ackedSeq: 0,
    },
    toolCalls: 0,
    tokens: 0,
    _depth: currentDepth,
  };
  _workers.set(id, worker);

  // ── TaskBoard integration — auto-claim task if taskId provided ────
  if (opts.taskId) {
    try {
      const taskBoard = require('./taskBoard');
      const claimed = taskBoard.claimTask(opts.taskId, worker.id);
      if (!claimed) {
        worker.status = 'error';
        worker.error = `Failed to claim task ${opts.taskId} (already claimed or deps unmet)`;
        worker.completedAt = Date.now();
        return worker;
      }
      worker._taskId = opts.taskId;
    } catch { /* taskBoard not available */ }
  }

  // Register parent→child relationship
  if (!_childrenOf.has(parentId)) _childrenOf.set(parentId, new Set());
  _childrenOf.get(parentId).add(id);

  // Execute asynchronously
  _executeWorker(worker, opts).catch(err => {
    worker.status = 'error';
    worker.error = err.message;
    worker.completedAt = Date.now();
  });

  return worker;
}

/**
 * Send a follow-up message to an active worker via its mailbox.
 * Returns a status object with delivery info and backpressure signal.
 * @param {string} workerId
 * @param {string} message
 * @returns {{ delivered: boolean, seq?: number, queueSize?: number, reason?: string }}
 */
function sendMessage(workerId, message) {
  const worker = _workers.get(workerId);
  if (!worker) return { delivered: false, reason: 'unknown_worker' };
  if (worker.status !== 'running') return { delivered: false, reason: 'not_running' };

  const mailbox = worker.mailbox;
  // Backpressure: reject if queue full
  if (mailbox.queue.length >= mailbox.maxSize) {
    return { delivered: false, reason: 'backpressure', queueSize: mailbox.queue.length };
  }

  const seq = mailbox.nextSeq++;
  mailbox.queue.push({ seq, message, sentAt: Date.now(), acked: false });
  worker._lastActivity = Date.now();
  return { delivered: true, seq, queueSize: mailbox.queue.length };
}

/**
 * Acknowledge receipt of a mailbox message.
 * Prunes fully-acked messages from the head of the queue.
 * @param {string} workerId
 * @param {number} seq - Sequence number to acknowledge
 * @returns {boolean}
 */
function acknowledgeMessage(workerId, seq) {
  const worker = _workers.get(workerId);
  if (!worker) return false;
  const entry = worker.mailbox.queue.find(m => m.seq === seq);
  if (!entry) return false;
  entry.acked = true;
  worker.mailbox.ackedSeq = Math.max(worker.mailbox.ackedSeq, seq);
  worker._lastActivity = Date.now();
  // Prune acked messages from head
  while (worker.mailbox.queue.length > 0 && worker.mailbox.queue[0].acked) {
    worker.mailbox.queue.shift();
  }
  return true;
}

/**
 * Get all unacknowledged messages in a worker's mailbox.
 * @param {string} workerId
 * @returns {MailboxEntry[]}
 */
function getUnackedMessages(workerId) {
  const worker = _workers.get(workerId);
  if (!worker) return [];
  return worker.mailbox.queue.filter(m => !m.acked);
}

/**
 * Stop a running worker gracefully, cascading to all children first.
 * @param {string} workerId
 * @returns {boolean}
 */
function shutdownWorker(workerId) {
  const worker = _workers.get(workerId);
  if (!worker) return false;

  // ── Hook: Stop ────────────────────────────────────────────────────
  try {
    const hookSystem = require('../cli/hooks/hookSystem');
    hookSystem.trigger('Stop', {
      agentId: workerId, task: worker.task, reason: 'shutdown',
    }).catch(() => {});
  } catch { /* hooks are best-effort */ }

  // ── Cascade: recursively shut down children before self ────────────
  const children = _childrenOf.get(workerId);
  if (children) {
    for (const childId of children) {
      shutdownWorker(childId);
    }
    _childrenOf.delete(workerId);
  }

  // Process-mode: delegate to ProcessAgent.kill()
  if (worker._processAgent) {
    worker._processAgent.kill();
    worker.status = 'stopped';
    worker.completedAt = Date.now();
    return true;
  }

  if (worker.abortController) {
    worker.abortController.abort();
  }
  worker.status = 'stopped';
  worker.completedAt = Date.now();
  return true;
}

/**
 * Get worker status.
 * @param {string} workerId
 * @returns {WorkerState|null}
 */
function getWorkerStatus(workerId) {
  return _workers.get(workerId) || null;
}

/**
 * List all workers with optional status filter.
 * @param {string} [statusFilter]
 * @returns {WorkerState[]}
 */
function listWorkers(statusFilter) {
  const all = [..._workers.values()];
  if (statusFilter) return all.filter(w => w.status === statusFilter);
  return all;
}

/**
 * Clean up completed workers older than threshold.
 * @param {number} [olderThanMs=300000] - Default 5 minutes
 */
function cleanup(olderThanMs = 300000) {
  const cutoff = Date.now() - olderThanMs;
  for (const [id, worker] of _workers) {
    if (worker.completedAt && worker.completedAt < cutoff) {
      _workers.delete(id);
      // Sync parent→child registry
      for (const [parentId, children] of _childrenOf) {
        children.delete(id);
        if (children.size === 0) _childrenOf.delete(parentId);
      }
    }
  }
}

// ── Internal Execution ─────────────────────────────────────────────

async function _executeWorker(worker, opts = {}) {
  worker.status = 'running';
  const timeoutMs = opts.timeout || WORKER_DEFAULTS.childTimeoutMs;

  // ── Hook: SubAgentStart ───────────────────────────────────────────
  try {
    const hookSystem = require('../cli/hooks/hookSystem');
    await hookSystem.trigger('SubAgentStart', {
      agentId: worker.id, task: worker.task, role: worker.role,
      depth: worker._depth || 0, mode: 'worker',
    });
  } catch { /* hooks are best-effort */ }

  // Activity-based idle watchdog (Rule 3: no fixed wall-clock timeout)
  const guard = startWatchdog(`worker:${worker.id}`, timeoutMs, () => {
    worker.status = 'error';
    worker.error = `Worker idle timeout after ${timeoutMs}ms`;
    worker.completedAt = Date.now();
    if (worker.abortController) worker.abortController.abort();
  });

  try {
    // Load the AI agent runner
    const agentRunner = require('../services/cliAgentRunner');
    const { AGENT_ROLES } = agentRunner;

    // Get the role configuration
    const role = AGENT_ROLES[worker.role] || AGENT_ROLES.general;
    const preferredAdapter = String(
      worker.preferredAdapter
      || opts.preferredAdapter
      || role.preferredAdapter
      || ''
    ).trim();
    const preferredModel = String(
      worker.preferredModel
      || opts.preferredModel
      || role.preferredModel
      || ''
    ).trim();

    // Build the worker prompt with structured output contract
    const prompt = `${role.systemPrompt}\n\nTask:\n${worker.task}\n${OUTPUT_CONTRACT}`;

    // Use a simple AI chat call with the role's tool profile
    let aiModule;
    try {
      aiModule = require('../cli/ai');
    } catch {
      // Fallback: use gateway directly
      const gateway = require('../services/gateway/aiGateway');
      const result = await gateway.generate(prompt);
      guard.touch();
      worker.result = typeof result === 'string' ? result : (result.text || result.reply || JSON.stringify(result));
      worker.status = 'completed';
      worker.completedAt = Date.now();
      guard.done();
      return;
    }

    // Use ai.chat with tool profile
    const chatOpts = {
      _isFollowUp: true,
      effort: 'medium',
    };
    if (preferredAdapter) chatOpts.preferredAdapter = preferredAdapter;
    if (preferredModel) chatOpts.preferredModel = preferredModel;

    // Create per-worker AgentContext for isolated state
    let agentCtx = null;
    try {
      const { AgentContext } = require('../services/agentContext');
      agentCtx = opts.parentContext
        ? opts.parentContext.fork({ role: worker.role, toolFilter: role.toolProfile })
        : new AgentContext({ role: worker.role, toolFilter: role.toolProfile });
      worker.agentContext = agentCtx;
    } catch { /* agentContext not available, fall back to global */ }

    // Apply tool profile from role
    if (role.toolProfile) {
      try {
        const toolRegistry = require('../tools');
        // 自审 #4:按用户 prompt 信号预激活延迟工具簇(加法式、幂等;门控关 → 空 → 字节回退)。
        if (agentCtx) {
          try {
            const { selectToolsToActivate } = require('../services/toolClusterActivation');
            for (const name of selectToolsToActivate(prompt)) {
              toolRegistry.ensureToolForContext(name, agentCtx);
            }
          } catch { /* 预激活最佳努力,失败不影响主流程 */ }
        }
        chatOpts.toolDefinitions = agentCtx
          ? toolRegistry.getDefinitionsForContext(agentCtx)
          : toolRegistry.getDefinitions(role.toolProfile);
      } catch { /* fallback: no filtering */ }
    }

    // Pass agentContext to chat options for downstream use
    if (agentCtx) {
      chatOpts._agentContext = agentCtx;
    }

    guard.touch(); // activity before AI call
    const result = await aiModule.chat(prompt, chatOpts);
    guard.touch(); // activity after AI call

    worker.result = result.reply || result.text || '';
    worker.parsedOutput = parseAgentOutput(worker.result);
    worker.tokens = result.tokenUsage?.totalTokens || 0;
    worker.toolCalls = (result.commands || []).length;
    worker.status = 'completed';
    worker.completedAt = Date.now();

    // Process pending follow-up messages from mailbox
    while (worker.mailbox.queue.length > 0 && worker.status === 'completed') {
      const entry = worker.mailbox.queue.find(m => !m.acked);
      if (!entry) break;
      worker.status = 'running';
      guard.touch();
      const followUp = await aiModule.chat(entry.message, {
        _isFollowUp: true,
        ...(preferredAdapter ? { preferredAdapter } : {}),
        ...(preferredModel ? { preferredModel } : {}),
      });
      guard.touch();
      worker.result += '\n---\n' + (followUp.reply || '');
      entry.acked = true;
      worker.mailbox.ackedSeq = Math.max(worker.mailbox.ackedSeq, entry.seq);
      worker.status = 'completed';
    }
    // Prune fully acked head
    while (worker.mailbox.queue.length > 0 && worker.mailbox.queue[0].acked) {
      worker.mailbox.queue.shift();
    }

    // ── 幻觉验证门 (借鉴 Hermes Agent _verify_created_cards) ──────
    // 验证 worker 报告的产出是否真实存在
    if (worker.result) {
      const hallucinations = _detectHallucinations(worker.result, worker.id);
      if (hallucinations.length > 0) {
        worker._hallucinations = hallucinations;
        // 注入警告到结果末尾
        worker.result += '\n\n⚠ 幻觉检测: ' + hallucinations.map(h => h.detail).join('; ');
      }
    }

    // ── TaskBoard auto-complete ──────────────────────────────────────
    if (worker._taskId) {
      try {
        const taskBoard = require('./taskBoard');
        taskBoard.completeTask(worker._taskId, worker.result?.slice(0, 2000) || '');
      } catch { /* best-effort */ }
    }

    // ── Hook: SubAgentEnd (success) ─────────────────────────────────
    try {
      const hookSystem = require('../cli/hooks/hookSystem');
      await hookSystem.trigger('SubAgentEnd', {
        agentId: worker.id, task: worker.task, status: 'completed',
        durationMs: (worker.completedAt || Date.now()) - worker.startedAt,
        toolCalls: worker.toolCalls, tokens: worker.tokens,
      });
    } catch { /* hooks are best-effort */ }

    guard.done();
  } catch (err) {
    guard.done();
    if (err.name === 'AbortError' || worker.status === 'stopped') {
      worker.status = 'stopped';
    } else {
      worker.status = 'error';
      worker.error = err.message;
    }
    worker.completedAt = Date.now();

    // ── TaskBoard auto-fail ──────────────────────────────────────────
    if (worker._taskId && worker.status === 'error') {
      try {
        const taskBoard = require('./taskBoard');
        taskBoard.failTask(worker._taskId, worker.error || 'Unknown error');
      } catch { /* best-effort */ }
    }

    // ── Hook: SubAgentEnd (error/stopped) ───────────────────────────
    try {
      const hookSystem = require('../cli/hooks/hookSystem');
      await hookSystem.trigger('SubAgentEnd', {
        agentId: worker.id, task: worker.task, status: worker.status,
        error: worker.error,
        durationMs: (worker.completedAt || Date.now()) - worker.startedAt,
      });
    } catch { /* hooks are best-effort */ }
  }
}

// ── Process-Isolated Worker ───────────────────────────────────────────

/**
 * Spawn a worker in a separate child process via ProcessAgent.
 * Returns a WorkerState-compatible object for registry interop.
 */
async function _spawnProcessWorker(taskDescription, opts = {}) {
  const { ProcessAgent } = require('./processAgent');

  const currentDepth = opts.parentContext?.depth || 0;
  const agent = new ProcessAgent(taskDescription, {
    role: opts.role || 'coder',
    timeoutMs: opts.timeout || WORKER_DEFAULTS.childTimeoutMs,
    maxHeapMB: opts.maxHeapMB,
    parentContext: opts.parentContext,
    maxSpawnDepth: WORKER_DEFAULTS.maxSpawnDepth,
  });

  const worker = {
    id: agent.id,
    task: taskDescription,
    role: agent.role,
    status: 'pending',
    result: '',
    startedAt: Date.now(),
    completedAt: null,
    error: null,
    abortController: null, // kill via agent.kill()
    mailbox: {
      queue: [],
      nextSeq: 1,
      maxSize: opts.maxMailboxSize || 20,
      ackedSeq: 0,
    },
    toolCalls: 0,
    tokens: 0,
    _processAgent: agent,
    _depth: currentDepth,
  };
  _workers.set(agent.id, worker);

  // Register parent→child relationship
  const parentId = opts.parentContext?.id || '__root__';
  if (!_childrenOf.has(parentId)) _childrenOf.set(parentId, new Set());
  _childrenOf.get(parentId).add(agent.id);

  // Run asynchronously
  agent.run()
    .then((state) => {
      worker.status = state.status === 'completed' ? 'completed' : 'error';
      worker.result = state.result || '';
      worker.completedAt = Date.now();
      if (state.metrics) {
        worker.tokens = state.metrics.heapUsedMB || 0; // approximate
      }
    })
    .catch((err) => {
      worker.status = 'error';
      worker.error = err.message;
      worker.completedAt = Date.now();
    });

  return worker;
}

// ── Worker-to-Worker Routing ─────────────────────────────────────────

/**
 * Route a message directly from one worker to a sibling worker.
 * Workers must share the same parent (be siblings) for routing to succeed.
 * @param {string} fromId - Sender worker ID
 * @param {string} toId - Recipient worker ID
 * @param {string} message - Message content
 * @returns {{ routed: boolean, seq?: number, reason?: string, path?: string, queueSize?: number }}
 */
function routeMessage(fromId, toId, message) {
  const from = _workers.get(fromId);
  const to = _workers.get(toId);
  if (!from || !to) return { routed: false, reason: 'unknown_worker' };
  if (to.status !== 'running') return { routed: false, reason: 'target_not_running' };

  // Verify siblings (same parent)
  let areSiblings = false;
  for (const [, children] of _childrenOf) {
    if (children.has(fromId) && children.has(toId)) { areSiblings = true; break; }
  }
  if (!areSiblings) return { routed: false, reason: 'not_siblings' };

  const mailbox = to.mailbox;
  if (mailbox.queue.length >= mailbox.maxSize) {
    return { routed: false, reason: 'backpressure', queueSize: mailbox.queue.length };
  }
  const seq = mailbox.nextSeq++;
  mailbox.queue.push({ seq, message, sentAt: Date.now(), acked: false, sender: fromId, route: 'direct' });
  to._lastActivity = Date.now();
  return { routed: true, seq, path: 'direct' };
}

// ── Zombie Worker Detection ─────────────────────────────────────────

const ZOMBIE_CHECK_INTERVAL = parseInt(process.env.KHY_ZOMBIE_CHECK_MS, 10) || 30_000;
const ZOMBIE_THRESHOLD_MS = parseInt(process.env.KHY_ZOMBIE_THRESHOLD_MS, 10) || 300_000;

/**
 * Detect and reap zombie workers — workers marked 'running' but idle beyond threshold.
 * @returns {string[]} IDs of reaped zombie workers
 */
function detectZombies() {
  const zombies = [];
  const now = Date.now();
  for (const [id, worker] of _workers) {
    if (worker.status !== 'running') continue;
    const lastActivity = worker._lastActivity || worker.startedAt;
    if (now - lastActivity > ZOMBIE_THRESHOLD_MS) {
      worker.status = 'error';
      worker.error = `Zombie: inactive for ${now - lastActivity}ms`;
      worker.completedAt = now;
      zombies.push(id);
      // Auto-fail taskBoard entry
      if (worker._taskId) {
        try { require('./taskBoard').failTask(worker._taskId, worker.error); } catch { /* best-effort */ }
      }
    }
  }
  return zombies;
}

let _zombieTimer = null;

/**
 * Start periodic zombie detection loop.
 */
function startZombieDetector() {
  if (_zombieTimer) return;
  _zombieTimer = setInterval(detectZombies, ZOMBIE_CHECK_INTERVAL);
  _zombieTimer.unref?.();
}

/**
 * Stop the zombie detection loop.
 */
function stopZombieDetector() {
  if (_zombieTimer) { clearInterval(_zombieTimer); _zombieTimer = null; }
}

// ── 幻觉检测 (借鉴 Hermes Agent _verify_created_cards + _scan_prose_for_phantom_ids) ──

const TASK_ID_RE = /\bt[-_][0-9a-f]{4,16}\b/gi;
const FILE_PATH_RE = /(?:(?:\/[\w.-]+){2,}|(?:[\w.-]+\/){2,}[\w.-]+)/g;

/**
 * 检测 worker 输出中的幻觉引用。
 * 1. phantom task ID: 引用了不存在的任务 ID
 * 2. phantom file path: 声称创建/修改了不存在的文件
 *
 * @param {string} output - Worker 输出文本
 * @param {string} workerId
 * @returns {Array<{ type: string, target: string, detail: string }>}
 */
function _detectHallucinations(output, workerId) {
  const hallucinations = [];
  const fs = require('fs');

  // 1. 扫描 phantom task IDs
  const taskIds = [...new Set((output.match(TASK_ID_RE) || []))];
  if (taskIds.length > 0) {
    try {
      const taskBoard = require('./taskBoard');
      for (const tid of taskIds) {
        const task = taskBoard.getTask(tid);
        if (!task) {
          hallucinations.push({
            type: 'phantom_task',
            target: tid,
            detail: `引用了不存在的任务 ${tid}`,
          });
        }
      }
    } catch { /* taskBoard 不可用时跳过 */ }
  }

  // 2. 在 CHANGES 段检测 phantom file paths
  const changesMatch = output.match(/CHANGES:\s*([\s\S]*?)(?=(?:EVIDENCE|RISKS|BLOCKERS):|$)/i);
  if (changesMatch) {
    const changesText = changesMatch[1];
    const paths = [...new Set((changesText.match(FILE_PATH_RE) || []))];
    for (const p of paths) {
      // 跳过明显不是文件路径的
      if (p.length < 5 || p.startsWith('http') || p.includes('://')) continue;
      try {
        const resolved = require('path').resolve(p);
        if (!fs.existsSync(resolved)) {
          hallucinations.push({
            type: 'phantom_file',
            target: p,
            detail: `声称修改了不存在的文件 ${p}`,
          });
        }
      } catch { /* path resolution failed */ }
    }
  }

  return hallucinations;
}

/**
 * D5: Unified agent monitoring dashboard.
 * Returns a structured snapshot of all agents with hierarchy, progress, and resource usage.
 * @returns {{ agents: Array, tree: object, stats: object }}
 */
function getAgentDashboard() {
  const all = [..._workers.values()];
  const now = Date.now();

  // Build parent→children tree
  const tree = {};
  for (const [parentId, childIds] of _childrenOf) {
    tree[parentId] = [...childIds];
  }

  // Per-agent status with computed fields
  const agents = all.map(w => ({
    id: w.id,
    parentId: w.parentId || null,
    role: w.role,
    status: w.status,
    depth: w.depth || 0,
    startedAt: w.startedAt,
    completedAt: w.completedAt || null,
    runningMs: w.completedAt ? (w.completedAt - w.startedAt) : (now - w.startedAt),
    mailboxSize: w.mailbox ? w.mailbox.queue.length : 0,
    hasOutput: !!w.result,
    children: tree[w.id] || [],
  }));

  // Aggregate stats
  const running = agents.filter(a => a.status === 'running').length;
  const completed = agents.filter(a => a.status === 'completed' || a.status === 'done').length;
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'error').length;
  const maxDepth = agents.reduce((m, a) => Math.max(m, a.depth), 0);

  return {
    agents,
    tree,
    stats: {
      total: agents.length,
      running,
      completed,
      failed,
      maxDepth,
      maxConcurrentChildren: WORKER_DEFAULTS.maxConcurrentChildren,
      maxSpawnDepth: WORKER_DEFAULTS.maxSpawnDepth,
    },
  };
}

module.exports = {
  spawnWorker,
  sendMessage,
  acknowledgeMessage,
  getUnackedMessages,
  shutdownWorker,
  getWorkerStatus,
  listWorkers,
  getAgentDashboard,
  cleanup,
  routeMessage,
  detectZombies,
  startZombieDetector,
  stopZombieDetector,
  parseAgentOutput,
  OUTPUT_CONTRACT,
  WORKER_DEFAULTS,
  ZOMBIE_THRESHOLD_MS,
};
