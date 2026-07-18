'use strict';

/**
 * codexEventStream — Codex CLI 事件流解释子系统。
 *
 * 从 codexAdapter.js(上帝文件·>2500 LOC)抽出的内聚簇:把 Codex CLI 的 stdout_json
 * 事件流(item / tool / file_op / reasoning 等)归一化为「进度证据(progress evidence)」
 * 与结构化的工具/文件操作事件。**零可变模块态**——所有状态经函数参数(progress /
 * state / options)传入传出;宿主 runCodexExec/generate 及 __test__ 按 **同名 re-import**
 * 接回,调用点字节不变(降上帝文件·范式同 candidateDetect / appHostHelpers)。
 *
 * 注意:本模块 **不是** 纯零 IO 叶子——appendCodexExecDebugLog 在设置了
 * KHY_GATEWAY_DEBUG_PROMPT_FILE 时向该文件追加一行调试记录(best-effort)。其余函数均为
 * 纯归一化/推断/快照,不触磁盘、不起进程。
 */
const fs = require('fs');
const path = require('path');
const { splitShellArgs } = require('../../shellSafetyValidator');
const { extractMessageText, extractThinkingTags } = require('./_responsesFormat');

// Transport-level reconnect/channel-closed detector. Consumed by emitCodexEvent
// (reconnectWarning flag) and re-imported by the host for stderr classification
// + reconnect self-heal. Moved here so the leaf's emitCodexEvent is self-contained.
function isReconnectChannelClosed(message = '') {
  return /reconnecting|channel closed|failed to record rollout items|transport issue during rollout recording/i.test(String(message || ''));
}

// Shell control tokens that delimit commands in a pipeline/list. Hoisted to a
// module constant so extractTrackedFileOpsFromShellCommand() reuses one Set
// per bash-tool item in the Codex Responses stream instead of allocating a
// fresh one each call. Consumed read-only (`.has`); never mutated/returned.
const _SHELL_CONTROL_TOKENS = new Set(['|', '||', '&&', ';']);

function compactText(value, maxLen = 200) {
  const t = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

function appendCodexExecDebugLog(stage = '', payload = {}) {
  const targetFile = String(process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE || '').trim();
  if (!targetFile) return;
  const normalizedStage = String(stage || '').trim();
  if (!normalizedStage) return;
  const fields = Object.entries(payload || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${compactText(value, 240)}`);
  const line = `[${new Date().toISOString()}] codex_exec stage=${normalizedStage}${fields.length > 0 ? ` ${fields.join(' ')}` : ''}\n`;
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.appendFileSync(targetFile, line, 'utf8');
  } catch { /* best effort */ }
}

function summarizeValue(v, maxLen = 180) {
  try {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    if (!str) return '';
    const oneLine = str.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
  } catch {
    return '';
  }
}

function getItemType(event) {
  return String(event?.item?.type || event?.item_type || event?.type || '').toLowerCase();
}

function inferToolName(itemType, item) {
  if ((itemType.includes('command') || itemType.includes('shell')) && item?.command) return 'bash';
  // Detect file write/edit operations
  if (itemType.includes('file') || itemType.includes('write') || itemType.includes('edit') || itemType.includes('patch')) {
    if (itemType.includes('write') || itemType.includes('create')) return 'file_write';
    if (itemType.includes('edit') || itemType.includes('patch')) return 'file_edit';
    return 'file_op';
  }
  return item?.tool_name || item?.name || item?.tool || item?.command_name || 'tool';
}

function inferToolInput(itemType, item) {
  if ((itemType.includes('command') || itemType.includes('shell')) && item?.command) return summarizeValue(item.command, 120);
  // Surface file path for file operations
  if (item?.file_path || item?.path) {
    const fp = item.file_path || item.path;
    const extra = item?.description || item?.summary || '';
    return summarizeValue(extra ? `${fp} — ${extra}` : fp, 120);
  }
  return summarizeValue(item?.input || item?.arguments || item?.params || item?.request || '', 120);
}

function inferToolOutput(itemType, item) {
  if ((itemType.includes('command') || itemType.includes('shell')) && item?.output) return summarizeValue(item.output, 180);
  // File operation output
  if (item?.file_path || item?.path) {
    const fp = item.file_path || item.path;
    return summarizeValue(item?.result || item?.response || item?.output || `wrote ${fp}`, 180);
  }
  return summarizeValue(item?.result || item?.response || item?.output || item?.content || '', 180);
}

function normalizeTrackedFileOperation(rawOperation = '') {
  const value = String(rawOperation || '').trim().toLowerCase();
  if (!value) return '';
  if (['create', 'write', 'copy', 'copied', 'scaffold'].includes(value)) return 'create';
  if (['modify', 'edit', 'update', 'updated'].includes(value)) return 'modify';
  if (['delete', 'remove', 'rm', 'unlink'].includes(value)) return 'delete';
  if (['rename', 'renamed'].includes(value)) return 'rename';
  if (['move', 'moved', 'mv'].includes(value)) return 'move';
  return '';
}

function classifyTrackedRelocation(fromPath = '', toPath = '') {
  if (!fromPath || !toPath) return 'move';
  return path.dirname(fromPath) === path.dirname(toPath) ? 'rename' : 'move';
}

function dedupeTrackedFileOps(fileOps = []) {
  const out = [];
  const seen = new Set();

  for (const fileOp of fileOps) {
    if (!fileOp || typeof fileOp !== 'object') continue;
    const operation = normalizeTrackedFileOperation(fileOp.operation || fileOp.op || fileOp.action);
    const fromPath = String(fileOp.fromPath || '').trim();
    const toPath = String(fileOp.toPath || '').trim();
    const pathValue = String(fileOp.path || toPath || fromPath).trim();
    if (!operation || !pathValue) continue;
    const dedupeKey = `${operation}::${fromPath}::${toPath}::${pathValue}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      path: pathValue,
      operation,
      fromPath,
      toPath,
    });
  }

  return out;
}

