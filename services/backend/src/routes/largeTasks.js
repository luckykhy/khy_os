'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attach: attachSseKeepalive } = require('../services/sseKeepalive');
const runtime = require('../tasks/largeTaskRuntimeStore');
const taskControlService = require('../services/taskControlService');
const { createLargeTaskOrchestrator } = require('../tasks/largeTaskOrchestrator');
const { createLargeTaskWorkerService } = require('../tasks/largeTaskWorkerService');
const { getLegacyDataHome } = require('../utils/dataHome');
const envInt = require('../utils/envInt');
const { remoteStateSyncService } = require('../services/remote');
const {
  buildRunOptions: _buildRunOptions,
  buildTraceId: _buildTraceId,
  buildWorkerStartOptions: _buildWorkerStartOptions,
  headerAsString: _headerAsString,
  normalizeEventRecord: _normalizeEventRecord,
  normalizePayload: _normalizePayload,
  normalizeTaskAudit: _normalizeTaskAudit,
  normalizeSteps: _normalizeSteps,
  parseAfterEventId: _parseAfterEventId,
  parseBoolean: _parseBoolean,
  parseIntInRange: _parseIntInRange,
  trimmedString: _trimmedString,
} = require('./largeTasks/routeHelpers');
const {
  RETRY_POLICY_APPROVAL_DEFAULT_LIMIT,
  RETRY_POLICY_AUDIT_DEFAULT_LIMIT,
  evaluateRetryPolicyGuardrails: _evaluateRetryPolicyGuardrails,
  evaluateRetryPolicyRisk: _evaluateRetryPolicyRisk,
  validateRetryPolicyApprovalRetentionPatch: _validateRetryPolicyApprovalRetentionPatch,
  validateRetryPolicyPatch: _validateRetryPolicyPatch,
} = require('./largeTasks/retryPolicy');

const ACTIVE_TASK_STATUSES = new Set(['claimed', 'running', 'retry_wait', 'pausing', 'paused', 'cancelling']);
const KEY_OPERATION_STATES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'dead_letter']);
const TODO_STATE_FILE_NAME = 'todo_state.json';
const DEFAULT_HANDOVER_WINDOW_MINUTES = 60;

const router = express.Router();
const orchestrator = createLargeTaskOrchestrator({
  runtime,
  workerId: 'large-task-route-worker',
});
const workerService = createLargeTaskWorkerService({
  runtime,
  orchestrator,
  workerId: 'large-task-daemon-worker',
  taskHandler: _runBuiltinTaskHandler,
});

function _taskControlFail(res, traceId, operationName, result = {}) {
  const status = Number.isFinite(Number(result.status)) ? Number(result.status) : 500;
  const data = {
    trace_id: traceId,
    code: result.code || 'task_control_failed',
  };
  if (result.task) data.task = result.task;
  return res.status(status).json({
    success: false,
    message: `${operationName}失败: ${result.message || '未知错误'}`,
    data,
  });
}

function _candidateTodoStateFiles() {
  // 与兼容 todoWrite 写侧(services/toolCalling.js)经 SSOT(todoStateStorePaths)收敛,
  // 消除历史 tmp 解析漂移:写侧 getTmpDir(TEMP||TMP||os.tmpdir) vs 读侧 os.tmpdir。
  // 门控开 → 读侧改用 getTmpDir(与写侧一致,修 Windows 读不回);门控关 → os.tmpdir,
  // 与今日**字节一致**回退。
  try {
    const store = require('../services/todoStateStorePaths');
    if (store.todoStateUnifyEnabled()) {
      let tmp = os.tmpdir();
      try { tmp = require('../tools/platformUtils').getTmpDir() || tmp; } catch { /* 回退 os.tmpdir */ }
      return store.todoStateCandidateFiles({
        homedir: os.homedir(), cwd: process.cwd(), tmpdir: tmp,
      }).map((c) => ({ source: c.source, file_path: c.file_path }));
    }
  } catch { /* fail-soft:落回今日内联清单 */ }
  return [
    {
      source: 'legacy_data_home',
      file_path: path.join(getLegacyDataHome(), TODO_STATE_FILE_NAME),
    },
    {
      source: 'workspace',
      file_path: path.join(process.cwd(), '.khyquant', TODO_STATE_FILE_NAME),
    },
    {
      source: 'temp_runtime',
      file_path: path.join(os.tmpdir(), 'khyquant', TODO_STATE_FILE_NAME),
    },
  ];
}

function _normalizeTodoStatus(status, done) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  if (normalized === 'pending' || normalized === 'todo') return 'pending';
  if (normalized === 'in_progress' || normalized === 'doing') return 'in_progress';
  if (done === true) return 'completed';
  return 'pending';
}

// Short-lived cache for the todo-state file read ([MGMT-RPT-020] REQ-2026-012).
// The dashboard polls this on every request; the underlying state files change
// at human/agent speed, so a small TTL removes the per-request sync readFileSync
// + JSON.parse without making the snapshot meaningfully stale.
const _TODO_SNAPSHOT_TTL_MS = envInt('KHY_LARGE_TASK_TODO_TTL_MS', 2000, { min: 0 });
let _todoSnapshotCache = null; // { at, payload }

