import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import '../tools/tool_engine.dart';
import '../config/app_config.dart';

/// Agent execution phases
enum AgentPhase { planning, executing, reflecting, complete, error }

/// Agent step result
class AgentStep {
  final int step;
  final AgentPhase phase;
  final String? thought;
  final String? toolName;
  final Map<String, dynamic>? toolArgs;
  final ToolResult? toolResult;
  final String? error;

  const AgentStep({
    required this.step,
    required this.phase,
    this.thought,
    this.toolName,
    this.toolArgs,
    this.toolResult,
    this.error,
  });
}

/// Agent run result
class AgentRunResult {
  final bool success;
  final String summary;
  final List<AgentStep> steps;
  final int totalSteps;

  const AgentRunResult({
    required this.success,
    required this.summary,
    required this.steps,
    required this.totalSteps,
  });
}

/// Multi-step Agent loop (inspired by Roubao MobileAgent)
///
/// Flow: User message → Plan → Execute tool → Reflect → Loop or finish
class AgentLoop {
  final ToolEngine _engine;
  final AppConfigData _config;
  final Dio _dio;

  static const int maxSteps = 15;
  static const Duration stepTimeout = Duration(seconds: 30);

  AgentLoop({required ToolEngine engine, required AppConfigData config})
      : _engine = engine,
        _config = config,
        _dio = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(minutes: 3),
        ));

  /// Run the agent loop
  Stream<AgentStep> run(String userMessage) async* {
    final messages = <Map<String, dynamic>>[
      {
        'role': 'system',
        'content': _buildSystemPrompt(),
      },
      {'role': 'user', 'content': userMessage},
    ];

    for (var step = 0; step < maxSteps; step++) {
      // 1. Call LLM to plan next action
      yield AgentStep(step: step, phase: AgentPhase.planning);

      final response = await _callLLM(messages);
      if (response == null) {
        yield AgentStep(step: step, phase: AgentPhase.error, error: 'LLM 调用失败');
        return;
      }

      final choice = response['choices']?[0];
      final message = choice?['message'];
      final content = message?['content'] ?? '';
      final toolCalls = message?['tool_calls'] as List?;

      // 2. If no tool calls, agent is done
      if (toolCalls == null || toolCalls.isEmpty) {
        yield AgentStep(
          step: step,
          phase: AgentPhase.complete,
          thought: content,
        );
        return;
      }

      // 3. Execute each tool call
      messages.add({
        'role': 'assistant',
        'content': content,
        'tool_calls': toolCalls,
      });

      for (final tc in toolCalls) {
        final fn = tc['function'] ?? {};
        final toolName = fn['name'] ?? '';
        final argsStr = fn['arguments'] ?? '{}';

        Map<String, dynamic> args;
        try {
          args = jsonDecode(argsStr) as Map<String, dynamic>;
        } catch (_) {
          args = {};
        }

        yield AgentStep(
          step: step,
          phase: AgentPhase.executing,
          thought: content,
          toolName: toolName,
          toolArgs: args,
        );

        // Execute the tool
        final result = await _engine.execute(toolName, args);

        yield AgentStep(
          step: step,
          phase: AgentPhase.reflecting,
          toolName: toolName,
          toolArgs: args,
          toolResult: result,
        );

        // Add tool result to messages
        messages.add({
          'tool_call_id': tc['id'] ?? '',
          'role': 'tool',
          'content': result.jsonOutput,
        });
      }
    }

    // Max steps reached
    yield AgentStep(
      step: maxSteps,
      phase: AgentPhase.complete,
      thought: '已达到最大步骤数 ($maxSteps)，任务可能未完全完成。',
    );
  }

  String _buildSystemPrompt() {
    final toolSchemas = _engine.allTools.map((t) =>
      '- ${t.name}: ${t.description}'
    ).join('\n');

    return '''你是 khy-os AI 助手，运行在用户的 Android 手机上。

你的核心能力：
1. 理解用户意图并规划执行步骤
2. 调用手机工具完成任务（打开应用、操作剪贴板、计算等）
3. 根据工具执行结果决定下一步

可用工具：
$toolSchemas

执行策略：
- 对于简单请求（打开某个APP、计算等），直接调用一次工具即可
- 对于复杂请求（多步操作），分步调用工具
- 每次工具调用后，根据结果决定是否需要继续
- 如果工具执行失败，尝试替代方案或告知用户

输出规则：
- 在调用工具前，简要说明你要做什么
- 工具调用使用 function calling 格式
- 完成后给出简洁的中文总结''';
  }

  /// Call the LLM API with tool support
  Future<Map<String, dynamic>?> _callLLM(List<Map<String, dynamic>> messages) async {
    try {
      final tools = _engine.toFunctionSchemas();
      final data = {
        'model': _config.model,
        'messages': messages,
        'temperature': 0.7,
        'max_tokens': 4096,
        if (tools.isNotEmpty) 'tools': tools,
      };

      final resp = await _dio.post(
        '${_config.baseUrl}/chat/completions',
        data: data,
        options: Options(
          headers: {
            'Authorization': 'Bearer ${_config.apiKey}',
            'Content-Type': 'application/json',
          },
        ),
      );

      return resp.data as Map<String, dynamic>;
    } catch (e) {
      return null;
    }
  }
}