function extractTrackedFileOpsFromShellCommand(command = '') {
  const text = String(command || '').trim();
  if (!text) return [];

  const fileOps = [];
  const redirectMatch = text.match(/>\s*([^\s|;&]+)\s*$/);
  const teeMatch = text.match(/\btee\s+(?:-a\s+)?([^\s|;&]+)/);
  const writePath = redirectMatch?.[1] || teeMatch?.[1] || '';
  if (writePath && !writePath.startsWith('-')) {
    fileOps.push({ path: writePath, operation: 'create' });
  }

  const argv = splitShellArgs(text) || text.split(/\s+/).filter(Boolean);
  const controlTokens = _SHELL_CONTROL_TOKENS;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || controlTokens.has(token)) continue;

    const exe = path.basename(String(token || '')).replace(/\.exe$/i, '').toLowerCase();
    if (exe !== 'mv' && exe !== 'rm' && exe !== 'unlink') continue;

    const args = [];
    let j = i + 1;
    for (; j < argv.length; j++) {
      const arg = argv[j];
      if (!arg || controlTokens.has(arg)) break;
      args.push(arg);
    }

    const positional = [];
    let endOfOptions = false;
    for (const arg of args) {
      if (!arg) continue;
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && arg.startsWith('-')) continue;
      positional.push(arg);
    }

    if (exe === 'mv') {
      if (positional.length >= 2) {
        const destination = positional[positional.length - 1];
        const sources = positional.slice(0, -1);
        const destinationLooksLikeDirectory = /[\\/]$/.test(destination);
        if (sources.length === 1 && !destinationLooksLikeDirectory) {
          fileOps.push({
            path: destination,
            operation: classifyTrackedRelocation(sources[0], destination),
            fromPath: sources[0],
            toPath: destination,
          });
        } else {
          for (const sourcePath of sources) {
            const targetPath = path.join(destination, path.basename(sourcePath));
            fileOps.push({
              path: targetPath,
              operation: 'move',
              fromPath: sourcePath,
              toPath: targetPath,
            });
          }
        }
      }
    } else {
      for (const targetPath of positional) {
        fileOps.push({
          path: targetPath,
          operation: 'delete',
          fromPath: targetPath,
        });
      }
    }

    i = Math.max(i, j - 1);
  }

  return dedupeTrackedFileOps(fileOps);
}