function _loadTodoSnapshotPayload() {
  const now = Date.now();
  if (_todoSnapshotCache && (now - _todoSnapshotCache.at) < _TODO_SNAPSHOT_TTL_MS) {
    return _todoSnapshotCache.payload;
  }

  let payload = { source: null, updated_at: null, normalized: [] };
  for (const candidate of _candidateTodoStateFiles()) {
    try {
      if (!fs.existsSync(candidate.file_path)) continue;
      const raw = fs.readFileSync(candidate.file_path, 'utf-8');
      const parsed = JSON.parse(raw);
      const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
      const normalized = todos
        .map((todo, index) => {
          if (typeof todo === 'string') {
            return {
              id: `todo-${index + 1}`,
              content: todo,
              status: 'pending',
              priority: 'normal',
            };
          }
          if (!todo || typeof todo !== 'object') return null;
          return {
            id: String(todo.id || `todo-${index + 1}`),
            content: String(todo.content || todo.text || '').trim(),
            status: _normalizeTodoStatus(todo.status, todo.done),
            priority: String(todo.priority || 'normal'),
          };
        })
        .filter((todo) => todo && todo.content);

      payload = {
        source: candidate.source,
        updated_at: parsed?.updatedAt || parsed?.updated_at || null,
        normalized,
      };
      break;
    } catch {
      // Continue to next candidate source.
    }
  }

  _todoSnapshotCache = { at: now, payload };
  return payload;
}

function _readPendingTodos(limit = 10) {
  const safeLimit = _parseIntInRange(limit, 10, 1, 100);
  const { source, updated_at, normalized } = _loadTodoSnapshotPayload();

  const pendingAll = normalized.filter((todo) => todo.status !== 'completed');
  return {
    source,
    updated_at,
    total_todo_count: normalized.length,
    pending_total: pendingAll.length,
    pending_todos: pendingAll.slice(0, safeLimit),
  };
}

function _isKeyOperationEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (KEY_OPERATION_STATES.has(event.state_to)) return true;
  return event.state_from === 'claimed' && event.state_to === 'running';
}

function _buildRecentOperations(options = {}) {
  const windowMinutes = _parseIntInRange(
    options.window_minutes,
    DEFAULT_HANDOVER_WINDOW_MINUTES,
    1,
    24 * 60
  );
  const limit = _parseIntInRange(options.limit, 3, 1, 30);
  const afterAt = new Date(Date.now() - (windowMinutes * 60 * 1000)).toISOString();
  const events = runtime.listTaskEvents({
    after_at: afterAt,
    limit: 5_000,
  });
  const taskCache = new Map();

  return events
    .filter(_isKeyOperationEvent)
    .sort((a, b) => Number(b.event_id || 0) - Number(a.event_id || 0))
    .slice(0, limit)
    .map((event) => {
      let task = taskCache.get(event.task_id);
      if (!task && event.task_id) {
        task = runtime.getTask(event.task_id);
        taskCache.set(event.task_id, task);
      }
      return {
        event_id: event.event_id,
        at: event.at,
        task_id: event.task_id,
        task_type: task?.type || null,
        trace_id: event.trace_id || task?.trace_id || null,
        state_from: event.state_from,
        state_to: event.state_to,
        attempt_no: event.attempt_no,
        latency_ms: event.latency_ms,
      };
    });
}

function _buildRecentRetentionChanges(options = {}) {
  const windowMinutes = _parseIntInRange(
    options.window_minutes,
    DEFAULT_HANDOVER_WINDOW_MINUTES,
    1,
    24 * 60
  );
  const limit = _parseIntInRange(options.limit, 3, 1, 30);
  const afterMs = Date.now() - (windowMinutes * 60 * 1000);

  return runtime
    .listRetryPolicyApprovalRetentionEvents({ limit: 5_000 })
    .filter((event) => {
      const atMs = Date.parse(String(event.at || ''));
      return Number.isFinite(atMs) && atMs > afterMs;
    })
    .sort((a, b) => Number(b.retention_event_id || 0) - Number(a.retention_event_id || 0))
    .slice(0, limit)
    .map((event) => ({
      retention_event_id: event.retention_event_id,
      at: event.at,
      trace_id: event.trace_id || null,
      actor: event.actor || null,
      source: event.source || null,
      reason: event.reason || null,
      changed: event.changed === true,
    }));
}

function _buildActiveTasks(limit = 20) {
  const safeLimit = _parseIntInRange(limit, 20, 1, 200);
  return runtime
    .listTasks()
    .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, safeLimit)
    .map((task) => ({
      task_id: task.id,
      type: task.type,
      status: task.status,
      progress_pct: task.progress_pct,
      attempt_count: task.attempt_count,
      max_attempts: task.max_attempts,
      next_run_at: task.next_run_at || null,
      updated_at: task.updated_at,
      trace_id: task.trace_id || null,
    }));
}

function _buildRemoteHandoverSnapshot(options = {}) {
  const approvalLimit = _parseIntInRange(options.approval_limit, 10, 1, 100);
  const sessionLimit = _parseIntInRange(options.session_limit, 10, 1, 100);
  try {
    const remoteSnapshot = remoteStateSyncService.getSnapshot();
    const pendingApprovals = Array.isArray(remoteSnapshot.pending_remote_approvals)
      ? remoteSnapshot.pending_remote_approvals
      : [];
    const sessions = Array.isArray(remoteSnapshot.active_remote_sessions)
      ? remoteSnapshot.active_remote_sessions
      : [];

    return {
      active_remote_sessions: sessions
        .slice(0, sessionLimit)
        .map((session) => ({
          connection_id: session.connectionId || null,
          host_alias: session.hostAlias || null,
          status: session.status || null,
          purpose: session.purpose || null,
          connected_at: session.connectedAt || null,
          last_activity_at: session.lastActivityAt || null,
          remote_workspace: session.remoteWorkspace || null,
        })),
      pending_remote_approvals: pendingApprovals
        .slice(0, approvalLimit)
        .map((ticket) => ({
          ticket_id: ticket.ticket_id || null,
          trace_id: ticket.trace_id || null,
          connection_id: ticket.connection_id || null,
          host_alias: ticket.host_alias || null,
          status: ticket.status || 'pending',
          risk_level: ticket.risk_level || null,
          reason: ticket.reason || null,
          created_at: ticket.created_at || null,
          expires_at: ticket.expires_at || null,
          command_count: Array.isArray(ticket.commands) ? ticket.commands.length : 0,
        })),
      summary: {
        active_session_count: Number(remoteSnapshot.summary?.active_session_count || 0),
        pending_approval_count: Number(remoteSnapshot.summary?.pending_approval_count || 0),
      },
    };
  } catch {
    return {
      active_remote_sessions: [],
      pending_remote_approvals: [],
      summary: {
        active_session_count: 0,
        pending_approval_count: 0,
      },
    };
  }
}

