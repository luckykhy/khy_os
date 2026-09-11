import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/config/app_config.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/network/dns_resolver.dart';
import '../../core/network/network_autofix.dart';
import '../../core/services/app_logger.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/tools/tool_engine.dart';
import '../../core/tools/builtin_tools.dart';
import '../../core/tools/tool_protocol.dart';
import '../../core/agent/execution_log.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/widgets/tool_card.dart';

/// Agent task execution screen - uses real ToolEngine + AI API.
/// Unified with chat: same tool execution, same card display.
class AgentScreenNew extends ConsumerStatefulWidget {
  final KhyOsApi? api;
  const AgentScreenNew({super.key, this.api});

  @override
  ConsumerState<AgentScreenNew> createState() => _AgentScreenNewState();
}

class _AgentScreenNewState extends ConsumerState<AgentScreenNew> {
  final _taskInput = TextEditingController();
  final _scroll = ScrollController();
  late final ToolEngine _toolEngine;
  late final Dio _dio;
  final _logger = AppLogger();

  // Tool execution state
  final List<ToolCardData> _toolCards = [];
  String _status = '就绪';
  String _result = '';
  bool _running = false;
  AppConfigData? _cfg;

  // Suggested tasks
  static const _suggestedTasks = [
    '帮我打开微信',
    '截屏并分析当前屏幕',
    '打开百度搜索 "Flutter 教程"',
    '检查设备内存使用',
  ];