function inferTrackedFileOps(itemType, item, toolName = '') {
  const fileOps = [];
  const fp = item?.file_path || item?.path || '';
  const fromPath = item?.from_path || item?.fromPath || item?.old_path || item?.oldPath || item?.source || item?.src || fp || '';
  const toPath = item?.to_path || item?.toPath || item?.new_path || item?.newPath || item?.destination || item?.dest || item?.target || '';
  const declaredOperation = normalizeTrackedFileOperation(
    item?.operation || item?.op || item?.action || item?.mode || item?.kind || ''
  );

  if (declaredOperation === 'delete' && fromPath) {
    fileOps.push({ path: fromPath, operation: 'delete', fromPath });
  } else if ((declaredOperation === 'rename' || declaredOperation === 'move') && fromPath && toPath) {
    fileOps.push({
      path: toPath,
      operation: classifyTrackedRelocation(fromPath, toPath),
      fromPath,
      toPath,
    });
  } else if (fp && /^(file_write|file_edit)$/.test(toolName)) {
    fileOps.push({
      path: fp,
      operation: toolName === 'file_write' ? 'create' : 'modify',
    });
  } else if (toolName === 'bash') {
    fileOps.push(...extractTrackedFileOpsFromShellCommand(String(item?.command || item?.input || '').trim()));
  }

  return dedupeTrackedFileOps(fileOps);
}

function isToolLike(itemType, item) {
  if (!itemType) return false;
  if (itemType.includes('tool') || itemType.includes('command') || itemType.includes('shell')) return true;
  // Capture file operations (write, edit, patch, create, delete) emitted by Codex
  if (itemType.includes('file') || itemType.includes('write') || itemType.includes('edit') || itemType.includes('patch')) return true;
  // Capture code interpreter / execution events
  if (itemType.includes('exec') || itemType.includes('action')) return true;
  return !!(item && (item.tool_name || item.command || item.file_path || item.path));
}

const CODEX_PROGRESS_STAGE_RANK = {
  spawned: 0,
  stderr_output: 1,
  stdout_output: 1,
  thread_started: 2,
  turn_started: 3,
  reasoning: 4,
  tool_call: 5,
  assistant_message: 6,
  plain_output: 6,
};

function createCodexProgressEvidence() {
  const now = Date.now();
  return {
    startedAt: now,
    lastEventAt: now,
    lastMeaningfulAt: 0,
    firstMeaningfulAt: 0,
    furthestStage: 'spawned',
    furthestStageAt: now,
    lastEventChannel: 'process',
    lastEventKind: 'spawn',
    lastEventSummary: 'codex spawned',
    firstStdoutAt: 0,
    firstStderrAt: 0,
    firstThreadStartedAt: 0,
    firstTurnStartedAt: 0,
    firstTransportWarningAt: 0,
    lastTransportWarningAt: 0,
    lastTransportWarningSummary: '',
    stdoutJsonEvents: 0,
    stderrJsonEvents: 0,
    stdoutPlainLines: 0,
    stderrPlainLines: 0,
    reconnectWarnings: 0,
    threadStartedCount: 0,
    turnStartedCount: 0,
    reasoningEvents: 0,
    toolCallEvents: 0,
    assistantMessageEvents: 0,
    meaningfulEvents: 0,
    recentEvents: ['process:spawn(codex spawned)'],
  };
}