function _compactText(value, maxLen = 100) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function _statusLight({ recentOperations, activeTasks, remoteSnapshot }) {
  const riskyStates = new Set(['failed', 'dead_letter', 'cancelled']);
  const hasFailure = recentOperations.some((item) => riskyStates.has(item.state_to));
  if (hasFailure) return '🔴';
  if (activeTasks.length > 0 || Number(remoteSnapshot.summary?.pending_approval_count || 0) > 0) return '🟡';
  return '🟢';
}

function _buildMobileSnapshot({
  windowMinutes,
  recentOperations,
  recentRetentionChanges,
  activeTasks,
  todoSnapshot,
  remoteSnapshot,
  metrics,
}) {
  const light = _statusLight({
    recentOperations,
    activeTasks,
    remoteSnapshot,
  });
  const retentionChanges = Array.isArray(recentRetentionChanges) ? recentRetentionChanges : [];

  const recentTop = recentOperations.slice(0, 3).map((item) => ({
    task_id: item.task_id,
    state: item.state_to,
    at: item.at,
  }));
  const taskTop = activeTasks.slice(0, 3).map((task) => ({
    task_id: task.task_id,
    status: task.status,
    progress_pct: task.progress_pct,
  }));
  const approvalTop = (remoteSnapshot.pending_remote_approvals || []).slice(0, 3).map((ticket) => ({
    ticket_id: ticket.ticket_id,
    risk_level: ticket.risk_level,
    host_alias: ticket.host_alias,
  }));
  const todoTop = (todoSnapshot.pending_todos || []).slice(0, 3).map((todo) => ({
    id: todo.id,
    content: _compactText(todo.content, 72),
    status: todo.status,
  }));
  const retentionTop = retentionChanges.slice(0, 3).map((event) => ({
    retention_event_id: event.retention_event_id,
    actor: event.actor,
    changed: event.changed,
    at: event.at,
  }));

  return {
    mode: 'mobile_compact',
    generated_at: new Date().toISOString(),
    window_minutes: windowMinutes,
    cards: [
      {
        card_id: 'ops',
        light,
        title: 'Recent Operations',
        metric: `${recentOperations.length}`,
        subtitle: `Window ${windowMinutes}m`,
      },
      {
        card_id: 'tasks',
        light: activeTasks.length > 0 ? '🟡' : '🟢',
        title: 'Active Large Tasks',
        metric: `${activeTasks.length}`,
        subtitle: `Queue depth ${Number(metrics.queue_depth || 0)}`,
      },
      {
        card_id: 'approvals',
        light: Number(remoteSnapshot.summary?.pending_approval_count || 0) > 0 ? '🟡' : '🟢',
        title: 'Pending Approvals',
        metric: `${Number(remoteSnapshot.summary?.pending_approval_count || 0)}`,
        subtitle: `Remote sessions ${Number(remoteSnapshot.summary?.active_session_count || 0)}`,
      },
      {
        card_id: 'todos',
        light: Number(todoSnapshot.pending_total || 0) > 0 ? '🟡' : '🟢',
        title: 'Pending Todos',
        metric: `${Number(todoSnapshot.pending_total || 0)}`,
        subtitle: todoSnapshot.source ? `Source ${todoSnapshot.source}` : 'Source unavailable',
      },
      {
        card_id: 'retention_policy',
        light: retentionChanges.length > 0 ? '🟡' : '🟢',
        title: 'Retention Policy Changes',
        metric: `${retentionChanges.length}`,
        subtitle: `Window ${windowMinutes}m`,
      },
    ],
    top: {
      recent_operations: recentTop,
      active_large_tasks: taskTop,
      pending_remote_approvals: approvalTop,
      pending_todos: todoTop,
      recent_retention_policy_changes: retentionTop,
    },
    summary: {
      queue_depth: Number(metrics.queue_depth || 0),
      recent_operation_count: recentOperations.length,
      retention_policy_change_count: retentionChanges.length,
      active_large_task_count: activeTasks.length,
      pending_remote_approval_count: Number(remoteSnapshot.summary?.pending_approval_count || 0),
      active_remote_session_count: Number(remoteSnapshot.summary?.active_session_count || 0),
      pending_todo_count: Number(todoSnapshot.pending_total || 0),
    },
  };
}

