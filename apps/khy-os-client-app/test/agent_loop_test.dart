import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/agent/execution_log.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/config/app_config.dart';

void main() {
  group('AgentPhase / AgentStep', () {
    test('AgentPhase has 5 values', () {
      expect(AgentPhase.values.length, 5);
      expect(AgentPhase.values, [
        AgentPhase.planning,
        AgentPhase.executing,
        AgentPhase.reflecting,
        AgentPhase.complete,
        AgentPhase.error,
      ]);
    });

    test('AgentStep stores all fields', () {
      final step = AgentStep(step: 1, phase: AgentPhase.executing, thought: 'thinking', toolName: 'calc');
      expect(step.step, 1);
      expect(step.phase, AgentPhase.executing);
      expect(step.thought, 'thinking');
      expect(step.toolName, 'calc');
    });
  });

  group('AgentLoop config', () {
    test('maxSteps is 15', () {
      expect(AgentLoop.maxSteps, 15);
    });

    test('stepTimeout is 30s (declared but unused)', () {
      expect(AgentLoop.stepTimeout, const Duration(seconds: 30));
    });

    test('constructor requires engine and config', () {
      final engine = ToolEngine();
      final config = AppConfigData(baseUrl: 'https://x.com', apiKey: 'k', model: 'm');
      final loop = AgentLoop(engine: engine, config: config);
      expect(loop, isNotNull);
    });
  });

  group('ExecutionLog (extended)', () {
    test('addStep increments index', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      final i1 = log.addStep('tool_a', {});
      final i2 = log.addStep('tool_b', {'x': 1});
      expect(i1, 0);
      expect(i2, 1);
      expect(log.steps[0].index, 1);
      expect(log.steps[1].index, 2);
    });

    test('finish sets complete and finalResult', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      expect(log.complete, false);
      log.finish('done');
      expect(log.complete, true);
      expect(log.finalResult, 'done');
      expect(log.finishedAt, isNotNull);
    });

    test('fail sets complete with reason', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      log.fail('network error');
      expect(log.complete, true);
      expect(log.finalResult, contains('network error'));
    });

    test('successCount / failCount', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      final i0 = log.addStep('a', {});
      final i1 = log.addStep('b', {});
      log.steps[i0].complete('ok');
      log.steps[i1].fail('err');
      expect(log.successCount, 1);
      expect(log.failCount, 1);
    });

    test('progressText when running', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      log.addStep('my_tool', {});
      expect(log.progressText, contains('my_tool'));
    });

    test('progressText when complete', () {
      final log = ExecutionLog(conversationId: 'test', userMessage: 'hi');
      final i = log.addStep('tool', {});
      log.steps[i].complete('result');
      log.finish('all done');
      expect(log.progressText, contains('1'));
    });

    test('toJson includes all steps', () {
      final log = ExecutionLog(conversationId: 'conv1', userMessage: 'do stuff');
      final i = log.addStep('calc', {'expr': '1+1'});
      log.steps[i].complete('2');
      log.finish('2');

      final json = log.toJson();
      expect(json['conversation_id'], 'conv1');
      expect(json['user_message'], 'do stuff');
      expect(json['complete'], true);
      expect(json['steps'].length, 1);
      expect(json['steps'][0]['tool'], 'calc');
      expect(json['steps'][0]['state'], 'success');
    });

    test('toText produces readable output', () {
      final log = ExecutionLog(conversationId: 'c1', userMessage: 'test');
      final i = log.addStep('echo', {'msg': 'hi'});
      log.steps[i].complete('hi');
      log.finish('done');

      final text = log.toText();
      expect(text, contains('c1'));
      expect(text, contains('test'));
      expect(text, contains('echo'));
    });
  });
}