function recordCodexProgressEvent(progress, payload = {}) {
  if (!progress) return;
  const now = Date.now();
  const channel = String(payload.channel || 'unknown').trim() || 'unknown';
  const kind = String(payload.kind || 'event').trim() || 'event';
  const stage = String(payload.stage || '').trim();
  const summary = compactText(payload.summary || kind, 140) || kind;
  const meaningful = !!payload.meaningful;

  progress.lastEventAt = now;
  progress.lastEventChannel = channel;
  progress.lastEventKind = kind;
  progress.lastEventSummary = summary;
  if (meaningful) {
    progress.lastMeaningfulAt = now;
    if (!progress.firstMeaningfulAt) progress.firstMeaningfulAt = now;
    progress.meaningfulEvents += 1;
  }

  if (channel === 'stdout_json') {
    progress.stdoutJsonEvents += 1;
    if (!progress.firstStdoutAt) progress.firstStdoutAt = now;
  } else if (channel === 'stderr_json') {
    progress.stderrJsonEvents += 1;
    if (!progress.firstStderrAt) progress.firstStderrAt = now;
  } else if (channel === 'stdout') {
    progress.stdoutPlainLines += 1;
    if (!progress.firstStdoutAt) progress.firstStdoutAt = now;
  } else if (channel === 'stderr') {
    progress.stderrPlainLines += 1;
    if (!progress.firstStderrAt) progress.firstStderrAt = now;
  }
  if (payload.reconnectWarning) {
    progress.reconnectWarnings += 1;
    if (!progress.firstTransportWarningAt) progress.firstTransportWarningAt = now;
    progress.lastTransportWarningAt = now;
    progress.lastTransportWarningSummary = summary;
  }

  if (kind === 'thread.started') {
    progress.threadStartedCount += 1;
    if (!progress.firstThreadStartedAt) progress.firstThreadStartedAt = now;
  } else if (kind === 'turn.started') {
    progress.turnStartedCount += 1;
    if (!progress.firstTurnStartedAt) progress.firstTurnStartedAt = now;
  }

  if (stage === 'reasoning') progress.reasoningEvents += 1;
  else if (stage === 'tool_call') progress.toolCallEvents += 1;
  else if (stage === 'assistant_message' || stage === 'plain_output') progress.assistantMessageEvents += 1;

  if (stage) {
    const nextRank = CODEX_PROGRESS_STAGE_RANK[stage] ?? -1;
    const currentRank = CODEX_PROGRESS_STAGE_RANK[progress.furthestStage] ?? -1;
    if (nextRank >= currentRank) {
      progress.furthestStage = stage;
      progress.furthestStageAt = now;
    }
  }

  const entry = `${channel}:${kind}(${summary})`;
  progress.recentEvents.push(entry);
  if (progress.recentEvents.length > 6) progress.recentEvents.shift();
}

function classifyCodexPreResponseStall(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      code: 'unknown',
      summary: 'codex progress snapshot unavailable',
    };
  }

  const meaningfulEvents = Number(snapshot.meaningfulEvents || 0);
  const reconnectWarnings = Number(snapshot.reconnectWarnings || 0);
  const stdoutJsonEvents = Number(snapshot.stdoutJsonEvents || 0);
  const stderrJsonEvents = Number(snapshot.stderrJsonEvents || 0);
  const stdoutPlainLines = Number(snapshot.stdoutPlainLines || 0);
  const stderrPlainLines = Number(snapshot.stderrPlainLines || 0);
  const threadStarted = Number(snapshot.threadStartedCount || 0) > 0;
  const turnStarted = Number(snapshot.turnStartedCount || 0) > 0;

  if (meaningfulEvents > 0 || Number(snapshot.lastMeaningfulAt || 0) > 0) {
    return {
      code: 'meaningful_progress_seen',
      summary: 'meaningful model progress was observed before timeout/error handling',
    };
  }
  if (reconnectWarnings > 0 && turnStarted) {
    return {
      code: 'turn_started_reconnect_loop',
      summary: 'turn.started reached, then repeated reconnect transport warnings arrived before any reasoning/tool/assistant output',
    };
  }
  if (reconnectWarnings > 0 && threadStarted) {
    return {
      code: 'thread_started_reconnect_loop',
      summary: 'thread.started reached, then transport kept reconnecting before any turn/model output arrived',
    };
  }
  if (reconnectWarnings > 0) {
    return {
      code: 'transport_reconnect_before_turn',
      summary: 'transport warnings arrived before turn.started or any assistant output',
    };
  }
  if (turnStarted) {
    return {
      code: 'turn_started_no_followup',
      summary: 'turn.started reached, then no reasoning/tool/assistant output arrived before timeout',
    };
  }
  if (threadStarted) {
    return {
      code: 'thread_started_no_followup',
      summary: 'thread.started reached, then no turn/model output arrived before timeout',
    };
  }
  if ((stderrJsonEvents + stderrPlainLines) > 0 && (stdoutJsonEvents + stdoutPlainLines) === 0) {
    return {
      code: 'stderr_only_startup_noise',
      summary: 'only stderr startup noise arrived before timeout',
    };
  }
  if ((stdoutJsonEvents + stderrJsonEvents) > 0) {
    return {
      code: 'non_meaningful_json_only',
      summary: 'only non-meaningful JSON events arrived before timeout',
    };
  }
  if ((stdoutPlainLines + stderrPlainLines) > 0) {
    return {
      code: 'plain_output_without_model_progress',
      summary: 'only plain subprocess output arrived before timeout',
    };
  }
  return {
    code: 'no_subprocess_output',
    summary: 'no subprocess output arrived before timeout',
  };
}

