/// 语义状态管理器
/// 手机内存有限，不能无限累积对话历史。
/// 策略：
///   1. 保留最近 N 轮完整对话
///   2. 更早的对话压缩为摘要
///   3. 维护一个任务状态对象（目标、已完成、待办、当前上下文）
///   4. 每轮对话更新状态，而非重新解析全部历史

/// 任务状态
class TaskState {
  final String goal;
  final List<String> completed;
  final List<String> pending;
  final String context; // 当前屏幕/应用等上下文
  final int round; // 第几轮
  final DateTime updatedAt;

  TaskState({
    required this.goal,
    this.completed = const [],
    this.pending = const [],
    this.context = '',
    this.round = 0,
    DateTime? updatedAt,
  }) : updatedAt = updatedAt ?? DateTime.now();

  TaskState copyWith({
    String? goal,
    List<String>? completed,
    List<String>? pending,
    String? context,
    int? round,
  }) {
    return TaskState(
      goal: goal ?? this.goal,
      completed: completed ?? this.completed,
      pending: pending ?? this.pending,
      context: context ?? this.context,
      round: round ?? this.round + 1,
    );
  }

  /// 生成给 LLM 的状态提示词
  String toPrompt() {
    final sb = StringBuffer('当前任务状态：\n');
    sb.writeln('目标: $goal');
    sb.writeln('已完成: ${completed.isEmpty ? "无" : completed.join(', ')}');
    sb.writeln('待办: ${pending.isEmpty ? "无" : pending.join(', ')}');
    if (context.isNotEmpty) sb.writeln('上下文: $context');
    sb.writeln('轮次: $round');
    return sb.toString();
  }

  /// 紧凑 JSON（用于持久化）
  Map<String, dynamic> toJson() => {
        'goal': goal,
        'completed': completed,
        'pending': pending,
        'context': context,
        'round': round,
        'updated': updatedAt.toIso8601String(),
      };

  factory TaskState.fromJson(Map<String, dynamic> json) => TaskState(
        goal: json['goal'] ?? '',
        completed:
            (json['completed'] as List?)?.cast<String>() ?? [],
        pending: (json['pending'] as List?)?.cast<String>() ?? [],
        context: json['context'] ?? '',
        round: json['round'] ?? 0,
        updatedAt:
            DateTime.tryParse(json['updated'] ?? '') ?? DateTime.now(),
      );
}

/// 对话压缩器
/// 将多轮对话压缩为摘要，减少 token 消耗
class ConversationCompressor {
  static const maxRecentTurns = 4; // 保留最近 4 轮完整对话

  /// 压缩对话历史
  /// [history] 完整的对话历史
  /// 返回：压缩后的历史（旧对话变摘要 + 新对话完整）
  static List<Map<String, dynamic>> compress(
    List<Map<String, dynamic>> history, {
    int maxTurns = 8,
  }) {
    if (history.length <= maxTurns * 2) {
      return history; // 不需要压缩
    }

    // 保留最近 maxTurns 轮（user+assistant 各一条）
    final recent = history.sublist(history.length - maxTurns * 2);

    // 旧对话压缩为摘要
    final old = history.sublist(0, history.length - maxTurns * 2);
    final summary = _summarize(old);

    return [
      {'role': 'system', 'content': summary},
      ...recent,
    ];
  }

  /// 简单摘要（取每轮 user 消息的前 50 字符 + assistant 的前 50 字符）
  static String _summarize(List<Map<String, dynamic>> messages) {
    final sb = StringBuffer('[历史摘要] ');
    var turnCount = 0;
    for (var i = 0; i < messages.length; i += 2) {
      final user = i < messages.length ? messages[i] : null;
      final assistant =
          (i + 1) < messages.length ? messages[i + 1] : null;
      if (user == null) break;

      final userText = (user['content'] ?? '').toString();
      final assistantText = (assistant?['content'] ?? '').toString();

      final userShort =
          userText.length > 50 ? '${userText.substring(0, 50)}...' : userText;
      final assistantShort = assistantText.length > 50
          ? '${assistantText.substring(0, 50)}...'
          : assistantText;

      sb.writeln();
      sb.writeln('第${turnCount + 1}轮: 用户「$userShort」 → AI「$assistantShort」');
      turnCount++;
    }
    sb.writeln();
    sb.write('以上为早期对话摘要，完整内容已省略。');
    return sb.toString();
  }
}

/// 设备状态快照（当前手机在做什么）
class DeviceSnapshot {
  final String activeApp;
  final String screenContent;
  final int timeSinceLastActionMs;
  final DateTime capturedAt;

  DeviceSnapshot({
    required this.activeApp,
    required this.screenContent,
    required this.timeSinceLastActionMs,
    DateTime? capturedAt,
  }) : capturedAt = capturedAt ?? DateTime.now();

  Map<String, dynamic> toJson() => {
        'active_app': activeApp,
        'screen': screenContent,
        'idle_ms': timeSinceLastActionMs,
        'captured_at': capturedAt.toIso8601String(),
      };

  /// 生成给 LLM 的上下文提示
  String toPrompt() {
    final sb = StringBuffer('[设备状态] ');
    if (activeApp.isNotEmpty) sb.write('当前应用: $activeApp ');
    if (screenContent.isNotEmpty) {
      sb.write('屏幕内容: ${screenContent.length > 100 ? screenContent.substring(0, 100) + '...' : screenContent} ');
    }
    if (timeSinceLastActionMs > 5000) {
      sb.write('(已空闲 ${timeSinceLastActionMs ~/ 1000}s)');
    }
    return sb.toString();
  }
}
