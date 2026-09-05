'use strict';

/**
 * toolProgressAggregator.js — Y-code 风格工具进度聚合器。
 *
 * 基于 Y-code core/tool_progress.py 的 ToolProgressAggregator，
 * 适配 Khyos 服务端场景。
 *
 * 核心能力：
 *  1. 相邻的 read_file/search_code 调用聚合成单行摘要
 *     "已读取 3 个文件 · 1.2s" 而非 3 行
 *  2. 并行调用检测：多个 read/search 同时进行时显示
 *     "正在并行读取 3 个文件"
 *  3. 变更文件工具带 diff 统计：+5 / -2 行
 *  4. 错误信息简洁化 + 去重
 *  5. 所有条目带耗时统计
 *
 * 使用方式：
 *  const agg = new ToolProgressAggregator();
 *  agg.start({ id, name, arguments, display });
 *  // ... tool executes ...
 *  agg.finish({ id, name, result, ok, duration_ms, display });
 *  const lines = agg.flush();
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const READ_CATEGORIES = new Set(['read', 'search']);
const AGGREGATE_CATEGORIES = new Set(['read', 'search']);

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(durationMs) {
  return (durationMs / 1000).toFixed(1) + 's';
}

function truncateTarget(name, target, maxLen) {
  maxLen = maxLen || 60;
  if (!target) {
    return '';
  }
  if (target.length <= maxLen) {
    return target;
  }
  return target.slice(0, maxLen - 3) + '...';
}

// ─── Class ─────────────────────────────────────────────────────────────────

class ToolProgressAggregator {
  constructor() {
    this._active = new Map(); // id → { event, startedAt }
    this._pending = null; // { category, count, durationMs, metrics }
    this._finishedIds = new Set();
    this._diffIds = new Set();
  }

  /**
   * Register a tool call start event.
   *
   * @param {object} payload - { id, name, category, target, command, metrics, duration_ms, ok }
   */
  start(payload) {
    const id = String(payload.id || '');
    if (!id) {
      return;
    }
    this._active.delete(id);
    this._finishedIds.delete(id);
    this._diffIds.delete(id);

    const event = _normalizeEvent(payload);
    this._active.set(id, {
      event,
      startedAt: Date.now(),
    });
  }

  /**
   * Register a tool call finish event and return formatted lines.
   *
   * @param {object} payload
   * @returns {string[]} Formatted output lines
   */
  finish(payload) {
    const id = String(payload.id || '');
    if (!id) {
      const lines = this.flush();
      lines.push(protocolErrorLine('缺少工具 ID'));
      return lines;
    }
    if (this._finishedIds.has(id)) {
      return [];
    }

    const activeRecord = this._active.get(id);
    const startedAt = activeRecord ? activeRecord.startedAt : Date.now();
    this._active.delete(id);
    this._finishedIds.add(id);

    const durationMs = Math.max(0, Date.now() - startedAt);
    const event = _normalizeEvent(payload, durationMs);

    // Standalone: not in active list (or unknown event)
    if (!activeRecord) {
      const lines = this.flush();
      lines.push(..._standaloneLines(event));
      return lines;
    }

    // Failure: always flush pending + emit error
    if (event.ok === false) {
      const lines = this.flush();
      lines.push(..._failureLines(event));
      return lines;
    }

    // Skill execution
    if (event.isSkill || event.category === 'skill') {
      const lines = this.flush();
      lines.push(_skillLine(event));
      return lines;
    }

    // Read / Search: aggregate adjacent calls
    if (event.ok === true && AGGREGATE_CATEGORIES.has(event.category)) {
      if (this._pending && this._pending.category !== event.category) {
        // Category changed — flush pending first
        const lines = this.flush();
        lines.push(..._aggregateStart(this, event));
        return lines;
      }
      return _aggregatePush(this, event);
    }

    // Mutation with diff
    if (event.category === 'mutation' && this._diffIds.has(id)) {
      this._diffIds.delete(id);
      return this.flush();
    }

    // Everything else: flush + success
    const lines = this.flush();
    lines.push(..._successLines(event));
    return lines;
  }

  /**
   * Record a diff summary for a mutation tool.
   *
   * @param {string} toolCallId
   * @param {string} filePath
   * @param {number} added
   * @param {number} removed
   * @returns {string[]}
   */
  recordDiff(toolCallId, filePath, added, removed) {
    this._diffIds.add(String(toolCallId));
    const lines = this.flush();
    const target = truncateTarget('', filePath, 80);
    lines.push(`已修改 ${target} · +${added} / -${removed} 行\n`);
    return lines;
  }

  /**
   * Flush pending aggregated group to output lines.
   *
   * @returns {string[]}
   */
  flush() {
    const group = this._pending;
    this._pending = null;

    if (!group) {
      return [];
    }

    const duration = formatDuration(group.durationMs);

    if (group.category === 'read') {
      const lineCount = group.metrics.line_count || 0;
      const metric = lineCount > 0 ? ` · ${lineCount} 行` : '';
      return [`已读取 ${group.count} 个文件${metric} · ${duration}\n`];
    }

    return [`已完成 ${group.count} 次搜索 · ${duration}\n`];
  }

  /**
   * Get current active tool status for live progress display.
   *
   * @returns {{ label: string, detail: string, count: number, startedAt: number }|null}
   */
  getActiveStatus() {
    if (this._active.size === 0) {
      return null;
    }

    const entries = Array.from(this._active.values());
    const events = entries.map((e) => e.event);

    // Parallel reads
    const categories = new Set(events.map((e) => e.category));
    if (events.length > 1 && categories.size === 1 && categories.has('read')) {
      return {
        label: `正在并行读取 ${events.length} 个文件`,
        detail: '',
        count: events.length,
        startedAt: Math.min(...entries.map((e) => e.startedAt)),
      };
    }

    // Single or mixed: show last event
    const last = events[events.length - 1];
    const target = truncateTarget('', last.target, 60);
    const cmd = last.command ? truncateTarget('', last.command, 40) : '';

    return {
      label: toolActionLabel(last.name) + (target ? `: ${target}` : ''),
      detail: cmd,
      count: events.length,
      startedAt: entries[entries.length - 1].startedAt,
    };
  }
}