function snapshotCodexProgressEvidence(progress) {
  if (!progress) return null;
  const now = Date.now();
  const toSinceStartedMs = (value) => {
    const at = Number(value || 0);
    if (at <= 0) return null;
    return Math.max(0, at - Number(progress.startedAt || now));
  };
  const toAgeMs = (value) => {
    const at = Number(value || 0);
    if (at <= 0) return null;
    return Math.max(0, now - at);
  };
  const snapshot = {
    startedAt: Number(progress.startedAt || now),
    lastEventAt: Number(progress.lastEventAt || 0),
    lastEventAgeMs: Math.max(0, now - Number(progress.lastEventAt || now)),
    lastMeaningfulAt: Number(progress.lastMeaningfulAt || 0),
    firstMeaningfulSinceStartMs: toSinceStartedMs(progress.firstMeaningfulAt),
    furthestStage: String(progress.furthestStage || 'unknown').trim() || 'unknown',
    furthestStageAgeMs: Math.max(0, now - Number(progress.furthestStageAt || now)),
    lastEventChannel: String(progress.lastEventChannel || 'unknown').trim() || 'unknown',
    lastEventKind: String(progress.lastEventKind || 'event').trim() || 'event',
    lastEventSummary: compactText(progress.lastEventSummary || '', 160),
    firstStdoutSinceStartMs: toSinceStartedMs(progress.firstStdoutAt),
    firstStderrSinceStartMs: toSinceStartedMs(progress.firstStderrAt),
    firstThreadStartedSinceStartMs: toSinceStartedMs(progress.firstThreadStartedAt),
    firstTurnStartedSinceStartMs: toSinceStartedMs(progress.firstTurnStartedAt),
    firstTransportWarningSinceStartMs: toSinceStartedMs(progress.firstTransportWarningAt),
    lastTransportWarningAgeMs: toAgeMs(progress.lastTransportWarningAt),
    lastTransportWarningSummary: compactText(progress.lastTransportWarningSummary || '', 160),
    stdoutJsonEvents: Number(progress.stdoutJsonEvents || 0),
    stderrJsonEvents: Number(progress.stderrJsonEvents || 0),
    stdoutPlainLines: Number(progress.stdoutPlainLines || 0),
    stderrPlainLines: Number(progress.stderrPlainLines || 0),
    reconnectWarnings: Number(progress.reconnectWarnings || 0),
    threadStartedCount: Number(progress.threadStartedCount || 0),
    turnStartedCount: Number(progress.turnStartedCount || 0),
    reasoningEvents: Number(progress.reasoningEvents || 0),
    toolCallEvents: Number(progress.toolCallEvents || 0),
    assistantMessageEvents: Number(progress.assistantMessageEvents || 0),
    meaningfulEvents: Number(progress.meaningfulEvents || 0),
    recentEvents: Array.isArray(progress.recentEvents)
      ? progress.recentEvents.slice(-6).map((item) => compactText(item, 120)).filter(Boolean)
      : [],
  };
  const stall = classifyCodexPreResponseStall(snapshot);
  snapshot.stallFingerprint = stall.code;
  snapshot.stallSummary = stall.summary;
  return snapshot;
}

