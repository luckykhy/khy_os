import 'dart:convert';
import 'tool_engine.dart';

/// 文本协议工具调用解析器
/// 支持两种模式：
///   1. 原生 OpenAI function calling（tools 参数 + tool_calls 响应）
///   2. 纯文本协议 [TOOL_CALL: tool_name, {"arg": "value"}]
///
/// 自动检测：如果模型响应里有 tool_calls 字段 → 原生模式
///           否则 → 扫描文本里的 [TOOL_CALL:...] 标记
class ToolProtocol {
  /// 文本协议标记格式
  static final _toolCallPattern =
      RegExp(r'\[TOOL_CALL:\s*(\w+)\s*,\s*(\{.*?\})\]', dotAll: true);

  /// 系统提示词附加（告诉模型文本协议格式）
  static String get textProtocolInstructions => '''
## 工具调用协议

当需要调用工具时，在你的回复末尾按以下格式输出（独占一行）：

[TOOL_CALL: 工具名, {"参数名": "参数值"}]

示例：
[TOOL_CALL: open_app, {"query": "微信"}]
[TOOL_CALL: calculator, {"expression": "2+3*4"}]
[TOOL_CALL: web_search, {"query": "今天天气"}]

规则：
- 每次只输出一个 TOOL_CALL
- 参数必须是合法 JSON
- TOOL_CALL 标记独占一行，前后不留其他文字
- 执行结果会以 [TOOL_RESULT: 成功/失败, 输出内容] 形式返回给你
- 根据结果决定下一步或给出最终回答
''';

  /// 从模型文本输出中提取工具调用
  static List<ParsedToolCall> parse(String text) {
    final calls = <ParsedToolCall>[];
    for (final match in _toolCallPattern.allMatches(text)) {
      final name = match.group(1)!;
      final argsStr = match.group(2)!;
      Map<String, dynamic> args;
      try {
        args = jsonDecode(argsStr) as Map<String, dynamic>;
      } catch (_) {
        args = {};
      }
      calls.add(ParsedToolCall(name: name, args: args));
    }
    return calls;
  }

  /// 检测文本中是否包含工具调用
  static bool hasToolCall(String text) => _toolCallPattern.hasMatch(text);

  /// 清理文本：移除 TOOL_CALL 标记（用于展示给用户）
  static String stripToolCalls(String text) =>
      text.replaceAll(_toolCallPattern, '').trim();

  /// 构建工具结果回传文本
  static String formatToolResult(ToolResult result) {
    final status = result.success ? '成功' : '失败';
    return '[TOOL_RESULT: $status, ${result.output}]';
  }

  /// 判断是否需要使用文本协议（模型不支持原生 function calling）
  static bool needsTextProtocol(String model) {
    final m = model.toLowerCase();
    // 这些模型通常不支持原生 tools 参数
    if (m.contains('longcat')) return true;
    if (m.contains('agnes')) return true;
    if (m.contains('glm')) return true;
    if (m.contains('kimi')) return true;
    if (m.contains('deepseek')) return false; // 支持
    if (m.contains('gpt-4') || m.contains('gpt-5')) return false;
    if (m.contains('claude')) return false;
    if (m.contains('gemini')) return false;
    return true; // 默认用文本协议（安全）
  }
}

/// 解析出的工具调用
class ParsedToolCall {
  final String name;
  final Map<String, dynamic> args;
  const ParsedToolCall({required this.name, required this.args});
}

/// 工具调用执行结果（用于文本协议回传）
class ToolCallResult {
  final bool success;
  final String output;
  const ToolCallResult({required this.success, required this.output});
}
