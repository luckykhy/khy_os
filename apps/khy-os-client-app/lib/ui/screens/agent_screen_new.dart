import 'package:flutter/material.dart';
import '../../core/tools/tool_engine.dart' show ToolResult;
import '../../ui/theme/app_colors.dart';

/// Agent execution view - shows step-by-step tool calling
class AgentScreenNew extends StatefulWidget {
  const AgentScreenNew({super.key});

  @override
  State<AgentScreenNew> createState() => _AgentScreenNewState();
}

class _AgentScreenNewState extends State<AgentScreenNew> {
  final List<_AgentStep> _steps = [];
  bool _running = false;
  String _result = '';

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Container(
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
                          colors: [AppColors.primary, AppColors.accent]),
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
                        Text(_running ? '执行中...' : '就绪',
                            style: TextStyle(
                                fontSize: 11,
                                color: cs.onSurface.withValues(alpha: 0.5))),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            // Body
            Expanded(
              child: _steps.isEmpty
                  ? _emptyState(cs)
                  : _timeline(cs),
            ),
            // Action bar
            if (_steps.isEmpty)
              _actionBar(cs),
          ],
        ),
      ),
    );
  }

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
            child: const Icon(Icons.auto_awesome, size: 40, color: AppColors.primary),
          ),
          const SizedBox(height: 16),
          Text('AI Agent',
              style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: cs.onSurface)),
          const SizedBox(height: 8),
          Text(
            '自动操作手机完成复杂任务\n多步规划 → 工具执行 → 结果反思',
            textAlign: TextAlign.center,
            style: TextStyle(
                fontSize: 13, color: cs.onSurface.withValues(alpha: 0.5), height: 1.5),
          ),
          const SizedBox(height: 20),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              _featureChip('📋 任务规划', cs),
              _featureChip('⚙️ 工具调用', cs),
              _featureChip('👁️ 屏幕理解', cs),
              _featureChip('🔄 多步执行', cs),
            ],
          ),
        ],
      ),
    );
  }

  Widget _featureChip(String label, ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: cs.surfaceVariant,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.4)),
      ),
      child: Text(label,
          style: TextStyle(
              fontSize: 12, color: cs.onSurface.withValues(alpha: 0.7))),
    );
  }

  Widget _actionBar(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: cs.surface,
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 4,
              offset: const Offset(0, -2)),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: _demoTask(cs, '帮我打开微信并发送"你好"'),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _demoTask(cs, '截屏并描述当前内容'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _demoTask(ColorScheme cs, String task) {
    return GestureDetector(
      onTap: () {
        setState(() {
          _running = true;
          _steps.clear();
        });
        _runDemo(task);
      },
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: cs.surfaceVariant,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.play_arrow, size: 16, color: cs.primary),
            const SizedBox(width: 6),
            Expanded(
              child: Text(task,
                  style: TextStyle(
                      fontSize: 12,
                      color: cs.onSurface.withValues(alpha: 0.7)),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _runDemo(String task) async {
    // Simulate agent steps
    await Future.delayed(const Duration(milliseconds: 800));
    setState(() => _steps.add(_AgentStep(
      step: 1,
      phase: 'planning',
      thought: '分析任务: "$task"，需要执行多个步骤',
    )));

    await Future.delayed(const Duration(milliseconds: 600));
    setState(() => _steps.add(_AgentStep(
      step: 2,
      phase: 'executing',
      toolName: 'execute_skill',
      toolArgs: {'skill': 'open-wechat'},
    )));

    await Future.delayed(const Duration(milliseconds: 600));
    setState(() {
      final s = _steps.last;
      s.toolResult = ToolResult.ok('已打开 微信');
      _steps.add(_AgentStep(
        step: 3,
        phase: 'executing',
        toolName: 'a11y_type_text',
        toolArgs: {'text': '你好'},
      ));
    });

    await Future.delayed(const Duration(milliseconds: 600));
    setState(() {
      _steps.last.toolResult = ToolResult.ok('已输入文字');
      _result = '任务完成：已打开微信并输入"你好"';
      _running = false;
    });
  }

  Widget _timeline(ColorScheme cs) {
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _steps.length + (_result.isNotEmpty ? 1 : 0),
      itemBuilder: (_, i) {
        if (i == _steps.length) {
          return _resultCard(cs);
        }
        final step = _steps[i];
        return _stepWidget(step, i == _steps.length - 1 && _running, cs);
      },
    );
  }

  Widget _stepWidget(_AgentStep step, bool isLast, ColorScheme cs) {
    final phaseIcon = switch (step.phase) {
      'planning' => Icons.psychology,
      'executing' => Icons.play_circle,
      'reflecting' => Icons.refresh,
      'complete' => Icons.check_circle,
      'error' => Icons.error,
      _ => Icons.help,
    };
    final phaseColor = switch (step.phase) {
      'planning' => AppColors.primary,
      'executing' => AppColors.warning,
      'reflecting' => AppColors.accent,
      'complete' => AppColors.success,
      'error' => AppColors.error,
      _ => Colors.grey,
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Timeline indicator
          Column(
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: phaseColor.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(phaseIcon, size: 16, color: phaseColor),
              ),
              if (!isLast)
                SizedBox(
                  width: 2,
                  height: 40,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: cs.outlineVariant.withValues(alpha: 0.5),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: cs.surface,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: cs.outlineVariant.withValues(alpha: 0.3)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '步骤 ${step.step}: ${step.phase}',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface),
                  ),
                  if (step.thought != null && step.thought!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(step.thought!,
                          style: TextStyle(
                              fontSize: 12,
                              color: cs.onSurface.withValues(alpha: 0.5))),
                    ),
                  if (step.toolName != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(
                        children: [
                          Icon(Icons.bolt, size: 12, color: AppColors.warning),
                          const SizedBox(width: 4),
                          Text(step.toolName!,
                              style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w500)),
                        ],
                      ),
                    ),
                  if (step.toolResult != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4, left: 18),
                      child: Text(
                        '${step.toolResult!.success ? "✅" : "❌"} ${step.toolResult!.output}',
                        style: TextStyle(
                            fontSize: 11,
                            color: step.toolResult!.success
                                ? AppColors.success
                                : AppColors.error),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _resultCard(ColorScheme cs) {
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.success.withValues(alpha: 0.1),
            AppColors.success.withValues(alpha: 0.05),
          ],
        ),
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
    );
  }
}

class _AgentStep {
  final int step;
  final String phase;
  String? thought;
  String? toolName;
  Map<String, dynamic>? toolArgs;
  ToolResult? toolResult;

  _AgentStep({
    required this.step,
    required this.phase,
    this.thought,
    this.toolName,
    this.toolArgs,
    this.toolResult,
  });
}