function formatCodexProgressEvidence(progress) {
  const snapshot = snapshotCodexProgressEvidence(progress);
  if (!snapshot) return '';
  const recent = snapshot.recentEvents.length > 0 ? snapshot.recentEvents.join(' -> ') : 'none';
  const milestones = [];
  if (snapshot.firstThreadStartedSinceStartMs !== null) milestones.push(`thread:${snapshot.firstThreadStartedSinceStartMs}`);
  if (snapshot.firstTurnStartedSinceStartMs !== null) milestones.push(`turn:${snapshot.firstTurnStartedSinceStartMs}`);
  if (snapshot.firstTransportWarningSinceStartMs !== null) milestones.push(`first_transport:${snapshot.firstTransportWarningSinceStartMs}`);
  if (snapshot.firstMeaningfulSinceStartMs !== null) milestones.push(`first_meaningful:${snapshot.firstMeaningfulSinceStartMs}`);
  return compactText([
    `stall=${snapshot.stallFingerprint}`,
    `stage=${snapshot.furthestStage}`,
    `last_event=${snapshot.lastEventChannel}:${snapshot.lastEventKind}:${snapshot.lastEventSummary || 'n/a'}`,
    `last_event_age_ms=${snapshot.lastEventAgeMs}`,
    `milestones=${milestones.length > 0 ? milestones.join(',') : 'none'}`,
    `counts=stdout_json:${snapshot.stdoutJsonEvents},stderr_json:${snapshot.stderrJsonEvents},stdout_plain:${snapshot.stdoutPlainLines},stderr_plain:${snapshot.stderrPlainLines},reconnect:${snapshot.reconnectWarnings},thread:${snapshot.threadStartedCount},turn:${snapshot.turnStartedCount},reasoning:${snapshot.reasoningEvents},tool:${snapshot.toolCallEvents},assistant:${snapshot.assistantMessageEvents}`,
    `recent=${recent}`,
  ].join(' | '), 640);
}

function createCodexProgressTimeoutError(message, progress) {
  const snapshot = snapshotCodexProgressEvidence(progress);
  const detail = formatCodexProgressEvidence(progress);
  const err = new Error(detail ? `${message} | ${detail}` : message);
  err.code = 'CODEX_FIRST_RESPONSE_TIMEOUT';
  err.codexProgressEvidence = snapshot;
  err.codexProgressSummary = detail;
  err.codexProgressFingerprint = snapshot?.stallFingerprint || '';
  return err;
}

function appendCodexExecProgressLog(stage = '', progress = null, payload = {}) {
  const snapshot = snapshotCodexProgressEvidence(progress);
  const progressSummary = formatCodexProgressEvidence(progress);
  appendCodexExecDebugLog(stage, {
    ...payload,
    stall: snapshot?.stallFingerprint || '',
    stall_summary: snapshot?.stallSummary || '',
    furthest_stage: snapshot?.furthestStage || '',
    last_event_channel: snapshot?.lastEventChannel || '',
    last_event_kind: snapshot?.lastEventKind || '',
    last_event_summary: snapshot?.lastEventSummary || '',
    first_thread_started_ms: snapshot?.firstThreadStartedSinceStartMs ?? '',
    first_turn_started_ms: snapshot?.firstTurnStartedSinceStartMs ?? '',
    first_transport_warning_ms: snapshot?.firstTransportWarningSinceStartMs ?? '',
    last_transport_warning_age_ms: snapshot?.lastTransportWarningAgeMs ?? '',
    last_transport_warning: snapshot?.lastTransportWarningSummary || '',
    meaningful_events: snapshot?.meaningfulEvents ?? '',
    reasoning_events: snapshot?.reasoningEvents ?? '',
    tool_events: snapshot?.toolCallEvents ?? '',
    assistant_events: snapshot?.assistantMessageEvents ?? '',
    stdout_json_events: snapshot?.stdoutJsonEvents ?? '',
    stderr_json_events: snapshot?.stderrJsonEvents ?? '',
    stdout_plain_lines: snapshot?.stdoutPlainLines ?? '',
    stderr_plain_lines: snapshot?.stderrPlainLines ?? '',
    reconnect_warnings: snapshot?.reconnectWarnings ?? '',
    progress: progressSummary || '',
  });
}