// ─── Private helpers ────────────────────────────────────────────────────────

function _normalizeEvent(payload, durationMs) {
  const display = payload.display || payload;
  const category = _resolveCategory(display.category, payload.name);
  const metrics = {};

  if (typeof display.metrics === 'object' && display.metrics) {
    for (const [k, v] of Object.entries(display.metrics)) {
      if (typeof v === 'number' && v >= 0 && !Number.isNaN(v)) {
        metrics[k] = v;
      }
    }
  }

  return {
    id: String(payload.id || ''),
    name: String(payload.name || 'tool'),
    category,
    target: String(display.target || ''),
    command: String(display.command || ''),
    metrics,
    ok: typeof display.ok === 'boolean' ? display.ok : null,
    isSkill: !!display.isSkill,
    durationMs:
      typeof durationMs === 'number'
        ? durationMs
        : typeof display.duration_ms === 'number'
          ? display.duration_ms
          : 0,
  };
}

function _resolveCategory(rawCategory, toolName) {
  if (rawCategory) {
    return rawCategory;
  }
  const map = {
    Read: 'read',
    Glob: 'search',
    Grep: 'search',
    shellCommand: 'command',
    bash: 'command',
    powershell: 'command',
    cmd: 'command',
    Write: 'mutation',
    Edit: 'mutation',
  };
  return map[toolName] || 'other';
}

function _aggregatePush(aggregator, event) {
  if (!aggregator._pending) {
    aggregator._pending = {
      category: event.category,
      count: 0,
      durationMs: 0,
      metrics: {},
    };
  }

  aggregator._pending.count += 1;
  aggregator._pending.durationMs += event.durationMs;

  for (const [k, v] of Object.entries(event.metrics)) {
    aggregator._pending.metrics[k] = (aggregator._pending.metrics[k] || 0) + v;
  }

  return [];
}

function _standaloneLines(event) {
  if (event.ok === false) {
    return _failureLines(event);
  }
  return _successLines(event);
}

function _successLines(event) {
  const action = event.category === 'command' ? '命令执行完成' : '已' + toolActionLabel(event.name);
  const target =
    event.target && event.category !== 'command' ? ' ' + truncateTarget('', event.target, 120) : '';
  const lines = ['✓ ' + action + target + ' · ' + formatDuration(event.durationMs) + '\n'];

  if (event.command) {
    lines.push('  └─ ' + truncateTarget('', event.command, 120) + '\n');
  }

  return lines;
}

function _failureLines(event) {
  const target = truncateTarget('', event.target, 120);
  const lines = [
    '✗ ' + toolActionLabel(event.name) + '失败 · ' + formatDuration(event.durationMs) + '\n',
  ];

  if (event.command) {
    lines.push('  ├─ ' + truncateTarget('', event.command, 120) + '\n');
  }

  if (event.error_summary) {
    lines.push('  └─ ' + event.error_summary + '\n');
  } else if (target && !event.command) {
    lines.push('  └─ ' + target + '\n');
  }

  return lines;
}

function _skillLine(event) {
  return '✦ 使用技能：' + truncateTarget('', event.target, 120) + '\n';
}

function protocolErrorLine(reason) {
  return '✗ 未知工具事件 · ' + reason + '\n';
}

function toolActionLabel(toolName) {
  const map = {
    Read: '查看文件',
    Write: '写入文件',
    Edit: '修改文件',
    Glob: '查找文件',
    Grep: '搜索代码',
    shellCommand: '执行命令',
    bash: '执行 bash',
    powershell: '执行 PowerShell',
    cmd: '执行 CMD',
    List: '查看目录',
  };
  return map[toolName] || `使用 ${toolName}`;
}

// ─── Module exports ────────────────────────────────────────────────────────

module.exports = ToolProgressAggregator;
