/**
 * /tasks command subsystem: status taxonomy tables, list/detail formatters,
 * and the _handleTasksCommand dispatcher.
 *
 * Extracted verbatim from cli/repl.js (startRepl closure group) as part of the
 * behavior-preserving god-file split. This cluster was the cleanest large
 * extraction target inside startRepl: it references NONE of startRepl's shared
 * mutable state (_busy, rl, pickers, _taskMindMap, etc.) and calls no
 * cross-cluster closures. Its only captured locals were `c` (chalk) and the
 * print* helpers destructured from fmt(); both are reproduced here as local
 * lazy accessors, exactly mirroring repl/startup.js. Per the split plan, the
 * second require cache holds the same singletons Node already memoizes, so
 * behavior is unchanged.
 *
 * `_handleTasksCommand` is exported and called from the REPL line handler with
 * a single string argument, exactly as before.
 */
let _chalk, _formatters;
const chalk = () => {
  if (_chalk) return _chalk;
  const chalkModule = require('chalk');
  _chalk = chalkModule.default || chalkModule;
  return _chalk;
};
const fmt = () => (_formatters ??= require('../formatters'));

const c = chalk();
const { printError, printSuccess, printInfo } = fmt();

const _TASK_GROUP_BY_STATUS = Object.freeze({
  queued: 'pending',
  claimed: 'running',
  running: 'running',
  retry_wait: 'running',
  pausing: 'running',
  paused: 'paused',
  cancelling: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'failed',
  dead_letter: 'failed',
});
const _TASK_STATUS_LABELS = Object.freeze({
  queued: '待执行',
  claimed: '已认领',
  running: '执行中',
  retry_wait: '重试等待',
  pausing: '暂停中',
  paused: '已暂停',
  cancelling: '取消中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  dead_letter: '死信',
});
const _TASK_FILTER_ALIASES = Object.freeze({
  all: 'all',
  '*': 'all',
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  running: 'running',
  active: 'running',
  in_progress: 'running',
  paused: 'paused',
  completed: 'completed',
  done: 'completed',
  success: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  dead_letter: 'failed',
});
const _TASK_ACTION_ALIASES = Object.freeze({
  cancel: 'cancel',
  stop: 'cancel',
  kill: 'cancel',
  pause: 'pause',
  resume: 'resume',
  取消: 'cancel',
  暂停: 'pause',
  恢复: 'resume',
});

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normalizeTaskToken = require('../../utils/trimLowerCase');

function _taskStatusLabel(status = '') {
  const key = String(status || '').trim();
  return _TASK_STATUS_LABELS[key] || key || '未知';
}

function _taskGroup(status = '') {
  const key = String(status || '').trim();
  return _TASK_GROUP_BY_STATUS[key] || 'pending';
}

function _parseIsoTime(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function _sortTasksByUpdatedDesc(tasks = []) {
  return [...tasks].sort((a, b) => _parseIsoTime(b?.updated_at) - _parseIsoTime(a?.updated_at));
}

function _toShortTime(value) {
  const ts = _parseIsoTime(value);
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(value || '-');
  }
}

