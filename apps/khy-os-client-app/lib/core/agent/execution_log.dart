import 'dart:convert';

/// 工具执行生命周期
enum ExecState { queued, running, success, failed, timeout }

/// 单次工具执行记录
class ExecutionStep {
  final int index;
  final String toolName;
  final Map<String, dynamic> args;
  ExecState state;
  String? output;
  String? error;
  DateTime startTime;
  DateTime? endTime;
  final Map<String, dynamic> metadata;

  ExecutionStep({
    required this.index,
    required this.toolName,
    required this.args,
    this.state = ExecState.queued,
    this.metadata = const {},
  }) : startTime = DateTime.now();

  /// 标记开始执行
  void start() {
    state = ExecState.running;
    startTime = DateTime.now();
  }

  /// 标记成功
  void complete(String output, {Map<String, dynamic>? extra}) {
    state = ExecState.success;
    this.output = output;
    endTime = DateTime.now();
    if (extra != null) metadata.addAll(extra);
  }

  /// 标记失败
  void fail(String error, {Map<String, dynamic>? extra}) {
    state = ExecState.failed;
    this.error = error;
    endTime = DateTime.now();
    if (extra != null) metadata.addAll(extra);
  }

  /// 耗时（毫秒）
  int get durationMs =>
      endTime != null ? endTime!.difference(startTime).inMilliseconds : 0;

  /// 人类可读摘要
  String get summary {
    switch (state) {
      case ExecState.queued:
        return '排队中';
      case ExecState.running:
        return '执行中...';
      case ExecState.success:
        return '成功 (${durationMs}ms)';
      case ExecState.failed:
        return '失败 (${durationMs}ms): $error';
      case ExecState.timeout:
        return '超时';
    }
  }

  Map<String, dynamic> toJson() => {
        'index': index,
        'tool': toolName,
        'args': args,
        'state': state.name,
        if (output != null) 'output': output,
        if (error != null) 'error': error,
        'start': startTime.toIso8601String(),
        if (endTime != null) 'end': endTime!.toIso8601String(),
        'duration_ms': durationMs,
      };
}

/// 一次完整对话的执行日志
class ExecutionLog {
  final String conversationId;
  final String userMessage;
  final List<ExecutionStep> steps;
  final DateTime created;
  bool complete;
  String? finalResult;
  DateTime? finishedAt;

  ExecutionLog({
    required this.conversationId,
    required this.userMessage,
    List<ExecutionStep>? steps,
    this.complete = false,
    this.finalResult,
  })  : steps = steps ?? [],
        created = DateTime.now();

  /// 添加一个步骤
  int addStep(String toolName, Map<String, dynamic> args) {
    final step = ExecutionStep(
      index: steps.length + 1,
      toolName: toolName,
      args: args,
    );
    steps.add(step);
    return steps.length - 1; // return index
  }

  /// 标记完成
  void finish(String result) {
    complete = true;
    finalResult = result;
    finishedAt = DateTime.now();
  }

  /// 标记失败（整体执行失败）
  void fail(String reason) {
    complete = true;
    finalResult = '失败：$reason';
    finishedAt = DateTime.now();
  }

  /// 总耗时
  int get totalDurationMs =>
      finishedAt != null ? finishedAt!.difference(created).inMilliseconds : 0;

  /// 成功步骤数
  int get successCount =>
      steps.where((s) => s.state == ExecState.success).length;

  /// 失败步骤数
  int get failCount =>
      steps.where((s) => s.state == ExecState.failed).length;

  /// 进度描述（用于 UI）
  String get progressText {
    if (complete) {
      return '完成：${successCount} 成功 / ${failCount} 失败 (${totalDurationMs}ms)';
    }
    if (steps.isEmpty) return '等待中';
    return '步骤 ${steps.length}：${steps.last.toolName} ${steps.last.summary}';
  }

  /// JSON（用于远程上报或导出）
  Map<String, dynamic> toJson() => {
        'conversation_id': conversationId,
        'user_message': userMessage,
        'created': created.toIso8601String(),
        if (finishedAt != null) 'finished_at': finishedAt!.toIso8601String(),
        'complete': complete,
        'total_ms': totalDurationMs,
        'success': successCount,
        'failed': failCount,
        if (finalResult != null) 'result': finalResult,
        'steps': steps.map((s) => s.toJson()).toList(),
      };

  String get json => jsonEncode(toJson());

  /// 人类可读摘要（用于日志导出）
  String toText() {
    final sb = StringBuffer();
    sb.writeln('=== 执行日志 ${conversationId} ===');
    sb.writeln('用户: $userMessage');
    sb.writeln('开始: ${created.toIso8601String()}');
    for (final s in steps) {
      sb.writeln(
          '  ${s.index}. ${s.toolName} ${s.summary} ${s.args.isNotEmpty ? jsonEncode(s.args) : ""}');
      if (s.output != null) sb.writeln('     输出: ${s.output}');
      if (s.error != null) sb.writeln('     错误: ${s.error}');
    }
    if (complete) {
      sb.writeln('结果: $finalResult');
      sb.writeln('耗时: ${totalDurationMs}ms');
    }
    return sb.toString();
  }
}
