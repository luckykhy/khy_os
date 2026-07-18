'use strict';

const crypto = require('crypto');
const express = require('express');
const { attach: attachSseKeepalive } = require('../services/sseKeepalive');

const {
  sshConfigService,
  sshCredentialGuard,
  sshConnectionManager,
  remoteWorkspaceResolver,
  remoteExecService,
  remoteApprovalBridge,
  remoteStateSyncService,
  remoteExecStreamStore,
  buildRemoteExecStreamRequestFingerprint,
  listPersistenceAlerts,
  subscribePersistenceAlerts,
  markPersistenceAlertsAcknowledged,
} = require('../services/remote');

const router = express.Router();

function _buildTraceId(req) {
  const incoming = req.headers['x-trace-id'];
  if (typeof incoming === 'string' && incoming.trim()) {
    return incoming.trim();
  }
  return `remote_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _trimmedString = require('../utils/trimIfString');

function _normalizeCommandList(commands) {
  if (!Array.isArray(commands)) return [];
  return commands
    .map((command) => (typeof command === 'string' ? command.trim() : ''))
    .filter(Boolean);
}

function _parsePositiveInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
}

const _parseBoolean = (value, fallback = false) => require('../utils/parseBoolean')(value, fallback, { extended: false });

function _allowedHostAliasSet() {
  const raw = process.env.KHY_REMOTE_SSH_ALLOWLIST || '';
  return new Set(
    String(raw)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function _headerAsString(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function _parseAfterSeqFromRequest(req) {
  const fromBody = req.body?.after_seq;
  if (fromBody !== undefined && fromBody !== null && String(fromBody).trim() !== '') {
    const parsed = Number.parseInt(fromBody, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const fromQuery = req.query?.after_seq;
  if (fromQuery !== undefined && fromQuery !== null && String(fromQuery).trim() !== '') {
    const parsed = Number.parseInt(fromQuery, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const fromHeader = _headerAsString(req.headers['last-event-id']);
  if (!fromHeader) return 0;
  const parsed = Number.parseInt(fromHeader, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function _buildStreamId() {
  return `stream_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

async function _runRemoteExecStreamExecution({
  streamId,
  traceId,
  executionRequest,
}) {
  const connectionId = _trimmedString(executionRequest?.connection_id);
  const commands = _normalizeCommandList(executionRequest?.commands);
  const dryRun = executionRequest?.dry_run !== false;
  const idempotencyKey = _trimmedString(executionRequest?.idempotency_key);
  const approvalTicketId = _trimmedString(executionRequest?.approval_ticket_id);
  const riskContext = executionRequest?.risk_context && typeof executionRequest.risk_context === 'object'
    ? executionRequest.risk_context
    : null;

  const append = (event, payload = {}) => remoteExecStreamStore.appendEvent(streamId, {
    event,
    data: {
      stream_id: streamId,
      ...payload,
    },
  });

  const appendDone = (status, extra = {}) => append('done', {
    trace_id: traceId,
    status,
    ts: new Date().toISOString(),
    ...extra,
  });

  try {
    append('start', {
      trace_id: traceId,
      connection_id: connectionId || null,
      dry_run: dryRun,
      command_count: commands.length,
      ts: new Date().toISOString(),
    });

    if (!connectionId) {
      append('error', {
        trace_id: traceId,
        message: '执行远程命令失败: connection_id 为必填项。',
      });
      appendDone('failed', { reason: 'connection_id_required' });
      return;
    }

    if (commands.length === 0) {
      append('error', {
        trace_id: traceId,
        connection_id: connectionId,
        message: '执行远程命令失败: commands 不能为空。',
      });
      appendDone('failed', { reason: 'commands_required' });
      return;
    }

    if (dryRun) {
      const dryRunResult = remoteExecService.planDryRun({
        connectionId,
        commands,
        traceId,
        riskContext,
      });
      append('result', dryRunResult);
      appendDone('completed');
      return;
    }

    const execResult = await remoteExecService.requestExecution({
      connectionId,
      commands,
      idempotencyKey,
      approvalTicketId,
      traceId,
      riskContext,
      onEvent: (eventPayload) => append('remote_event', eventPayload),
    });

    append('result', execResult);
    appendDone(execResult?.status || 'completed');
  } catch (error) {
    append('error', {
      trace_id: traceId,
      message: `执行远程命令失败: ${error.message}`,
    });
    appendDone('failed', { reason: 'execution_exception' });
  }
}

router.get('/hosts', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const discovered = sshConfigService.listHosts();

    const hosts = discovered.hosts.map((host) => ({
      ...host,
      credential_status: sshCredentialGuard.validateHostCredentials(host),
    }));

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        config_path: discovered.configPath,
        total_hosts: hosts.length,
        hosts,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取 SSH 主机配置失败: ${error.message}`,
      data: {
        trace_id: traceId,
      },
    });
  }
});

router.post('/connect', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const hostAlias = _trimmedString(req.body?.hostAlias);
    const requestedWorkspace = _trimmedString(req.body?.workspace);
    const purpose = _trimmedString(req.body?.purpose) || 'development';

    if (!hostAlias) {
      return res.status(400).json({
        success: false,
        message: '连接远程主机失败: hostAlias 为必填项。',
        data: { trace_id: traceId },
      });
    }

    const allowlist = _allowedHostAliasSet();
    if (allowlist.size > 0 && !allowlist.has(hostAlias)) {
      return res.status(403).json({
        success: false,
        message: `连接远程主机失败: 主机别名 ${hostAlias} 不在允许列表中。`,
        data: {
          trace_id: traceId,
          allowed_aliases: Array.from(allowlist),
        },
      });
    }

    const discovered = sshConfigService.listHosts();
    const hostEntry = discovered.hosts.find((item) => item.alias === hostAlias);

    if (!hostEntry) {
      return res.status(404).json({
        success: false,
        message: `连接远程主机失败: 未找到别名 ${hostAlias}。`,
        data: { trace_id: traceId },
      });
    }

    const credentialStatus = sshCredentialGuard.validateHostCredentials(hostEntry);
    if (!credentialStatus.ok) {
      return res.status(400).json({
        success: false,
        message: `连接远程主机失败: ${credentialStatus.message}`,
        data: {
          trace_id: traceId,
          host_alias: hostAlias,
          credential_status: credentialStatus,
        },
      });
    }

    const workspace = remoteWorkspaceResolver.resolveWorkspace({
      requestedWorkspace,
      hostEntry,
    });

    const session = sshConnectionManager.connect({
      hostEntry,
      workspace,
      purpose,
      traceId,
    });

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        connection_id: session.connectionId,
        status: session.status,
        host_alias: session.hostAlias,
        host: session.host,
        port: session.port,
        user: session.remoteUser,
        workspace: session.remoteWorkspace,
        purpose: session.purpose,
      },
    });
  } catch (error) {
    const code = error.code === 'workspace_not_allowed' ? 400 : 500;
    return res.status(code).json({
      success: false,
      message: `连接远程主机失败: ${error.message}`,
      data: {
        trace_id: traceId,
      },
    });
  }
});

router.post('/disconnect', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const connectionId = _trimmedString(req.body?.connection_id);

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        message: '断开远程会话失败: connection_id 为必填项。',
        data: { trace_id: traceId },
      });
    }

    const result = sshConnectionManager.disconnect(connectionId);
    if (!result.disconnected) {
      const statusCode = result.status === 'not_found' ? 404 : 400;
      return res.status(statusCode).json({
        success: false,
        message: `断开远程会话失败: ${result.status}`,
        data: {
          trace_id: traceId,
          connection_id: connectionId,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        connection_id: result.connectionId,
        status: result.status,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `断开远程会话失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/exec', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const connectionId = _trimmedString(req.body?.connection_id);
    const commands = _normalizeCommandList(req.body?.commands);
    const dryRun = req.body?.dry_run !== false;
    const idempotencyKey = _trimmedString(req.body?.idempotency_key);
    const approvalTicketId = _trimmedString(req.body?.approval_ticket_id);
    const riskContext = req.body?.risk_context && typeof req.body.risk_context === 'object'
      ? req.body.risk_context
      : null;

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        message: '执行远程命令失败: connection_id 为必填项。',
        data: { trace_id: traceId },
      });
    }

    if (commands.length === 0) {
      return res.status(400).json({
        success: false,
        message: '执行远程命令失败: commands 不能为空。',
        data: {
          trace_id: traceId,
          connection_id: connectionId,
        },
      });
    }

    if (dryRun) {
      const dryRunResult = remoteExecService.planDryRun({
        connectionId,
        commands,
        traceId,
        riskContext,
      });
      return res.json({
        success: true,
        data: dryRunResult,
      });
    }

    const execResult = await remoteExecService.requestExecution({
      connectionId,
      commands,
      idempotencyKey,
      approvalTicketId,
      traceId,
      riskContext,
    });

    if (execResult.status === 'idempotency_key_required') {
      return res.status(400).json({
        success: false,
        message: '执行远程命令失败: 副作用操作必须提供 idempotency_key。',
        data: execResult,
      });
    }

    if (execResult.status === 'approval_required') {
      return res.status(202).json({
        success: true,
        data: execResult,
      });
    }

    if (execResult.status === 'idempotency_conflict') {
      return res.status(409).json({
        success: false,
        message: '执行远程命令失败: idempotency_key 与历史请求冲突。',
        data: execResult,
      });
    }

    if (execResult.status === 'idempotency_in_progress') {
      return res.status(409).json({
        success: false,
        message: '执行远程命令失败: 相同 idempotency_key 的请求正在处理中。',
        data: execResult,
      });
    }

    if (execResult.status === 'approval_idempotency_mismatch') {
      return res.status(409).json({
        success: false,
        message: '执行远程命令失败: idempotency_key 与审批单不匹配。',
        data: execResult,
      });
    }

    if (execResult.status === 'approval_ticket_consumed') {
      return res.status(409).json({
        success: false,
        message: '执行远程命令失败: 该审批单已被消费。',
        data: execResult,
      });
    }

    if (execResult.status === 'approval_ticket_consume_failed') {
      return res.status(409).json({
        success: false,
        message: '执行远程命令失败: 审批单消费失败。',
        data: execResult,
      });
    }

    if (execResult.status === 'execution_disabled') {
      return res.status(409).json({
        success: false,
        message: '远程副作用执行已禁用: 当前阶段仅支持 dry_run 预演。',
        data: execResult,
      });
    }

    if (execResult.status === 'idempotent_replay') {
      return res.json({
        success: true,
        data: execResult,
      });
    }

    if (execResult.status === 'execution_error') {
      return res.status(500).json({
        success: false,
        message: '执行远程命令失败: 远程执行器返回错误。',
        data: execResult,
      });
    }

    return res.json({
      success: true,
      data: execResult,
    });
  } catch (error) {
    const statusCode = error.code === 'session_not_found' ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      message: `执行远程命令失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/exec/stream', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const connectionId = _trimmedString(req.body?.connection_id);
    const commands = _normalizeCommandList(req.body?.commands);
    const dryRunExplicit = req.body?.dry_run !== undefined;
    const dryRun = req.body?.dry_run !== false;
    const idempotencyKey = _trimmedString(req.body?.idempotency_key);
    const approvalTicketId = _trimmedString(req.body?.approval_ticket_id);
    const riskContext = req.body?.risk_context && typeof req.body.risk_context === 'object'
      ? req.body.risk_context
      : null;
    const streamIdFromBody = _trimmedString(req.body?.stream_id);
    const streamIdFromHeader = _headerAsString(req.headers['x-stream-id']);
    const streamId = streamIdFromBody || streamIdFromHeader || _buildStreamId();
    const afterSeq = _parseAfterSeqFromRequest(req);
    const hasExecutionPayload = Boolean(connectionId)
      || commands.length > 0
      || Boolean(idempotencyKey)
      || Boolean(approvalTicketId)
      || Boolean(riskContext)
      || dryRunExplicit;

    if (!hasExecutionPayload && !streamIdFromBody && !streamIdFromHeader) {
      return res.status(400).json({
        success: false,
        message: '恢复执行流失败: 缺少 stream_id，且未提供新的执行参数。',
        data: { trace_id: traceId },
      });
    }

    if (!hasExecutionPayload && !remoteExecStreamStore.hasSession(streamId)) {
      return res.status(404).json({
        success: false,
        message: '恢复执行流失败: 未找到对应 stream_id。',
        data: {
          trace_id: traceId,
          stream_id: streamId,
        },
      });
    }

    const requestContext = hasExecutionPayload
      ? {
          connection_id: connectionId,
          commands,
          dry_run: dryRun,
          idempotency_key: idempotencyKey || null,
          approval_ticket_id: approvalTicketId || null,
          risk_context: riskContext,
        }
      : null;

    const requestFingerprint = hasExecutionPayload
      ? buildRemoteExecStreamRequestFingerprint({
          connectionId,
          commands,
          dryRun,
          idempotencyKey,
          approvalTicketId,
          riskContext,
        })
      : null;

    const ensureResult = remoteExecStreamStore.ensureSession({
      streamId,
      requestFingerprint,
      requestContext,
      metadata: {
        trace_id: traceId,
        connection_id: connectionId || null,
      },
    });

    if (!ensureResult.ok) {
      const status = ensureResult.code === 'stream_payload_conflict' ? 409 : 400;
      return res.status(status).json({
        success: false,
        message: `执行流创建失败: ${ensureResult.message}`,
        data: {
          trace_id: traceId,
          stream_id: streamId,
          code: ensureResult.code,
          session: ensureResult.session || null,
        },
      });
    }

    res.setHeader('X-KHY-Remote-Stream-Id', streamId);

    const sse = attachSseKeepalive(res);
    let streamClosed = false;
    let lastDeliveredSeq = afterSeq;
    let unsubscribe = () => {};

    const finish = () => {
      if (streamClosed) return;
      streamClosed = true;
      try { unsubscribe(); } catch { /* ignore */ }
      sse.stop();
      try { res.end(); } catch { /* ignore */ }
    };

    const sendRecord = (record) => {
      if (streamClosed || !record) return;
      const seq = Number.parseInt(record.seq, 10);
      if (!Number.isFinite(seq) || seq <= lastDeliveredSeq) return;
      lastDeliveredSeq = seq;
      sse.sendWithId(record.event, record.data, seq);
      if (record.event === 'done') {
        finish();
      }
    };

    res.on('close', () => {
      finish();
    });

    unsubscribe = remoteExecStreamStore.subscribe(streamId, (record) => {
      sendRecord(record);
    });

    const replay = remoteExecStreamStore.getEventsSince(streamId, afterSeq);
    if (!replay) {
      sse.send('error', {
        trace_id: traceId,
        stream_id: streamId,
        message: '恢复执行流失败: 未找到对应 stream_id。',
      });
      sse.send('done', {
        trace_id: traceId,
        stream_id: streamId,
        status: 'failed',
        reason: 'stream_not_found',
      });
      finish();
      return;
    }

    if (replay.truncated) {
      sse.send('warning', {
        trace_id: traceId,
        stream_id: streamId,
        message: `重放窗口已截断: 当前可用事件从 seq=${replay.first_available_seq} 开始。`,
        requested_after_seq: replay.after_seq,
        first_available_seq: replay.first_available_seq,
      });
    }

    for (const record of replay.events) {
      sendRecord(record);
      if (streamClosed) return;
    }

    if (remoteExecStreamStore.isDone(streamId)) {
      finish();
      return;
    }

    const claimResult = remoteExecStreamStore.claimStart(streamId);
    if (!claimResult.ok) {
      sse.send('error', {
        trace_id: traceId,
        stream_id: streamId,
        message: '执行流状态异常: 无法确认执行状态。',
      });
      sse.send('done', {
        trace_id: traceId,
        stream_id: streamId,
        status: 'failed',
        reason: claimResult.code,
      });
      finish();
      return;
    }

    if (claimResult.shouldStart) {
      const session = remoteExecStreamStore.getSession(streamId);
      const executionRequest = session?.request_context || requestContext || {};
      const runningPromise = _runRemoteExecStreamExecution({
        streamId,
        traceId,
        executionRequest,
      });
      remoteExecStreamStore.setExecutionPromise(streamId, runningPromise);
      runningPromise
        .catch(() => {
          /* errors are already captured as stream events */
        })
        .finally(() => {
          remoteExecStreamStore.setExecutionPromise(streamId, null);
        });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `执行远程命令失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/exec/stream/:streamId', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const streamId = _trimmedString(req.params?.streamId);
    const afterSeq = _parseAfterSeqFromRequest(req);

    if (!streamId) {
      return res.status(400).json({
        success: false,
        message: '读取执行流失败: stream_id 为必填项。',
        data: { trace_id: traceId },
      });
    }

    const session = remoteExecStreamStore.getSession(streamId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: '读取执行流失败: 未找到对应 stream_id。',
        data: {
          trace_id: traceId,
          stream_id: streamId,
        },
      });
    }

    const replay = remoteExecStreamStore.getEventsSince(streamId, afterSeq);
    if (!replay) {
      return res.status(404).json({
        success: false,
        message: '读取执行流失败: 执行流已过期或不存在。',
        data: {
          trace_id: traceId,
          stream_id: streamId,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        stream: {
          stream_id: session.stream_id,
          created_at: session.created_at,
          updated_at: session.updated_at,
          started: session.started,
          done: session.done,
          terminal_status: session.terminal_status,
          last_seq: session.last_seq,
          request_fingerprint: session.request_fingerprint,
          connection_id: session.metadata?.connection_id || null,
        },
        replay,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取执行流失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/approvals/pending', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const tickets = remoteApprovalBridge.listPendingTickets();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total_pending: tickets.length,
        approvals: tickets,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取远程审批队列失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/approvals/decision', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const ticketId = _trimmedString(req.body?.ticket_id);
    const decision = _trimmedString(req.body?.decision).toLowerCase();
    const reviewer = _trimmedString(req.body?.reviewer) || null;
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

    const ticket = remoteApprovalBridge.getTicket(ticketId);
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
        data: {
          trace_id: traceId,
          ticket_id: ticketId,
          status: ticket.status,
        },
      });
    }

    const nextTicket = decision === 'approve'
      ? remoteApprovalBridge.approveTicket(ticketId, reviewer)
      : remoteApprovalBridge.rejectTicket(ticketId, reviewer, reason || 'rejected_by_reviewer');

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

router.get('/sessions', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const snapshot = remoteStateSyncService.getSnapshot();
    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        ...snapshot,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取远程会话状态失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/alerts/persistence', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const afterId = _parsePositiveInt(req.query?.after_id, 0, 0);
    const limit = _parsePositiveInt(req.query?.limit, 20, 1, 200);
    const onlyUnacked = _parseBoolean(req.query?.only_unacked, false);
    const alerts = listPersistenceAlerts({ afterId, limit, onlyUnacked });
    const snapshot = remoteStateSyncService.getSnapshot();

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        total: alerts.length,
        after_id: afterId,
        limit,
        only_unacked: onlyUnacked,
        alerts,
        latest: snapshot.persistence?.latest_alert || null,
        latest_unacked: snapshot.persistence?.latest_unacked_alert || null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取持久化告警失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.post('/alerts/persistence/ack', async (req, res) => {
  const traceId = _buildTraceId(req);
  try {
    const alertId = _parsePositiveInt(req.body?.alert_id, null, 1);
    const upToId = _parsePositiveInt(req.body?.up_to_id, null, 1);
    const reviewer = _trimmedString(req.body?.reviewer) || null;

    if (alertId == null && upToId == null) {
      return res.status(400).json({
        success: false,
        message: '确认持久化告警失败: alert_id 或 up_to_id 至少提供一个。',
        data: { trace_id: traceId },
      });
    }

    const ackResult = markPersistenceAlertsAcknowledged({
      alertId,
      upToId,
      reviewer,
    });

    if (!ackResult.ok) {
      return res.status(400).json({
        success: false,
        message: `确认持久化告警失败: ${ackResult.code}`,
        data: {
          trace_id: traceId,
          ...ackResult,
        },
      });
    }

    if (ackResult.acked_count === 0) {
      return res.status(404).json({
        success: false,
        message: '确认持久化告警失败: 未找到可确认的告警。',
        data: {
          trace_id: traceId,
          ...ackResult,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        trace_id: traceId,
        ...ackResult,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `确认持久化告警失败: ${error.message}`,
      data: { trace_id: traceId },
    });
  }
});

router.get('/alerts/persistence/stream', async (req, res) => {
  const traceId = _buildTraceId(req);
  const afterIdFromHeader = _parsePositiveInt(req.headers['last-event-id'], 0, 0);
  const afterId = _parsePositiveInt(req.query?.after_id, afterIdFromHeader, 0);
  const limit = _parsePositiveInt(req.query?.limit, 50, 1, 200);
  const onlyUnacked = _parseBoolean(req.query?.only_unacked, false);
  const watch = _parseBoolean(req.query?.watch, true);

  const sse = attachSseKeepalive(res);
  let closed = false;
  let unsubscribe = () => {};
  let lastDeliveredId = afterId;

  const close = () => {
    if (closed) return;
    closed = true;
    try { unsubscribe(); } catch { /* ignore */ }
    sse.stop();
    try { res.end(); } catch { /* ignore */ }
  };

  const sendAlert = (alert) => {
    if (closed || !alert || typeof alert !== 'object') return;
    const alertId = _parsePositiveInt(alert.alert_id, 0, 1);
    if (alertId <= lastDeliveredId) return;
    if (onlyUnacked && alert.acked) return;
    lastDeliveredId = alertId;
    sse.sendWithId('persistence_alert', alert, alertId);
  };

  res.on('close', () => {
    close();
  });

  try {
    unsubscribe = subscribePersistenceAlerts((alert) => {
      sendAlert(alert);
    });

    const replay = listPersistenceAlerts({ afterId, limit, onlyUnacked });
    sse.send('ready', {
      trace_id: traceId,
      after_id: afterId,
      limit,
      watch,
      only_unacked: onlyUnacked,
      replay_count: replay.length,
      ts: new Date().toISOString(),
    });
    for (const alert of replay) {
      sendAlert(alert);
    }

    if (!watch) {
      sse.send('done', {
        trace_id: traceId,
        status: 'replay_complete',
        delivered_count: replay.length,
        last_delivered_id: lastDeliveredId,
      });
      close();
    }
  } catch (error) {
    sse.send('error', {
      trace_id: traceId,
      message: `读取持久化告警流失败: ${error.message}`,
    });
    sse.send('done', {
      trace_id: traceId,
      status: 'failed',
    });
    close();
  }
});

module.exports = router;