async function _runBuiltinTaskHandler(ctx) {
  const payload = _normalizePayload(ctx.payload);
  const steps = _normalizeSteps(payload.steps);
  const plan = await ctx.plan(async () => ({
    task_id: ctx.taskId,
    trace_id: ctx.traceId,
    step_total: steps.length,
    dry_run: true,
    checkpoint_step: ctx.checkpoint?.step_no || null,
  }));

  const state = {
    ...(payload.state && typeof payload.state === 'object' ? payload.state : {}),
  };
  const sideEffects = [];
  const checkpointEvery = _parseIntInRange(payload.checkpoint_every, 0, 0, 10_000);

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    ctx.ensureNotCancelled();

    if (step.action === 'set') {
      if (step.key) {
        state[step.key] = step.value;
      }
    } else if (step.action === 'progress') {
      if (step.progress_pct !== undefined) {
        ctx.reportProgress(step.progress_pct);
      }
    } else if (step.action === 'sleep') {
      const sleepMs = _parseIntInRange(step.sleep_ms, 0, 0, 5_000);
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    } else if (step.action === 'checkpoint') {
      const progress = step.progress_pct === undefined ? Math.round(((i + 1) / Math.max(1, steps.length)) * 100) : step.progress_pct;
      ctx.saveCheckpoint({
        step_no: i + 1,
        progress_pct: progress,
        schema_version: _parseIntInRange(step.schema_version, 1, 1, 10_000),
        state_blob_json: step.state_blob_json && typeof step.state_blob_json === 'object'
          ? step.state_blob_json
          : { state, step_index: i },
      });
    } else if (step.action === 'side_effect') {
      const commitResult = await ctx.commit({
        scope: step.scope || payload.side_effect_scope || 'large_task_builtin',
        idempotency_key: step.idempotency_key || payload.side_effect_idempotency_key || '',
        intent_hash: step.intent_hash || payload.side_effect_intent_hash || null,
        executor: async () => {
          return {
            step_index: i,
            effect_result: step.effect_result === undefined ? { ok: true } : step.effect_result,
          };
        },
      });
      sideEffects.push({
        step_index: i,
        code: commitResult.code || null,
        replayed: Boolean(commitResult.replayed),
        ok: Boolean(commitResult.ok),
        result: commitResult.result || null,
      });
      if (ctx.commitEnabled && !ctx.dryRun && !commitResult.ok) {
        throw new Error(`builtin side_effect step ${i} failed: ${commitResult.code || 'side_effect_failed'}`);
      }
    } else if (step.action === 'fail') {
      throw new Error(step.fail_message || `builtin step ${i} failed`);
    }

    if (checkpointEvery > 0 && (i + 1) % checkpointEvery === 0) {
      ctx.saveCheckpoint({
        step_no: i + 1,
        progress_pct: Math.round(((i + 1) / Math.max(1, steps.length)) * 100),
        schema_version: 1,
        state_blob_json: { state, step_index: i },
      });
    }

    if (steps.length > 0) {
      ctx.reportProgress(Math.round(((i + 1) / steps.length) * 100));
    }
    ctx.heartbeat();
  }

  return {
    plan,
    dry_run: ctx.dryRun,
    commit_enabled: ctx.commitEnabled,
    step_total: steps.length,
    state,
    side_effects: sideEffects,
    resumed_from_checkpoint: Boolean(ctx.checkpoint),
    checkpoint_step: ctx.checkpoint?.step_no || null,
  };
}

router.post('/', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const type = _trimmedString(req.body?.type) || 'large_task';
    const payload = _normalizePayload(req.body?.payload_json);
    const priority = req.body?.priority;
    const maxAttempts = req.body?.max_attempts;
    const idempotencyKey = _trimmedString(req.body?.idempotency_key) || null;
    const explicitTraceId = _trimmedString(req.body?.trace_id) || traceId;

    const task = orchestrator.createTask({
      type,
      payload_json: payload,
      priority,
      max_attempts: maxAttempts,
      idempotency_key: idempotencyKey,
      trace_id: explicitTraceId,
    });

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        task,
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: `创建大型任务失败: ${error.message}`,
      data: {
        trace_id: traceId,
      },
    });
  }
});

router.get('/', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const status = _trimmedString(req.query?.status);
    const type = _trimmedString(req.query?.type);
    const source = _trimmedString(req.query?.source);
    const limit = _parseIntInRange(req.query?.limit, 50, 1, 500);

    const tasks = runtime.listTasks({
      status: status || undefined,
      type: type || undefined,
      source: source || undefined,
    });

    const sliced = tasks.slice(Math.max(0, tasks.length - limit));

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total: tasks.length,
        tasks: sliced,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务列表失败: ${error.message}`,
      data: {
        trace_id: traceId,
      },
    });
  }
});

router.get('/metrics', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const metrics = orchestrator.getMetrics();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        metrics,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务指标失败: ${error.message}`,
      data: {
        trace_id: traceId,
      },
    });
  }
});

