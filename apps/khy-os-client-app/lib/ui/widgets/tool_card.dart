import 'package:flutter/material.dart';
import '../../core/tools/tool_engine.dart';
import '../../core/agent/execution_log.dart';
import '../theme/app_colors.dart';

/// Structured data for a single tool execution card.
/// Immutable value object — create a new instance on every state transition.
class ToolCardData {
  /// Step index in the execution sequence (1-based)
  final int index;

  /// Raw tool name as registered in the engine (e.g. "exec_shell")
  final String toolName;

  /// Human-readable "verb + target" label for display (e.g. "执行命令: ls -la")
  final String label;

  /// Input arguments (displayed truncated in the card body)
  final Map<String, dynamic> args;

  /// Current execution state
  final ExecState state;

  /// Result output (populated on success)
  final String? output;

  /// Error message (populated on failure)
  final String? error;

  /// Execution duration in ms (null while running/queued)
  final int? durationMs;

  /// When this step started
  final DateTime timestamp;

  const ToolCardData({
    required this.index,
    required this.toolName,
    required this.label,
    required this.state,
    this.args = const {},
    this.output,
    this.error,
    this.durationMs,
    required this.timestamp,
  });

  // ─── Factories ─────────────────────────────────────────────────────

  /// Create a card in "running" state
  static ToolCardData running({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.running,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create a card in "success" state
  static ToolCardData success({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required String output,
    required int durationMs,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.success,
      output: output,
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create a card in "failed" state
  static ToolCardData failed({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required String error,
    required int durationMs,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.failed,
      error: error,
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create a card in "timeout" state
  static ToolCardData timeout({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required int durationMs,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.timeout,
      error: '执行超时',
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create from an [ExecutionStep]
  static ToolCardData fromStep(ExecutionStep step, String label) {
    final data = ToolCardData(
      index: step.index,
      toolName: step.toolName,
      label: label,
      args: step.args,
      state: step.state,
      output: step.output,
      error: step.error,
      timestamp: step.startTime,
    );
    return data.copyWith(durationMs: step.durationMs);
  }

  // ─── Immutability helpers ──────────────────────────────────────────

  ToolCardData copyWith({
    int? index,
    String? toolName,
    String? label,
    Map<String, dynamic>? args,
    ExecState? state,
    String? output,
    String? error,
    int? durationMs,
    DateTime? timestamp,
  }) {
    return ToolCardData(
      index: index ?? this.index,
      toolName: toolName ?? this.toolName,
      label: label ?? this.label,
      args: args ?? this.args,
      state: state ?? this.state,
      output: output ?? this.output,
      error: error ?? this.error,
      durationMs: durationMs ?? this.durationMs,
      timestamp: timestamp ?? this.timestamp,
    );
  }

  bool get isCompleted =>
      state == ExecState.success ||
      state == ExecState.failed ||
      state == ExecState.timeout;

  bool get isRunning => state == ExecState.running;

  /// Status badge text
  String get statusText {
    switch (state) {
      case ExecState.queued:
        return '排队中';
      case ExecState.running:
        return '执行中';
      case ExecState.success:
        return '${durationMs ?? 0}ms';
      case ExecState.failed:
        return '失败';
      case ExecState.timeout:
        return '超时';
    }
  }

  // ─── Serialization ────────────────────────────────────────────────

  Map<String, dynamic> toJson() => {
        'index': index,
        'tool': toolName,
        'label': label,
        'args': args,
        'state': state.name,
        if (output != null) 'output': output,
        if (error != null) 'error': error,
        if (durationMs != null) 'duration_ms': durationMs,
        'timestamp': timestamp.toIso8601String(),
      };

  factory ToolCardData.fromJson(Map<String, dynamic> json) {
    return ToolCardData(
      index: json['index'] as int? ?? 0,
      toolName: json['tool'] as String? ?? '',
      label: json['label'] as String? ?? json['tool'] as String? ?? '',
      args: (json['args'] as Map<String, dynamic>?) ?? {},
      state: ExecState.values.firstWhere(
        (e) => e.name == json['state'],
        orElse: () => ExecState.queued,
      ),
      output: json['output'] as String?,
      error: json['error'] as String?,
      durationMs: json['duration_ms'] as int?,
      timestamp:
          json['timestamp'] != null
              ? DateTime.parse(json['timestamp'] as String)
              : DateTime.now(),
    );
  }

  @override
  String toString() =>
      'ToolCardData(#$index $toolName $state ${durationMs ?? '-'}ms)';
}

// ═══════════════════════════════════════════════════════════════════════
// Widget
// ═══════════════════════════════════════════════════════════════════════

/// A structured card that displays a single tool execution.
///
/// Usage:
/// ```
/// ToolCard(data: ToolCardData.running(index: 1, ...))
/// ```
class ToolCard extends StatelessWidget {
  final ToolCardData data;
  final bool expandable;

  const ToolCard({
    super.key,
    required this.data,
    this.expandable = true,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final body = data.isCompleted;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: _borderColor(cs),
          width: 1.2,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Header row ──
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                _statusIcon(data.state, cs),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    data.label,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                // Duration / status badge
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: _badgeColor(data.state, cs).withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    data.statusText,
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w500,
                      color: _badgeColor(data.state, cs),
                    ),
                  ),
                ),
                if (expandable && body) ...[
                  const SizedBox(width: 4),
                  Icon(Icons.expand_more, size: 16, color: cs.outline),
                ],
              ],
            ),
          ),

          // ── Body (args + output/error) ──
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (data.args.isNotEmpty)
                  _argsRow(data.args, cs),
                if (data.output != null && data.state == ExecState.success)
                  _outputSection(data.output!, cs),
                if (data.error != null)
                  _errorSection(data.error!, cs),
                if (data.isRunning)
                  _runningIndicator(cs),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── Status icon ───────────────────────────────────────────────────

  Widget _statusIcon(ExecState state, ColorScheme cs) {
    switch (state) {
      case ExecState.queued:
        return Icon(Icons.schedule, size: 18, color: cs.outline);
      case ExecState.running:
        return SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: cs.primary,
          ),
        );
      case ExecState.success:
        return Icon(Icons.check_circle, size: 18, color: AppColors.success);
      case ExecState.failed:
        return Icon(Icons.error, size: 18, color: AppColors.error);
      case ExecState.timeout:
        return Icon(Icons.timer_off, size: 18, color: AppColors.warning);
    }
  }

  // ── Args row ──────────────────────────────────────────────────────

  Widget _argsRow(Map<String, dynamic> args, ColorScheme cs) {
    final text = args.entries
        .map((e) => '${e.key}: ${e.value}')
        .join('  ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text.length > 80 ? '${text.substring(0, 80)}...' : text,
        style: TextStyle(fontSize: 11, color: cs.onSurface.withValues(alpha: 0.45)),
      ),
    );
  }

  // ── Output section ────────────────────────────────────────────────

  Widget _outputSection(String output, ColorScheme cs) {
    final truncated =
        output.length > 200 ? output.substring(0, 200) + '…' : output;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: double.infinity),
      child: Text(
        truncated,
        style: TextStyle(
          fontSize: 12,
          color: cs.onSurface.withValues(alpha: 0.7),
          height: 1.4,
          fontFamily: 'monospace',
        ),
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  // ── Error section ─────────────────────────────────────────────────

  Widget _errorSection(String error, ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: AppColors.error.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        error.length > 200 ? '${error.substring(0, 200)}…' : error,
        style: const TextStyle(
          fontSize: 12,
          color: AppColors.error,
          height: 1.4,
        ),
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  // ── Running indicator ─────────────────────────────────────────────

  Widget _runningIndicator(ColorScheme cs) {
    return Row(
      children: [
        SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary),
        ),
        const SizedBox(width: 6),
        Text(
          '执行中...',
          style: TextStyle(fontSize: 11, color: cs.onSurface.withValues(alpha: 0.5)),
        ),
      ],
    );
  }

  // ── Colors ────────────────────────────────────────────────────────

  Color _borderColor(ColorScheme cs) {
    switch (data.state) {
      case ExecState.success:
        return AppColors.success.withValues(alpha: 0.3);
      case ExecState.failed:
        return AppColors.error.withValues(alpha: 0.3);
      case ExecState.timeout:
        return AppColors.warning.withValues(alpha: 0.3);
      default:
        return cs.outlineVariant.withValues(alpha: 0.3);
    }
  }

  Color _badgeColor(ExecState state, ColorScheme cs) {
    switch (state) {
      case ExecState.success:
        return AppColors.success;
      case ExecState.failed:
        return AppColors.error;
      case ExecState.timeout:
        return AppColors.warning;
      case ExecState.running:
        return cs.primary;
      case ExecState.queued:
        return cs.outline;
    }
  }
}

/// A summary strip showing the overall execution progress.
/// Displays above the individual cards when multiple tools are running.
class ToolExecutionSummary extends StatelessWidget {
  final List<ToolCardData> cards;

  const ToolExecutionSummary({super.key, required this.cards});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    if (cards.isEmpty) return const SizedBox.shrink();

    final total = cards.length;
    final done = cards.where((c) => c.isCompleted).length;
    final failed = cards.where((c) => c.state == ExecState.failed).length;
    final running = cards.any((c) => c.isRunning);

        final totalMs =
        cards.map((c) => c.durationMs ?? 0).fold<int>(0, (a, b) => a + b);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.2)),
      ),
      child: Row(
        children: [
          if (running)
            SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary),
            )
          else
            Icon(
              failed > 0 ? Icons.error_outline : Icons.check_circle_outline,
              size: 14,
              color: failed > 0 ? AppColors.error : AppColors.success,
            ),          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '工具执行 $done/$total'
              '${failed > 0 ? " · ${failed} 失败" : ""}',
              style:
                  TextStyle(fontSize: 12, color: cs.onSurface.withValues(alpha: 0.6)),
            ),
          ),
          if (!running && total > 0)
            Text(
              '${totalMs ~/ 1000}.${(totalMs % 1000) ~/ 100}s',
              style:
                  TextStyle(fontSize: 11, color: cs.onSurface.withValues(alpha: 0.4)),
            ),
        ],
      ),
    );
  }
}