function buildCodexProgressDiagnostics(snapshot = null, summary = '') {
  if (!snapshot && !summary) return null;
  return {
    stallFingerprint: String(snapshot?.stallFingerprint || '').trim() || '',
    stallSummary: compactText(snapshot?.stallSummary || '', 240),
    progressSummary: compactText(summary || '', 640),
    progressEvidence: snapshot || null,
  };
}

function emitCodexEvent(event, state, options = {}, progress = null, sourceChannel = 'stdout_json') {
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  const emit = (chunk) => { if (onChunk) onChunk(chunk); };
  const eventType = String(event?.type || '').toLowerCase();
  const item = event?.item || {};
  const itemType = getItemType(event);
  const itemId = String(item.id || event.item_id || event.id || `${eventType}:${Date.now()}`);
  const now = Date.now();

  if (eventType === 'error') {
    recordCodexProgressEvent(progress, {
      channel: sourceChannel,
      kind: 'error',
      summary: event.message || 'codex error',
      reconnectWarning: isReconnectChannelClosed(event.message || ''),
    });
    emit({ type: 'status', text: String(event.message || 'codex error') });
    return false;
  }

  if (eventType === 'turn.started') {
    recordCodexProgressEvent(progress, {
      channel: sourceChannel,
      kind: 'turn.started',
      summary: 'turn.started',
      stage: 'turn_started',
    });
    emit({ type: 'status', text: 'Codex 开始处理请求' });
    return false;
  }
  if (eventType === 'turn.completed') {
    recordCodexProgressEvent(progress, {
      channel: sourceChannel,
      kind: 'turn.completed',
      summary: 'turn.completed',
      stage: 'turn_started',
    });
    emit({ type: 'status', text: 'Codex 完成处理' });
    return false;
  }
  if (eventType === 'thread.started') {
    recordCodexProgressEvent(progress, {
      channel: sourceChannel,
      kind: 'thread.started',
      summary: summarizeValue(event.thread_id || event.threadId || 'thread.started', 80) || 'thread.started',
      stage: 'thread_started',
    });
    return false;
  }

  if (eventType.startsWith('item.')) {
    if (eventType === 'item.started') {
      if (itemType.includes('reasoning')) {
        const t = summarizeValue(item.text || item.summary || '开始思考', 120);
        recordCodexProgressEvent(progress, {
          channel: sourceChannel,
          kind: 'item.reasoning.started',
          summary: t || '开始思考',
          stage: 'reasoning',
          meaningful: true,
        });
        emit({ type: 'thinking', text: t });
        return true;
      }
      if (isToolLike(itemType, item)) {
        state.toolCalls += 1;
        const toolName = inferToolName(itemType, item);
        state.activeTools.set(itemId, { startedAt: now, tool: toolName });
        // Track file operations for completion panel
        const trackedFileOps = inferTrackedFileOps(itemType, item, toolName);
        if (trackedFileOps.length > 0) {
          state.fileOps.push(...trackedFileOps);
        }
        recordCodexProgressEvent(progress, {
          channel: sourceChannel,
          kind: `item.${toolName}.started`,
          summary: inferToolInput(itemType, item) || toolName,
          stage: 'tool_call',
          meaningful: true,
        });
        emit({
          type: 'tool_use',
          tool: toolName,
          input: inferToolInput(itemType, item),
          rawInput: item,
          id: itemId,
        });
        return true;
      }
      return false;
    }

    if (eventType === 'item.updated') {
      if (itemType.includes('reasoning')) {
        const t = summarizeValue(item.text || item.summary || event.delta || '', 120);
        if (t) {
          recordCodexProgressEvent(progress, {
            channel: sourceChannel,
            kind: 'item.reasoning.updated',
            summary: t,
            stage: 'reasoning',
            meaningful: true,
          });
          emit({ type: 'thinking', text: t });
          return true;
        }
      }
      return false;
    }

    if (eventType === 'item.completed') {
      if (itemType.includes('reasoning')) {
        const t = summarizeValue(item.text || item.summary || '思考完成', 120);
        if (t) {
          recordCodexProgressEvent(progress, {
            channel: sourceChannel,
            kind: 'item.reasoning.completed',
            summary: t,
            stage: 'reasoning',
            meaningful: true,
          });
          emit({ type: 'thinking', text: t });
          return true;
        }
        return false;
      }
      if (isToolLike(itemType, item)) {
        const toolInfo = state.activeTools.get(itemId);
        if (toolInfo && toolInfo.startedAt) {
          state.toolDurationMs += Math.max(0, now - toolInfo.startedAt);
        }
        state.activeTools.delete(itemId);
        const out = inferToolOutput(itemType, item) || 'done';
        recordCodexProgressEvent(progress, {
          channel: sourceChannel,
          kind: `item.${inferToolName(itemType, item)}.completed`,
          summary: out,
          stage: 'tool_call',
          meaningful: true,
        });
        emit({ type: 'tool_result', id: itemId, content: out });
        return true;
      }

      if (itemType.includes('message') || itemType.includes('assistant')) {
        const text = extractMessageText(item);
        if (text) {
          const { thinking: thinkText, rest } = extractThinkingTags(text);
          if (thinkText) emit({ type: 'thinking', text: thinkText });
          if (rest) {
            state.finalParts.push(rest);
            recordCodexProgressEvent(progress, {
              channel: sourceChannel,
              kind: 'item.message.completed',
              summary: rest,
              stage: 'assistant_message',
              meaningful: true,
            });
            emit({ type: 'text', text: rest });
          }
          return true;
        }
      }
      return false;
    }
  }

  // Fallback: capture possible message payload outside item.* events
  if (eventType.includes('message')) {
    const text = extractMessageText(event.item || event.message || event);
    if (text) {
      const { thinking: thinkText, rest } = extractThinkingTags(text);
      if (thinkText) emit({ type: 'thinking', text: thinkText });
      if (rest) {
        state.finalParts.push(rest);
        recordCodexProgressEvent(progress, {
          channel: sourceChannel,
          kind: 'message',
          summary: rest,
          stage: 'assistant_message',
          meaningful: true,
        });
        emit({ type: 'text', text: rest });
      }
      return true;
    }
  }
  return false;
}

module.exports = {
  // 传输层重连检测(宿主 stderr 分类 + self-heal 复用)
  isReconnectChannelClosed,
  // 文本压缩 / 调试日志原语(宿主全域复用)
  compactText,
  appendCodexExecDebugLog,
  // 事件 / 工具推断
  summarizeValue,
  getItemType,
  inferToolName,
  inferToolInput,
  inferToolOutput,
  isToolLike,
  // 跟踪的文件操作推断
  normalizeTrackedFileOperation,
  classifyTrackedRelocation,
  dedupeTrackedFileOps,
  extractTrackedFileOpsFromShellCommand,
  inferTrackedFileOps,
  // 进度证据
  createCodexProgressEvidence,
  recordCodexProgressEvent,
  classifyCodexPreResponseStall,
  snapshotCodexProgressEvidence,
  formatCodexProgressEvidence,
  createCodexProgressTimeoutError,
  appendCodexExecProgressLog,
  buildCodexProgressDiagnostics,
  // 事件发射
  emitCodexEvent,
};
