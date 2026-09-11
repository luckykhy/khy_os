import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/widgets/tool_card.dart';
import 'package:khy_os_client/core/agent/execution_log.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // ToolCardData unit tests
  // ═══════════════════════════════════════════════════════════════

  group('ToolCardData', () {
    test('running factory creates correct state', () {
      final card = ToolCardData.running(
        index: 1,
        toolName: 'exec_shell',
        label: '执行命令: ls -la',
        args: {'command': 'ls -la'},
      );

      expect(card.index, 1);
      expect(card.toolName, 'exec_shell');
      expect(card.label, '执行命令: ls -la');
      expect(card.args, {'command': 'ls -la'});
      expect(card.state, ExecState.running);
      expect(card.output, isNull);
      expect(card.error, isNull);
      expect(card.durationMs, isNull);
      expect(card.isRunning, true);
      expect(card.isCompleted, false);
    });

    test('success factory creates correct state', () {
      final card = ToolCardData.success(
        index: 2,
        toolName: 'calculator',
        label: '计算: 2+2',
        args: {'expression': '2+2'},
        output: '4',
        durationMs: 15,
      );

      expect(card.state, ExecState.success);
      expect(card.output, '4');
      expect(card.durationMs, 15);
      expect(card.isRunning, false);
      expect(card.isCompleted, true);
      expect(card.statusText, '15ms');
    });

    test('failed factory creates correct state', () {
      final card = ToolCardData.failed(
        index: 3,
        toolName: 'exec_shell',
        label: '执行命令: rm -rf /',
        args: {'command': 'rm -rf /'},
        error: 'Permission denied',
        durationMs: 5,
      );

      expect(card.state, ExecState.failed);
      expect(card.error, 'Permission denied');
      expect(card.isCompleted, true);
      expect(card.statusText, '失败');
    });

    test('timeout factory creates correct state', () {
      final card = ToolCardData.timeout(
        index: 4,
        toolName: 'web_fetch',
        label: '抓取: https://example.com',
        args: {'url': 'https://example.com'},
        durationMs: 30000,
      );

      expect(card.state, ExecState.timeout);
      expect(card.error, '执行超时');
      expect(card.statusText, '超时');
    });

    test('fromStep converts ExecutionStep correctly', () {
      final step = ExecutionStep(index: 1, toolName: 'open_app', args: {'query': 'Chrome'});
      step.start();
      step.complete('Opened Chrome');

      final card = ToolCardData.fromStep(step, '打开应用: Chrome');

      expect(card.index, 1);
      expect(card.toolName, 'open_app');
      expect(card.label, '打开应用: Chrome');
      expect(card.state, ExecState.success);
      expect(card.output, 'Opened Chrome');
      expect(card.durationMs, isA<int>());
      expect(card.isCompleted, true);
    });

    test('copyWith preserves unchanged fields', () {
      final original = ToolCardData.running(
        index: 1,
        toolName: 'test',
        label: 'Test label',
        args: {'a': 1},
      );

      final updated = original.copyWith(state: ExecState.success, output: 'done', durationMs: 100);

      expect(updated.index, 1);
      expect(updated.toolName, 'test');
      expect(updated.label, 'Test label');
      expect(updated.args, {'a': 1});
      expect(updated.state, ExecState.success);
      expect(updated.output, 'done');
      expect(updated.durationMs, 100);
    });

    test('toJson/fromJson round-trip', () {
      final original = ToolCardData.success(
        index: 5,
        toolName: 'web_search',
        label: '联网搜索: Flutter',
        args: {'query': 'Flutter'},
        output: 'Found 10 results',
        durationMs: 523,
      );

      final json = original.toJson();
      final restored = ToolCardData.fromJson(json);

      expect(restored.index, 5);
      expect(restored.toolName, 'web_search');
      expect(restored.label, '联网搜索: Flutter');
      expect(restored.args, {'query': 'Flutter'});
      expect(restored.state, ExecState.success);
      expect(restored.output, 'Found 10 results');
      expect(restored.durationMs, 523);
    });

    test('statusText for each state', () {
      final ts = DateTime(2026, 1, 1);

      expect(
        ToolCardData(index: 1, toolName: 't', label: 'l', state: ExecState.queued, timestamp: ts).statusText,
        '排队中');
      expect(
        ToolCardData(index: 1, toolName: 't', label: 'l', state: ExecState.running, timestamp: ts).statusText,
        '执行中');
      expect(
        ToolCardData(index: 1, toolName: 't', label: 'l', state: ExecState.success, durationMs: 42, timestamp: ts).statusText,
        '42ms');
      expect(
        ToolCardData(index: 1, toolName: 't', label: 'l', state: ExecState.failed, timestamp: ts).statusText,
        '失败');
      expect(
        ToolCardData(index: 1, toolName: 't', label: 'l', state: ExecState.timeout, timestamp: ts).statusText,
        '超时');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ToolCard widget tests
  // ═══════════════════════════════════════════════════════════════

  group('ToolCard widget', () {
    Widget wrap(Widget child) => MaterialApp(
          home: Scaffold(body: child),
        );

    testWidgets('running state shows spinner and label', (tester) async {
      final card = ToolCardData.running(
        index: 1,
        toolName: 'exec_shell',
        label: '执行命令: npm install',
        args: {'command': 'npm install'},
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      expect(find.text('执行命令: npm install'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      expect(find.text('执行中'), findsOneWidget);
    });

    testWidgets('success state shows checkmark and output', (tester) async {
      final card = ToolCardData.success(
        index: 1,
        toolName: 'calculator',
        label: '计算: 6*7',
        args: {'expression': '6*7'},
        output: '42',
        durationMs: 12,
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      expect(find.text('计算: 6*7'), findsOneWidget);
      expect(find.text('42'), findsOneWidget);
      expect(find.text('12ms'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('failed state shows error message', (tester) async {
      final card = ToolCardData.failed(
        index: 1,
        toolName: 'exec_shell',
        label: '执行命令: rm -rf /',
        args: {'command': 'rm -rf /'},
        error: '命令被拒绝（白名单/黑名单）',
        durationMs: 3,
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      expect(find.text('执行命令: rm -rf /'), findsOneWidget);
      expect(find.text('命令被拒绝（白名单/黑名单）'), findsOneWidget);
      expect(find.text('失败'), findsOneWidget);
      expect(find.byIcon(Icons.error), findsOneWidget);
    });

    testWidgets('timeout state shows timer icon', (tester) async {
      final card = ToolCardData.timeout(
        index: 1,
        toolName: 'web_fetch',
        label: '抓取: https://slow-server.com',
        args: {'url': 'https://slow-server.com'},
        durationMs: 30000,
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      expect(find.byIcon(Icons.timer_off), findsOneWidget);
      expect(find.text('超时'), findsOneWidget);
    });

    testWidgets('args are displayed when non-empty', (tester) async {
      final card = ToolCardData.running(
        index: 1,
        toolName: 'open_url',
        label: '打开网址: https://khyos.dev',
        args: {'url': 'https://khyos.dev', 'new_tab': true},
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      // Args row shows "url: https://khyos.dev  new_tab: true"
      expect(find.textContaining('url: https://khyos.dev'), findsOneWidget);
    });

    testWidgets('empty args hide the args row', (tester) async {
      final card = ToolCardData.running(
        index: 1,
        toolName: 'read_clipboard',
        label: '读取剪贴板',
        args: {},
      );

      await tester.pumpWidget(wrap(ToolCard(data: card)));

      // No args text should be visible
      expect(find.textContaining('url:'), findsNothing);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ToolExecutionSummary tests
  // ═══════════════════════════════════════════════════════════════

  group('ToolExecutionSummary', () {
    Widget wrap(Widget child) => MaterialApp(
          home: Scaffold(body: child),
        );

    testWidgets('shows progress when running', (tester) async {
      final cards = [
        ToolCardData.success(index: 1, toolName: 'a', label: 'A', args: {}, output: 'ok', durationMs: 10),
        ToolCardData.running(index: 2, toolName: 'b', label: 'B', args: {}),
      ];

      await tester.pumpWidget(wrap(ToolExecutionSummary(cards: cards)));

      expect(find.textContaining('工具执行 1/2'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('shows completion when all done', (tester) async {
      final cards = [
        ToolCardData.success(index: 1, toolName: 'a', label: 'A', args: {}, output: 'ok', durationMs: 100),
        ToolCardData.failed(index: 2, toolName: 'b', label: 'B', args: {}, error: 'err', durationMs: 50),
      ];

      await tester.pumpWidget(wrap(ToolExecutionSummary(cards: cards)));

      expect(find.textContaining('工具执行 2/2'), findsOneWidget);
      expect(find.textContaining('1 失败'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
    });

    testWidgets('empty cards returns shrink', (tester) async {
      await tester.pumpWidget(wrap(ToolExecutionSummary(cards: [])));

      expect(find.byType(SizedBox), findsWidgets); // SizedBox.shrink
    });
  });
}