router.get('/events', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.query?.task_id);
    const traceFilter = _trimmedString(req.query?.trace_id);
    const stateTo = _trimmedString(req.query?.state_to);
    const stateFrom = _trimmedString(req.query?.state_from);
    const afterAt = _trimmedString(req.query?.after_at);
    const afterId = _parseAfterEventId(req);
    const limit = _parseIntInRange(req.query?.limit, 100, 1, 5000);

    const events = runtime.listTaskEvents({
      task_id: taskId || undefined,
      trace_id: traceFilter || undefined,
      state_to: stateTo || undefined,
      state_from: stateFrom || undefined,
      after_at: afterAt || undefined,
      after_id: afterId,
      limit,
    }).map(_normalizeEventRecord);

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total: events.length,
        events,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务事件失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/worker/status', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const worker = workerService.status();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        worker,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务工作器状态失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/worker/start', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const startOptions = _buildWorkerStartOptions(req.body || {});
    const result = await workerService.start(startOptions);
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        started: result.started,
        worker: result.status,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `启动大型任务工作器失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/worker/stop', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const result = await workerService.stop();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        stopped: result.stopped,
        worker: result.status,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `停止大型任务工作器失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/:taskId/cancel', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    const reason = _trimmedString(req.body?.reason) || 'cancelled by operator';
    const result = taskControlService.controlTask(taskId, 'cancel', { reason });
    if (!result.ok) {
      return _taskControlFail(res, traceId, '取消大型任务', result);
    }
    const data = {
      trace_id: traceId,
      task: result.task,
    };
    if (result.already_terminal) data.already_terminal = true;
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `取消大型任务失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/:taskId/pause', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    const result = taskControlService.controlTask(taskId, 'pause');
    if (!result.ok) {
      return _taskControlFail(res, traceId, '暂停大型任务', result);
    }
    const data = {
      trace_id: traceId,
      task: result.task,
    };
    if (result.already_paused) data.already_paused = true;
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `暂停大型任务失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/:taskId/resume', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    const result = taskControlService.controlTask(taskId, 'resume');
    if (!result.ok) {
      return _taskControlFail(res, traceId, '恢复大型任务', result);
    }
    const data = {
      trace_id: traceId,
      task: result.task,
    };
    if (result.already_running) data.already_running = true;
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `恢复大型任务失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/handover/snapshot', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const operationLimit = _parseIntInRange(req.query?.operation_limit, 3, 1, 30);
    const runningLimit = _parseIntInRange(req.query?.running_limit, 20, 1, 200);
    const todoLimit = _parseIntInRange(req.query?.todo_limit, 10, 1, 100);
    const retentionLimit = _parseIntInRange(req.query?.retention_limit, 3, 1, 30);
    const windowMinutes = _parseIntInRange(
      req.query?.window_minutes,
      DEFAULT_HANDOVER_WINDOW_MINUTES,
      1,
      24 * 60
    );
    const remoteApprovalLimit = _parseIntInRange(req.query?.approval_limit, 10, 1, 100);
    const remoteSessionLimit = _parseIntInRange(req.query?.session_limit, 10, 1, 100);
    const format = _trimmedString(req.query?.format).toLowerCase();
    const mobileCompact = _parseBoolean(req.query?.mobile, false)
      || format === 'mobile'
      || format === 'compact';

    const metrics = orchestrator.getMetrics();
    const recentOperations = _buildRecentOperations({
      window_minutes: windowMinutes,
      limit: operationLimit,
    });
    const recentRetentionChanges = _buildRecentRetentionChanges({
      window_minutes: windowMinutes,
      limit: retentionLimit,
    });
    const activeTasks = _buildActiveTasks(runningLimit);
    const todoSnapshot = _readPendingTodos(todoLimit);
    const remoteSnapshot = _buildRemoteHandoverSnapshot({
      approval_limit: remoteApprovalLimit,
      session_limit: remoteSessionLimit,
    });

    if (mobileCompact) {
      return res.json({
        success: true,
        data: {
          trace_id: traceId,
          snapshot: _buildMobileSnapshot({
            windowMinutes,
            recentOperations,
            recentRetentionChanges,
            activeTasks,
            todoSnapshot,
            remoteSnapshot,
            metrics,
          }),
        },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        snapshot: {
          generated_at: new Date().toISOString(),
          window_minutes: windowMinutes,
          recent_operations: recentOperations,
          recent_retry_policy_approval_retention_changes: recentRetentionChanges,
          active_large_tasks: activeTasks,
          pending_todos: todoSnapshot.pending_todos,
          pending_todo_meta: {
            source: todoSnapshot.source,
            updated_at: todoSnapshot.updated_at,
            total_todo_count: todoSnapshot.total_todo_count,
            pending_total: todoSnapshot.pending_total,
          },
          active_remote_sessions: remoteSnapshot.active_remote_sessions,
          pending_remote_approvals: remoteSnapshot.pending_remote_approvals,
          summary: {
            recent_operation_count: recentOperations.length,
            retention_policy_change_count: recentRetentionChanges.length,
            active_large_task_count: activeTasks.length,
            pending_todo_count: todoSnapshot.pending_total,
            pending_remote_approval_count: remoteSnapshot.summary.pending_approval_count,
            active_remote_session_count: remoteSnapshot.summary.active_session_count,
            queue_depth: Number(metrics.queue_depth || 0),
          },
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取跨设备交接快照失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/events/stream', async (req, res) => {
  const traceId = _buildTraceId(req);
  const afterId = _parseAfterEventId(req);
  const watch = _parseBoolean(req.query?.watch, true);
  const limit = _parseIntInRange(req.query?.limit, 100, 1, 5000);
  const taskId = _trimmedString(req.query?.task_id);
  const traceFilter = _trimmedString(req.query?.trace_id);
  const stateTo = _trimmedString(req.query?.state_to);
  const stateFrom = _trimmedString(req.query?.state_from);
  const afterAt = _trimmedString(req.query?.after_at);

  const sse = attachSseKeepalive(res);
  let unsubscribed = false;
  let unsubscribe = null;

  const teardown = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ }
    sse.stop();
  };

  req.on('close', teardown);
  req.on('error', teardown);
  res.on('close', teardown);
  res.on('error', teardown);

  const shouldPass = (event) => {
    if (!event || typeof event !== 'object') return false;
    if (taskId && event.task_id !== taskId) return false;
    if (traceFilter && event.trace_id !== traceFilter) return false;
    if (stateTo && event.state_to !== stateTo) return false;
    if (stateFrom && event.state_from !== stateFrom) return false;
    if (afterAt) {
      const eventMs = Date.parse(String(event.at));
      const afterMs = Date.parse(afterAt);
      if (Number.isFinite(afterMs) && (!Number.isFinite(eventMs) || eventMs <= afterMs)) {
        return false;
      }
    }
    return true;
  };

  try {
    const replayEvents = runtime.listTaskEvents({
      task_id: taskId || undefined,
      trace_id: traceFilter || undefined,
      state_to: stateTo || undefined,
      state_from: stateFrom || undefined,
      after_at: afterAt || undefined,
      after_id: afterId,
      limit,
    }).map(_normalizeEventRecord);

    for (const event of replayEvents) {
      const eventId = Number.parseInt(event.event_id, 10);
      sse.sendWithId('task_event', event, Number.isFinite(eventId) ? eventId : null);
    }

    sse.send('ready', {
      trace_id: traceId,
      replay_count: replayEvents.length,
      after_id: afterId,
      watch,
    });

    if (!watch) {
      sse.send('done', {
        trace_id: traceId,
        status: 'completed',
        replay_only: true,
      });
      teardown();
      return res.end();
    }

    unsubscribe = runtime.subscribeTaskEvents((event) => {
      if (!shouldPass(event)) return;
      const normalizedEvent = _normalizeEventRecord(event);
      const eventId = Number.parseInt(normalizedEvent.event_id, 10);
      sse.sendWithId('task_event', normalizedEvent, Number.isFinite(eventId) ? eventId : null);
    });
    return undefined;
  } catch (error) {
    sse.send('error', {
      trace_id: traceId,
      message: `订阅大型任务事件流失败: ${error.message}`,
    });
    sse.send('done', {
      trace_id: traceId,
      status: 'failed',
    });
    teardown();
    return res.end();
  }
});

router.get('/retry-policy/approvals/stream', async (req, res) => {
  const traceId = _buildTraceId(req);
  const afterId = _parseAfterEventId(req);
  const limit = _parseIntInRange(req.query?.limit, 200, 1, 5_000);
  const watch = _parseBoolean(req.query?.watch, true);
  const ticketId = _trimmedString(req.query?.ticket_id);
  const traceFilter = _trimmedString(req.query?.trace_id);
  const eventType = _trimmedString(req.query?.event_type);

  const sse = attachSseKeepalive(res);
  let unsubscribed = false;
  let unsubscribe = null;

  const teardown = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ }
    sse.stop();
  };

  req.on('close', teardown);
  req.on('error', teardown);
  res.on('close', teardown);
  res.on('error', teardown);

  const shouldPass = (event) => {
    if (!event || typeof event !== 'object') return false;
    if (ticketId && event.ticket_id !== ticketId) return false;
    if (traceFilter && event.trace_id !== traceFilter) return false;
    if (eventType && event.event_type !== eventType) return false;
    return true;
  };

  try {
    const replayEvents = runtime.listRetryPolicyApprovalEvents({
      after_id: afterId,
      limit,
      ticket_id: ticketId || undefined,
      trace_id: traceFilter || undefined,
      event_type: eventType || undefined,
    });

    for (const event of replayEvents) {
      const eventId = Number.parseInt(event.approval_event_id, 10);
      sse.sendWithId('retry_policy_approval_event', event, Number.isFinite(eventId) ? eventId : null);
    }

    sse.send('ready', {
      trace_id: traceId,
      replay_count: replayEvents.length,
      after_id: afterId,
      watch,
    });

    if (!watch) {
      sse.send('done', {
        trace_id: traceId,
        status: 'completed',
        replay_only: true,
      });
      teardown();
      return res.end();
    }

    unsubscribe = runtime.subscribeRetryPolicyApprovalEvents((event) => {
      if (!shouldPass(event)) return;
      const eventId = Number.parseInt(event.approval_event_id, 10);
      sse.sendWithId('retry_policy_approval_event', event, Number.isFinite(eventId) ? eventId : null);
    });
    return undefined;
  } catch (error) {
    sse.send('error', {
      trace_id: traceId,
      message: `订阅重试策略审批流失败: ${error.message}`,
    });
    sse.send('done', {
      trace_id: traceId,
      status: 'failed',
    });
    teardown();
    return res.end();
  }
});

router.get('/circuit/commit', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const scope = _trimmedString(req.query?.scope) || 'default';
    const circuit = orchestrator.getCommitCircuitStatus(scope);
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        scope,
        circuit,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询提交断路器状态失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const includeAudit = _parseBoolean(req.query?.include_audit, false);
    const limit = _parseIntInRange(req.query?.limit, RETRY_POLICY_AUDIT_DEFAULT_LIMIT, 1, 5_000);
    const afterId = _parseIntInRange(req.query?.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
    const retryPolicy = runtime.getRetryPolicy();
    const events = includeAudit
      ? runtime.listRetryPolicyEvents({
        limit,
        after_id: afterId,
      })
      : [];

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        retry_policy: retryPolicy,
        audit: {
          included: includeAudit,
          total: events.length,
          events,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy/events', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const limit = _parseIntInRange(req.query?.limit, RETRY_POLICY_AUDIT_DEFAULT_LIMIT, 1, 5_000);
    const afterId = _parseIntInRange(req.query?.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
    const events = runtime.listRetryPolicyEvents({
      limit,
      after_id: afterId,
      trace_id: _trimmedString(req.query?.trace_id) || undefined,
    });
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total: events.length,
        events,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略审计事件失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy/approvals/pending', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const limit = _parseIntInRange(req.query?.limit, RETRY_POLICY_APPROVAL_DEFAULT_LIMIT, 1, 5_000);
    const approvals = runtime.listRetryPolicyApprovalTickets({
      status: 'pending',
      limit,
    });
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total_pending: approvals.length,
        approvals,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略审批队列失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy/approvals/retention', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const retention = runtime.getRetryPolicyApprovalRetention();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        retry_policy_approval_retention: retention,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略审批保留策略失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/retry-policy/approvals/retention', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const retentionInput = req.body?.retry_policy_approval_retention
      || req.body?.retryPolicyApprovalRetention
      || req.body?.retention;
    const { errors, patch } = _validateRetryPolicyApprovalRetentionPatch(retentionInput);
    if (errors.length > 0 || !patch) {
      return res.status(400).json({
        success: false,
        message: `更新重试策略审批保留策略失败: ${errors.join(' ')}`,
        data: { trace_id: traceId },
      });
    }

    const actor = _trimmedString(req.body?.actor)
      || _headerAsString(req.headers['x-operator-id'])
      || _headerAsString(req.headers['x-actor-id'])
      || 'unknown_operator';
    const reason = _trimmedString(req.body?.reason).slice(0, 300) || null;
    const updated = runtime.updateRetryPolicyApprovalRetention(patch, {
      trace_id: traceId,
      actor,
      source: 'route:large_tasks',
      reason,
    });
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        changed: updated.changed,
        retry_policy_approval_retention: updated.retention,
        audit_event: updated.event,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `更新重试策略审批保留策略失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy/approvals/retention/events', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const limit = _parseIntInRange(req.query?.limit, RETRY_POLICY_AUDIT_DEFAULT_LIMIT, 1, 5_000);
    const afterId = _parseAfterEventId(req);
    const events = runtime.listRetryPolicyApprovalRetentionEvents({
      limit,
      after_id: afterId,
      trace_id: _trimmedString(req.query?.trace_id) || undefined,
      actor: _trimmedString(req.query?.actor) || undefined,
    });
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        after_id: afterId,
        total: events.length,
        events,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略审批保留策略审计事件失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/retry-policy/approvals/retention/stream', async (req, res) => {
  const traceId = _buildTraceId(req);
  const afterId = _parseAfterEventId(req);
  const limit = _parseIntInRange(req.query?.limit, 200, 1, 5_000);
  const watch = _parseBoolean(req.query?.watch, true);
  const traceFilter = _trimmedString(req.query?.trace_id);
  const actorFilter = _trimmedString(req.query?.actor);

  const sse = attachSseKeepalive(res);
  let unsubscribed = false;
  let unsubscribe = null;

  const teardown = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ }
    sse.stop();
  };

  req.on('close', teardown);
  req.on('error', teardown);
  res.on('close', teardown);
  res.on('error', teardown);

  const shouldPass = (event) => {
    if (!event || typeof event !== 'object') return false;
    if (traceFilter && event.trace_id !== traceFilter) return false;
    if (actorFilter && event.actor !== actorFilter) return false;
    return true;
  };

  try {
    const replayEvents = runtime.listRetryPolicyApprovalRetentionEvents({
      after_id: afterId,
      limit,
      trace_id: traceFilter || undefined,
      actor: actorFilter || undefined,
    });

    for (const event of replayEvents) {
      const eventId = Number.parseInt(event.retention_event_id, 10);
      sse.sendWithId(
        'retry_policy_approval_retention_event',
        event,
        Number.isFinite(eventId) ? eventId : null
      );
    }

    sse.send('ready', {
      trace_id: traceId,
      replay_count: replayEvents.length,
      after_id: afterId,
      watch,
    });

    if (!watch) {
      sse.send('done', {
        trace_id: traceId,
        status: 'completed',
        replay_only: true,
      });
      teardown();
      return res.end();
    }

    unsubscribe = runtime.subscribeRetryPolicyApprovalRetentionEvents((event) => {
      if (!shouldPass(event)) return;
      const eventId = Number.parseInt(event.retention_event_id, 10);
      sse.sendWithId(
        'retry_policy_approval_retention_event',
        event,
        Number.isFinite(eventId) ? eventId : null
      );
    });
    return undefined;
  } catch (error) {
    sse.send('error', {
      trace_id: traceId,
      message: `订阅重试策略审批保留策略事件流失败: ${error.message}`,
    });
    sse.send('done', {
      trace_id: traceId,
      status: 'failed',
    });
    teardown();
    return res.end();
  }
});