  @override
  void initState() {
    super.initState();
    _toolEngine = ToolEngine();
    _toolEngine.registerAll(createBuiltinTools());
    _dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(minutes: 3),
    ));
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    final config = await AppConfig.load();
    if (mounted) setState(() => _cfg = config.effective);
  }

  @override
  void dispose() {
    _taskInput.dispose();
    _scroll.dispose();
    _dio.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _header(cs),
            Expanded(
              child: _toolCards.isEmpty && !_running
                  ? _emptyState(cs)
                  : _executionView(cs),
            ),
            _inputBar(cs),
          ],
        ),
      ),
    );
  }

  // ── Header ────────────────────────────────────────────────────────

  Widget _header(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: cs.surface,
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 4,
              offset: const Offset(0, 2)),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                  colors: [cs.primary, cs.tertiary]),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Center(
              child: Icon(Icons.smart_toy, size: 18, color: Colors.white),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Agent 模式',
                    style: TextStyle(
                        fontSize: 15, fontWeight: FontWeight.bold)),
                Text(
                  _status,
                  style: TextStyle(
                      fontSize: 11,
                      color: cs.onSurface.withValues(alpha: 0.5)),
                ),
              ],
            ),
          ),
          if (_cfg != null)
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: cs.surfaceVariant,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                _cfg!.model,
                style:
                    TextStyle(fontSize: 10, color: cs.onSurface.withValues(alpha: 0.5)),
              ),
            ),
        ],
      ),
    );
  }

  // ── Empty state ─────────────────────────────────────────────────

  Widget _emptyState(ColorScheme cs) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 80,
            height: 80,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                  colors: [
                    AppColors.primary.withValues(alpha: 0.15),
                    AppColors.accent.withValues(alpha: 0.15)
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight),
              borderRadius: BorderRadius.circular(20),
            ),
            child:
                const Icon(Icons.auto_awesome, size: 40, color: AppColors.primary),
          ),
          const SizedBox(height: 16),
          Text('AI Agent',
              style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: cs.onSurface)),
          const SizedBox(height: 8),
          Text(
            '输入任务，Agent 自动规划并执行工具',
            textAlign: TextAlign.center,
            style:
                TextStyle(fontSize: 13, color: cs.onSurface.withValues(alpha: 0.5)),
          ),
          const SizedBox(height: 20),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final task in _suggestedTasks)
                _taskChip(task, cs),
            ],
          ),
        ],
      ),
    );
  }

  Widget _taskChip(String task, ColorScheme cs) {
    return GestureDetector(
      onTap: () {
        _taskInput.text = task;
        _runTask();
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: cs.surfaceVariant,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.4)),
        ),
        child: Text(
          task,
          style: TextStyle(fontSize: 12, color: cs.onSurface.withValues(alpha: 0.7)),
        ),
      ),
    );
  }

  // ── Execution view (cards + result) ─────────────────────────────

  Widget _executionView(ColorScheme cs) {
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.all(16),
      children: [
        if (_toolCards.isNotEmpty)
          ToolExecutionSummary(cards: _toolCards),
        for (final card in _toolCards)
          ToolCard(data: card),
        if (_result.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.success.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                    color: AppColors.success.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.check_circle, color: AppColors.success, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _result,
                      style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface),
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (_running)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Row(
              children: [
                SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 8),
                Text('执行中...',
                    style:
                        TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
      ],
    );
  }

  // ── Input bar ───────────────────────────────────────────────────

  Widget _inputBar(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 4,
              offset: const Offset(0, -2)),
        ],
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _taskInput,
              enabled: !_running,
              decoration: InputDecoration(
                hintText: '输入任务，如: 打开微信',
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide(color: cs.outlineVariant.withValues(alpha: 0.4)),
                ),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                isDense: true,
              ),
              onSubmitted: (_) => _runTask(),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: _running ? null : _runTask,
            child: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: _running ? cs.outlineVariant : cs.primary,
                shape: BoxShape.circle,
              ),
              child: Icon(
                _running ? Icons.hourglass_empty : Icons.play_arrow,
                color: _running ? Colors.white : Colors.white,
                size: 20,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Task execution (unified with chat's agent loop) ────────────

  Future<void> _runTask() async {
    final task = _taskInput.text.trim();
    if (task.isEmpty || _running) return;

    if (_cfg == null || !_cfg!.isConfigured) {
      setState(() {
        _status = '未配置 API';
        _result = '请先在设置页配置 API 地址和密钥';
      });
      return;
    }

    setState(() {
      _running = true;
      _toolCards.clear();
      _result = '';
      _status = '执行中';
    });

    final execLog = ExecutionLog(
      conversationId: 'agent_${DateTime.now().millisecondsSinceEpoch}',
      userMessage: task,
    );

    try {
      // Build system prompt
      final systemPrompt = _buildAgentSystemPrompt();
      final messages = <Map<String, dynamic>>[
        {'role': 'system', 'content': systemPrompt},
        {'role': 'user', 'content': task},
      ];

      final useTextProtocol = ToolProtocol.needsTextProtocol(_cfg!.model);

      // Agent loop (same as chat, max 8 steps)
      for (var loop = 0; loop < 8; loop++) {
        final response = await _callLLM(messages, useTextProtocol);
        final content =
            response['choices']?.first?['message']?['content'] ?? '';
        final toolCalls = _extractToolCalls(
            response['choices']?.first?['message']?['tool_calls'], useTextProtocol, content);

        if (toolCalls.isEmpty) {
          _result = content;
          execLog.finish(content);
          break;
        }

        for (final tc in toolCalls) {
          final toolName = tc.name;
          final args = tc.args;
          final label = _getToolLabel(toolName, args);

          // Create card (running)
          final stepIdx = execLog.addStep(toolName, args);
          final step = execLog.steps[stepIdx];
          step.start();

          final cardData = ToolCardData.running(
            index: step.index,
            toolName: toolName,
            label: label,
            args: args,
          );
          _toolCards.add(cardData);
          if (mounted) setState(() {});

          // Execute tool
          final start = DateTime.now();
          final result = await _toolEngine.execute(toolName, args);
          final elapsed = DateTime.now().difference(start).inMilliseconds;

          // Record
          if (result.success) {
            step.complete(result.output);
          } else {
            step.fail(result.output);
          }

          // Update card
          final updatedCard = result.success
              ? ToolCardData.success(
                  index: step.index,
                  toolName: toolName,
                  label: label,
                  args: args,
                  output: result.output,
                  durationMs: elapsed,
                )
              : ToolCardData.failed(
                  index: step.index,
                  toolName: toolName,
                  label: label,
                  args: args,
                  error: result.output,
                  durationMs: elapsed,
                );
          _toolCards.last = updatedCard;
          if (mounted) setState(() {});

          // Feed back to LLM
          if (useTextProtocol) {
            messages.add({
              'role': 'user',
              'content': ToolProtocol.formatToolResult(result),
            });
          } else {
            messages.add({
              'tool_call_id': '${DateTime.now().millisecondsSinceEpoch}',
              'role': 'tool',
              'content': result.jsonOutput,
            });
          }
        }
      }

      if (_result.isEmpty) {
        _result = '任务完成';
        execLog.finish('done');
      }
      _logExecution(execLog);
    } on DioException catch (e) {
      final msg = e.response?.statusCode == 401
          ? 'API key 无效或过期 (401)，请检查设置'
          : e.response?.statusCode == 429
              ? '限流 (429)，请求过多，请稍后重试'
              : '网络错误: ${e.message}';
      setState(() {
        _status = '错误';
        _result = msg;
      });
      execLog.fail(msg);
      _logExecution(execLog);
    } catch (e) {
      setState(() {
        _status = '错误';
        _result = '发生错误: $e';
      });
      execLog.fail('$e');
      _logExecution(execLog);
    } finally {
      if (mounted) {
        setState(() {
          _running = false;
          if (_status != '错误') _status = '完成';
        });
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    }
  }

  // ── LLM call ────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _callLLM(
      List<Map<String, dynamic>> messages, bool includeTools) async {
    final tools = _toolEngine.toFunctionSchemas();
    final data = {
      'model': _cfg!.model,
      'messages': messages,
      'temperature': 0.7,
      'max_tokens': 4096,
      if (includeTools && tools.isNotEmpty) 'tools': tools,
    };

    final resp = await _dio.post(
      '${_cfg!.baseUrl}/chat/completions',
      data: data,
      options: Options(
        headers: {'Authorization': 'Bearer ${_cfg!.effectiveApiKey}'},
      ),
    );
    return resp.data as Map<String, dynamic>;
  }

  List<ParsedToolCall> _extractToolCalls(
      dynamic toolCallsRaw, bool useTextProtocol, String content) {
    if (!useTextProtocol && toolCallsRaw is List && toolCallsRaw.isNotEmpty) {
      // Native function calling
      return toolCallsRaw.map((tc) {
        final fn = tc['function'] as Map<String, dynamic>? ?? {};
        final name = fn['name'] ?? '';
        Map<String, dynamic> args = {};
        try {
          final argsJson = fn['arguments'];
          if (argsJson is String && argsJson.isNotEmpty) {
            args = jsonDecode(argsJson) as Map<String, dynamic>;
          }
        } catch (_) {}
        return ParsedToolCall(name: name, args: args);
      }).toList();
    }

    // Text protocol fallback
    if (useTextProtocol && ToolProtocol.hasToolCall(content)) {
      return ToolProtocol.parse(content);
    }

    return [];
  }

  // ── Agent system prompt ─────────────────────────────────────────

  String _buildAgentSystemPrompt() {
    final buf = StringBuffer();
    buf.writeln('你是一个 Android 手机操作 Agent。');
    buf.writeln('用户给你任务，你通过调用工具来完成任务。');
    buf.writeln('');
    buf.writeln('## 可用工具');
    for (final tool in _toolEngine.allTools) {
      buf.writeln('- ${tool.name}: ${tool.description}');
    }
    buf.writeln('');
    buf.writeln('## 规则（必须遵守）');
    buf.writeln('- 打开应用/网址：只用 open_app（传中文名或包名），不要试 execute_skill');
    buf.writeln('- 如果 open_app 返回"未安装"，直接告知用户，不要再调 search_apps 或重试');
    buf.writeln('- 一个任务最多调 3 个工具，失败就告知结果，不要死循环');
    buf.writeln('- 任务完成后直接输出简短结果');
    buf.writeln('');
    buf.writeln(ToolProtocol.textProtocolInstructions);
    return buf.toString();
  }

  // ── Tool label (verb + target) ──────────────────────────────────

  String _getToolLabel(String toolName, Map<String, dynamic> args) {
    switch (toolName) {
      case 'open_app':
        return '打开应用: ${args['query'] ?? ''}';
      case 'open_url':
        return '打开网址: ${args['url'] ?? ''}';
      case 'search_apps':
        return '搜索应用: ${args['query'] ?? ''}';
      case 'read_clipboard':
        return '读取剪贴板';
      case 'write_clipboard':
        return '写入剪贴板';
      case 'calculator':
        return '计算: ${args['expression'] ?? ''}';
      case 'device_info':
        return '获取设备信息';
      case 'execute_skill':
        return '执行技能: ${args['skill_name'] ?? ''}';
      case 'a11y_tap':
        return '点击: (${args['x'] ?? 0}, ${args['y'] ?? 0})';
      case 'a11y_find_and_click':
        return '查找并点击: ${args['query'] ?? ''}';
      case 'a11y_dump_ui':
        return '获取屏幕 UI 树';
      case 'a11y_list_clickable':
        return '列出可点击元素';
      case 'a11y_type_text':
        return '输入文字: ${args['text'] ?? ''}';
      case 'a11y_global_action':
        return '全局操作: ${args['action'] ?? ''}';
      case 'capture_screen':
        return '截屏';
      case 'analyze_screen':
        return '视觉分析: ${args['prompt'] ?? ''}';
      case 'exec_shell':
        return '执行命令: ${args['command'] ?? ''}';
      case 'web_search':
        return '联网搜索: ${args['query'] ?? ''}';
      case 'web_fetch':
        return '抓取: ${args['url'] ?? ''}';
      default:
        return '执行: $toolName';
    }
  }

  // ── Logging ─────────────────────────────────────────────────────

  void _logExecution(ExecutionLog log) {
    _logger.d(LogCategory.system, 'Agent 执行: ${log.userMessage} → ${log.finalResult ?? "N/A"}');
  }
}
