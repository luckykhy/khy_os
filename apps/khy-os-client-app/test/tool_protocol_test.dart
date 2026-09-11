import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_protocol.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

void main() {
  // ─── parse ─────────────────────────────────────────────────────────

  group('ToolProtocol.parse', () {
    test('parses single valid tool call', () {
      final text = '好的，让我来试试。[TOOL_CALL: calc, {"expr": "2+3"}] 看看结果';
      final calls = ToolProtocol.parse(text);
      expect(calls.length, 1);
      expect(calls[0].name, 'calc');
      expect(calls[0].args, {'expr': '2+3'});
    });

    test('parses multiple tool calls', () {
      final text = '[TOOL_CALL: a, {"x":1}] middle [TOOL_CALL: b, {"y":2}]';
      final calls = ToolProtocol.parse(text);
      expect(calls.length, 2);
      expect(calls[0].name, 'a');
      expect(calls[1].name, 'b');
    });

    test('bad JSON args become empty map', () {
      final text = '[TOOL_CALL: broken, {not valid json}]';
      final calls = ToolProtocol.parse(text);
      expect(calls.length, 1);
      expect(calls[0].name, 'broken');
      expect(calls[0].args, isEmpty);
    });

    test('no tool calls returns empty list', () {
      final calls = ToolProtocol.parse('just a normal message');
      expect(calls, isEmpty);
    });

    test('empty string returns empty list', () {
      expect(ToolProtocol.parse(''), isEmpty);
    });

    test('order is preserved for multiple matches', () {
      final text =
          '[TOOL_CALL: first, {}] then [TOOL_CALL: second, {}] then [TOOL_CALL: third, {}]';
      final calls = ToolProtocol.parse(text);
      expect(calls.map((c) => c.name).toList(), ['first', 'second', 'third']);
    });

    test('multiline args with dotAll', () {
      final text = '[TOOL_CALL: multi, {"a": 1,\n"b": 2}]';
      final calls = ToolProtocol.parse(text);
      expect(calls.length, 1);
      expect(calls[0].args, {'a': 1, 'b': 2});
    });
  });

  // ─── hasToolCall ───────────────────────────────────────────────────

  group('ToolProtocol.hasToolCall', () {
    test('true when tool call present', () {
      expect(ToolProtocol.hasToolCall('[TOOL_CALL: x, {}]'), true);
    });

    test('false when absent', () {
      expect(ToolProtocol.hasToolCall('no tools here'), false);
    });

    test('false for empty string', () {
      expect(ToolProtocol.hasToolCall(''), false);
    });
  });

  // ─── stripToolCalls ────────────────────────────────────────────────

  group('ToolProtocol.stripToolCalls', () {
    test('removes tool call text', () {
      final stripped = ToolProtocol.stripToolCalls('hello [TOOL_CALL: x, {}] world');
      expect(stripped, 'hello  world'.trim());
    });

    test('returns empty (trimmed) when entire string is a tool call', () {
      final stripped = ToolProtocol.stripToolCalls('[TOOL_CALL: x, {"a":1}]');
      expect(stripped.trim(), isEmpty);
    });

    test('returns original when no tool calls', () {
      expect(ToolProtocol.stripToolCalls('plain text').trim(), 'plain text');
    });
  });

  // ─── formatToolResult ──────────────────────────────────────────────

  group('ToolProtocol.formatToolResult', () {
    test('formats success result', () {
      final r = ToolResult.ok('计算完成: 42');
      final formatted = ToolProtocol.formatToolResult(r);
      expect(formatted, '[TOOL_RESULT: 成功, 计算完成: 42]');
    });

    test('formats failure result', () {
      final r = ToolResult.fail('命令被拒绝');
      final formatted = ToolProtocol.formatToolResult(r);
      expect(formatted, '[TOOL_RESULT: 失败, 命令被拒绝]');
    });
  });

  // ─── needsTextProtocol ─────────────────────────────────────────────

  group('ToolProtocol.needsTextProtocol', () {
    test('text protocol models (case-insensitive)', () {
      expect(ToolProtocol.needsTextProtocol('longcat'), true);
      expect(ToolProtocol.needsTextProtocol('AGNES'), true);
      expect(ToolProtocol.needsTextProtocol('glm-4'), true);
      expect(ToolProtocol.needsTextProtocol('kimi'), true);
    });

    test('native protocol models', () {
      expect(ToolProtocol.needsTextProtocol('deepseek-chat'), false);
      expect(ToolProtocol.needsTextProtocol('gpt-4o'), false);
      expect(ToolProtocol.needsTextProtocol('claude-sonnet-4-20250514'), false);
      expect(ToolProtocol.needsTextProtocol('gemini-2.0'), false);
    });

    test('unknown model defaults to true (text protocol)', () {
      expect(ToolProtocol.needsTextProtocol('some-random-model'), true);
    });

    test('order matters: agnes-deepseek → true (agnes checked first)', () {
      expect(ToolProtocol.needsTextProtocol('agnes-deepseek'), true);
    });

    test('order matters: deepseek-agnes → true (agnes at step 2 before deepseek at step 5)', () {
      expect(ToolProtocol.needsTextProtocol('deepseek-agnes'), true);
    });

    test('pure deepseek → false', () {
      expect(ToolProtocol.needsTextProtocol('deepseek-chat'), false);
    });
  });

  // ─── textProtocolInstructions ──────────────────────────────────────

  group('textProtocolInstructions', () {
    test('is non-empty and mentions TOOL_CALL', () {
      final instructions = ToolProtocol.textProtocolInstructions;
      expect(instructions, isNotEmpty);
      expect(instructions, contains('TOOL_CALL'));
    });
  });

  // ─── ParsedToolCall / ToolCallResult ───────────────────────────────

  group('ParsedToolCall', () {
    test('stores name and args', () {
      final p = ParsedToolCall(name: 'test', args: {'x': 1});
      expect(p.name, 'test');
      expect(p.args, {'x': 1});
    });
  });

  group('ToolCallResult', () {
    test('stores success and output', () {
      final r = ToolCallResult(success: true, output: 'done');
      expect(r.success, true);
      expect(r.output, 'done');
    });
  });
}