router.get('/retry-policy/approvals/events', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const limit = _parseIntInRange(req.query?.limit, RETRY_POLICY_APPROVAL_DEFAULT_LIMIT, 1, 5_000);
    const afterId = _parseAfterEventId(req);
    const ticketId = _trimmedString(req.query?.ticket_id);
    const traceFilter = _trimmedString(req.query?.trace_id);
    const eventType = _trimmedString(req.query?.event_type);

    const events = runtime.listRetryPolicyApprovalEvents({
      after_id: afterId,
      limit,
      ticket_id: ticketId || undefined,
      trace_id: traceFilter || undefined,
      event_type: eventType || undefined,
    });

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        after_id: afterId,
        total: events.length,
        events,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询重试策略审批事件失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/retry-policy/approvals/decision', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const ticketId = _trimmedString(req.body?.ticket_id);
    const decision = _trimmedString(req.body?.decision).toLowerCase();
    const reviewer = _trimmedString(req.body?.reviewer)
      || _headerAsString(req.headers['x-operator-id'])
      || _headerAsString(req.headers['x-actor-id'])
      || null;
    const reason = _trimmedString(req.body?.reason) || null;

    if (!ticketId) {
      return res.status(400).json({
        success: false,
        message: '审批失败: ticket_id 为必填项。',
        data: { trace_id: traceId },
      });
    }
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({
        success: false,
        message: '审批失败: decision 仅支持 approve 或 reject。',
        data: { trace_id: traceId, ticket_id: ticketId },
      });
    }

    const ticket = runtime.getRetryPolicyApprovalTicket(ticketId);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: '审批失败: 未找到对应审批单。',
        data: { trace_id: traceId, ticket_id: ticketId },
      });
    }
    if (ticket.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: `审批失败: 当前审批单状态为 ${ticket.status}，无法再次审批。`,
        data: { trace_id: traceId, ticket_id: ticketId, status: ticket.status },
      });
    }

    const nextTicket = decision === 'approve'
      ? runtime.approveRetryPolicyApprovalTicket(ticketId, reviewer)
      : runtime.rejectRetryPolicyApprovalTicket(ticketId, reviewer, reason || 'rejected_by_reviewer');

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        ticket: nextTicket,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `审批失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/retry-policy', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const policyInput = req.body?.retry_policy || req.body?.retryPolicy || req.body?.policy;
    const { errors, patch } = _validateRetryPolicyPatch(policyInput);
    if (errors.length > 0 || !patch) {
      return res.status(400).json({
        success: false,
        message: `更新重试策略失败: ${errors.join(' ')}`,
        data: { trace_id: traceId },
      });
    }

    const actor = _trimmedString(req.body?.actor)
      || _headerAsString(req.headers['x-operator-id'])
      || _headerAsString(req.headers['x-actor-id'])
      || 'unknown_operator';
    const reason = _trimmedString(req.body?.reason).slice(0, 300);
    const currentPolicy = runtime.getRetryPolicy();
    const guardrail = _evaluateRetryPolicyGuardrails(currentPolicy, patch);
    if (guardrail.blocked) {
      return res.status(422).json({
        success: false,
        message: `更新重试策略失败: ${guardrail.violations.map((item) => item.message).join(' ')}`,
        data: {
          trace_id: traceId,
          code: 'retry_policy_guardrail_blocked',
          violations: guardrail.violations,
          effective_policy: guardrail.effective_policy,
        },
      });
    }

    const risk = _evaluateRetryPolicyRisk(currentPolicy, patch);
    const approvalTicketId = _trimmedString(req.body?.approval_ticket_id || req.body?.approvalTicketId);

    if (risk.requires_approval) {
      if (!approvalTicketId) {
        const approvalTicket = runtime.createRetryPolicyApprovalTicket({
          trace_id: traceId,
          requester: actor,
          reason: reason || null,
          risk_level: risk.risk_level,
          risk_reason: risk.reason,
          patch,
        });
        return res.status(202).json({
          success: true,
          data: {
            trace_id: traceId,
            status: 'approval_required',
            risk,
            approval_ticket: approvalTicket,
          },
        });
      }

      const consumed = runtime.consumeRetryPolicyApprovalTicket(approvalTicketId, {
        patch,
        actor,
      });
      if (!consumed.ok) {
        const code = String(consumed.code || '');
        const status = code === 'ticket_not_found' ? 404 : 409;
        return res.status(status).json({
          success: false,
          message: `更新重试策略失败: ${consumed.message || code}`,
          data: {
            trace_id: traceId,
            code,
            ticket_id: approvalTicketId,
          },
        });
      }
    }

    const update = runtime.updateRetryPolicy(patch, {
      trace_id: traceId,
      actor,
      source: risk.requires_approval ? 'route:large_tasks:approved' : 'route:large_tasks',
      reason: reason || null,
    });

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        changed: update.changed,
        risk,
        retry_policy: update.policy,
        audit_event: update.event,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `更新重试策略失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/:taskId', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    const detail = taskControlService.getTaskDetail(taskId, { includeAudit: false });
    if (!detail.ok) {
      return _taskControlFail(res, traceId, '查询大型任务详情', detail);
    }
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        task: detail.task,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务详情失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/:taskId/audit', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    if (!taskId) {
      return res.status(400).json({
        success: false,
        message: '查询大型任务审计失败: taskId 为必填项。',
        data: { trace_id: traceId },
      });
    }

    const audit = _normalizeTaskAudit(orchestrator.getTaskAudit(taskId));
    if (!audit.task) {
      return res.status(404).json({
        success: false,
        message: `查询大型任务审计失败: 未找到任务 ${taskId}。`,
        data: { trace_id: traceId },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        audit,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `查询大型任务审计失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/:taskId/checkpoints', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    if (!taskId) {
      return res.status(400).json({
        success: false,
        message: '保存大型任务检查点失败: taskId 为必填项。',
        data: { trace_id: traceId },
      });
    }
    if (!runtime.getTask(taskId)) {
      return res.status(404).json({
        success: false,
        message: `保存大型任务检查点失败: 未找到任务 ${taskId}。`,
        data: { trace_id: traceId },
      });
    }

    const checkpoint = runtime.saveCheckpoint(taskId, req.body || {});
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        checkpoint,
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: `保存大型任务检查点失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/:taskId/run', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const taskId = _trimmedString(req.params?.taskId);
    if (!taskId) {
      return res.status(400).json({
        success: false,
        message: '执行大型任务失败: taskId 为必填项。',
        data: { trace_id: traceId },
      });
    }
    if (!runtime.getTask(taskId)) {
      return res.status(404).json({
        success: false,
        message: `执行大型任务失败: 未找到任务 ${taskId}。`,
        data: { trace_id: traceId },
      });
    }

    const runOptions = _buildRunOptions(req.body || {});

    const runResult = await orchestrator.runTask(taskId, _runBuiltinTaskHandler, runOptions);
    if (runResult.code === 'not_claimed') {
      return res.status(409).json({
        success: false,
        message: `执行大型任务失败: ${runResult.message}`,
        data: {
          trace_id: traceId,
          task_id: taskId,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        task_id: taskId,
        run_result: runResult,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `执行大型任务失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/run-next', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const runOptions = _buildRunOptions(req.body || {});

    const runResult = await orchestrator.runNext(_runBuiltinTaskHandler, runOptions);
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        run_result: runResult,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `执行下一个大型任务失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

module.exports = router;
