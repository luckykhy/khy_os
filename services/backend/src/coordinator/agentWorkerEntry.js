'use strict';

/**
 * Agent Worker Entry — child process bootstrap for process-isolated agents.
 *
 * This file is the entry point for `child_process.fork()` from ProcessAgent.
 * Lifecycle:
 *   1. Receive INIT message with serialized AgentContext
 *   2. Send READY
 *   3. Receive TASK → execute with AI pipeline → send RESULT/ERROR
 *   4. Handle FOLLOW_UP messages while running
 *   5. Exit on KILL or after task completion
 */
const { MSG, createMessage, parseMessage } = require('./ipcProtocol');

let _agentId = null;
let _context = null;
let _aborted = false;
let _heartbeatTimer = null;
const _followUpQueue = [];

// ── IPC send helper ─────────────────────────────────────────────────────

function send(type, payload = {}, requestId) {
  if (!process.send) return; // not forked
  try {
    process.send(createMessage(type, _agentId || 'unknown', payload, requestId));
  } catch { /* parent gone */ }
}

// ── Message handler ─────────────────────────────────────────────────────

process.on('message', async (raw) => {
  const parsed = parseMessage(raw);
  if (!parsed.valid) return;
  const { msg } = parsed;

  switch (msg.type) {
    case MSG.INIT:
      await handleInit(msg);
      break;
    case MSG.TASK:
      await handleTask(msg);
      break;
    case MSG.FOLLOW_UP:
      handleFollowUp(msg);
      break;
    case MSG.KILL:
      handleKill(msg);
      break;
    case MSG.HEARTBEAT:
      send(MSG.HEARTBEAT, { pong: true }, msg.requestId);
      break;
  }
});

// ── Handlers ────────────────────────────────────────────────────────────

async function handleInit(msg) {
  _agentId = msg.agentId;

  try {
    const { AgentContext } = require('../services/agentContext');
    _context = AgentContext.fromSerializable(msg.payload.context);

    const depth = _context?.depth ?? msg.payload.context?.depth ?? 0;
    const role = _context?.role ?? 'unknown';
    process.stderr.write(`[AgentWorker:${_agentId}] depth=${depth}, role=${role}, pid=${process.pid}\n`);

    send(MSG.READY, { pid: process.pid }, msg.requestId);

    // Start heartbeat — keeps parent watchdog alive during long AI calls
    _heartbeatTimer = setInterval(() => {
      send(MSG.HEARTBEAT, { alive: true });
    }, 15_000);
    _heartbeatTimer.unref?.();
  } catch (err) {
    send(MSG.ERROR, { message: `Init failed: ${err.message}` }, msg.requestId);
    process.exit(1);
  }
}

async function handleTask(msg) {
  const { prompt, chatOpts: extraOpts } = msg.payload;

  try {
    send(MSG.PROGRESS, { phase: 'loading', message: 'Loading AI pipeline...' });

    // Try to load the AI module
    let aiModule;
    try {
      aiModule = require('../cli/ai');
    } catch {
      // Fallback: use gateway directly
      const gateway = require('../services/gateway/aiGateway');
      const result = await gateway.generate(prompt);
      const text = typeof result === 'string'
        ? result
        : (result.text || result.reply || JSON.stringify(result));
      send(MSG.RESULT, { text, tokens: 0, toolCalls: 0 }, msg.requestId);
      reportMetrics();
      process.exit(0);
      return;
    }

    // Build chat options with agent context
    const chatOpts = {
      _isFollowUp: true,
      effort: _context?.config?.effort || 'medium',
      ...extraOpts,
    };

    if (_context) {
      chatOpts._agentContext = _context;

      // Apply tool profile from context
      if (_context.toolFilter) {
        try {
          const toolRegistry = require('../tools');
          // 自审 #4:按用户 prompt 信号预激活延迟工具簇(加法式、幂等;门控关 → 空 → 字节回退)。
          try {
            const { selectToolsToActivate } = require('../services/toolClusterActivation');
            for (const name of selectToolsToActivate(prompt)) {
              toolRegistry.ensureToolForContext(name, _context);
            }
          } catch { /* 预激活最佳努力,失败不影响主流程 */ }
          chatOpts.toolDefinitions = toolRegistry.getDefinitionsForContext(_context);
        } catch { /* fallback: no filtering */ }
      }
    }

    send(MSG.PROGRESS, { phase: 'running', message: 'Executing task...' });

    const result = await aiModule.chat(prompt, chatOpts);

    send(MSG.RESULT, {
      text: result.reply || result.text || '',
      tokens: result.tokenUsage?.totalTokens || 0,
      toolCalls: (result.commands || []).length,
    }, msg.requestId);

    reportMetrics();
    process.exit(0);

  } catch (err) {
    if (_aborted) {
      send(MSG.ERROR, { message: 'Task aborted', code: 'ABORTED' }, msg.requestId);
    } else {
      send(MSG.ERROR, { message: err.message, stack: err.stack }, msg.requestId);
    }
    reportMetrics();
    process.exit(1);
  }
}

function handleFollowUp(msg) {
  // ACK immediately to relieve parent backpressure
  send(MSG.ACK, { seq: msg.payload.seq }, msg.requestId);
  _followUpQueue.push(msg.payload);
}

function handleKill(msg) {
  _aborted = true;
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  send(MSG.METRICS, buildMetrics(), msg.requestId);
  // Give pending IPC a moment to flush, then exit
  setTimeout(() => process.exit(0), 100);
}

// ── Metrics ─────────────────────────────────────────────────────────────

function buildMetrics() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    agentId: _agentId,
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    heapTotalMB: Math.round(mem.heapTotal / (1024 * 1024)),
    rssMB: Math.round(mem.rss / (1024 * 1024)),
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

function reportMetrics() {
  send(MSG.METRICS, buildMetrics());
}

// ── Safety ──────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  send(MSG.ERROR, { message: `Uncaught: ${err.message}`, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  send(MSG.ERROR, { message: `Unhandled rejection: ${msg}` });
  process.exit(1);
});

// Signal handling. Windows does not deliver SIGTERM to Node processes, so the
// same teardown is also bound to SIGINT (the portable interrupt signal) to
// guarantee worker cleanup on both platforms.
const _onTerminate = () => {
  _aborted = true;
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  reportMetrics();
  setTimeout(() => process.exit(0), 100);
};
process.on('SIGTERM', _onTerminate);
process.on('SIGINT', _onTerminate);