function _truncateText(value, max = 36) {
  const text = String(value || '').trim();
  if (!text) return '-';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function _taskSummaryText(task) {
  const payload = task?.payload_json || {};
  return _truncateText(
    payload.description
    || payload.label
    || payload.subject
    || payload.type
    || task?.type
    || '',
    42
  );
}

function _taskProgressText(task) {
  const pct = Number(task?.progress_pct);
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : '-';
}

function _taskAttemptText(task) {
  const current = Number.isFinite(Number(task?.attempt_count)) ? Number(task.attempt_count) : 0;
  const max = Number.isFinite(Number(task?.max_attempts)) ? Number(task.max_attempts) : '-';
  return `${current}/${max}`;
}

function _printTasksUsage() {
  const lines = [
    '  /tasks 用法:',
    '    /tasks',
    '    /tasks all|pending|running|paused|completed|failed [limit]',
    '    /tasks <taskId>',
    '    /tasks cancel <taskId> [reason]',
    '    /tasks pause <taskId>',
    '    /tasks resume <taskId>',
  ];
  console.log('');
  lines.forEach((lineText) => console.log(lineText));
  console.log('');
}

function _printTaskList(runtimeTasks, listTitle, limit) {
  const tableRows = runtimeTasks.slice(0, limit).map((task) => [
    task.id,
    `${_taskStatusLabel(task.status)} (${task.status})`,
    _truncateText(task.type || '-', 18),
    _taskProgressText(task),
    _taskAttemptText(task),
    _toShortTime(task.updated_at),
    _taskSummaryText(task),
  ]);

  console.log('');
  console.log(c.bold(`  ${listTitle}（显示 ${tableRows.length}/${runtimeTasks.length}）`));
  fmt().printTable(['Task ID', '状态', '类型', '进度', '重试', '最近更新', '摘要'], tableRows);
  console.log('');
}

function _printTaskDetail(task, audit) {
  const payload = task?.payload_json || {};
  const attempts = Array.isArray(audit?.attempts) ? audit.attempts : [];
  const events = Array.isArray(audit?.events) ? audit.events : [];

  console.log('');
  console.log(c.bold(`  任务详情: ${task.id}`));
  console.log(`    状态: ${_taskStatusLabel(task.status)} (${task.status})`);
  console.log(`    类型: ${task.type || '-'}`);
  console.log(`    来源: ${payload.source || '-'}`);
  console.log(`    进度: ${_taskProgressText(task)}`);
  console.log(`    重试: ${_taskAttemptText(task)}`);
  console.log(`    创建: ${_toShortTime(task.created_at)}`);
  console.log(`    更新: ${_toShortTime(task.updated_at)}`);
  if (task.completed_at) console.log(`    完成: ${_toShortTime(task.completed_at)}`);
  if (task.next_run_at) console.log(`    下次运行: ${_toShortTime(task.next_run_at)}`);
  if (task.trace_id) console.log(`    Trace: ${task.trace_id}`);
  if (payload.description || payload.label || payload.subject) {
    console.log(`    摘要: ${payload.description || payload.label || payload.subject}`);
  }

  if (task.last_error) {
    const err = task.last_error;
    const statusCode = err.status_code !== undefined && err.status_code !== null ? ` status=${err.status_code}` : '';
    const retryable = typeof err.retryable === 'boolean' ? ` retryable=${err.retryable}` : '';
    console.log(`    最近错误: ${err.type || 'error'}${statusCode}${retryable}`);
    if (err.message) console.log(`      ${err.message}`);
  }

  if (task.last_result !== undefined && task.last_result !== null) {
    let resultText = '';
    try {
      resultText = typeof task.last_result === 'string'
        ? task.last_result
        : JSON.stringify(task.last_result);
    } catch {
      resultText = String(task.last_result);
    }
    console.log(`    最近结果: ${_truncateText(resultText, 180)}`);
  }

  if (attempts.length > 0) {
    const attemptRows = attempts.slice(-5).reverse().map((item) => [
      String(item.attempt_no ?? '-'),
      String(item.result_status || '-'),
      String(item.error_type || '-'),
      item.retry_delay_ms ? `${item.retry_delay_ms}ms` : '-',
      _toShortTime(item.ended_at || item.started_at),
    ]);
    fmt().printTable(['尝试', '结果', '错误类型', '延迟', '时间'], attemptRows);
  }

  if (events.length > 0) {
    const eventRows = events.slice(-6).reverse().map((event) => [
      String(event.event_id ?? '-'),
      `${event.state_from || '-'} -> ${event.state_to || '-'}`,
      String(event.attempt_no ?? '-'),
      _toShortTime(event.at),
    ]);
    fmt().printTable(['事件', '状态变化', '尝试', '时间'], eventRows);
  }
  console.log('');
}

function _parseLimitToken(tokens, index, fallback) {
  const raw = String(tokens[index] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, parsed));
}

async function _handleTasksCommand(rawArgs = '') {
  const taskControlService = require('../../services/taskControlService');
  const { runTasksControlContract } = require('../tasksControlContract');
  const argsText = String(rawArgs || '').trim();
  const tokens = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
  const primary = _normalizeTaskToken(tokens[0] || '');

  if (primary === '?' || primary === 'help' || primary === 'h' || primary === '帮助') {
    _printTasksUsage();
    return;
  }

  const control = runTasksControlContract(argsText, {
    taskControlService,
    actionAliases: _TASK_ACTION_ALIASES,
    taskStatusLabel: _taskStatusLabel,
    defaultCancelReason: 'Cancelled by /tasks command',
  });
  if (control.handled) {
    for (const event of control.events) {
      if (event.level === 'success') printSuccess(event.text);
      else if (event.level === 'info') printInfo(event.text);
      else printError(event.text);
    }
    return;
  }

  const filter = primary ? _TASK_FILTER_ALIASES[primary] || null : 'all';
  if (filter) {
    const allTasks = _sortTasksByUpdatedDesc(taskControlService.listTasks());
    const summary = { total: allTasks.length, pending: 0, running: 0, paused: 0, completed: 0, failed: 0 };
    for (const item of allTasks) {
      const group = _taskGroup(item.status);
      summary[group] = (summary[group] || 0) + 1;
    }

    const filtered = filter === 'all'
      ? allTasks
      : allTasks.filter((item) => _taskGroup(item.status) === filter);
    const limit = _parseLimitToken(tokens, 1, filter === 'all' ? 12 : 20);
    printInfo(
      `任务概览 total=${summary.total} pending=${summary.pending} running=${summary.running} paused=${summary.paused} completed=${summary.completed} failed=${summary.failed}`
    );
    if (filtered.length === 0) {
      printInfo(`没有匹配任务（过滤器: ${filter}）`);
      return;
    }
    _printTaskList(filtered, `任务列表 /tasks ${filter}`, limit);
    if (tokens.length === 0) {
      printInfo('提示: /tasks <taskId> 查看详情，/tasks help 查看完整用法');
    }
    return;
  }

  const taskId = String(tokens[0] || '').trim();
  if (!taskId) {
    _printTasksUsage();
    return;
  }
  const detail = taskControlService.getTaskDetail(taskId, { includeAudit: true });
  if (!detail.ok) {
    printError(`任务不存在: ${taskId}`);
    printInfo('提示: 运行 /tasks 查看可用任务列表');
    return;
  }
  _printTaskDetail(detail.task, detail.audit);
}

module.exports = {
  _handleTasksCommand,
};
