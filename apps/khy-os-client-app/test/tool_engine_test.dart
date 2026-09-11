import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

void main() {
  // ─── Helpers ───────────────────────────────────────────────────────

  ToolDef makeTool({
    String name = 'test_tool',
    String output = 'ok',
    bool success = true,
    PermissionLevel permission = PermissionLevel.auto,
    void Function()? onExecute,
  }) {
    return ToolDef(
      name: name,
      description: 'A test tool',
      inputSchema: {'type': 'object', 'properties': {}},
      permission: permission,
      execute: (args) async {
        onExecute?.call();
        return ToolResult(success: success, output: output);
      },
    );
  }

  // ─── ToolResult ────────────────────────────────────────────────────

  group('ToolResult', () {
    test('ok factory', () {
      final r = ToolResult.ok('done');
      expect(r.success, true);
      expect(r.output, 'done');
      expect(r.metadata, isNull);
    });

    test('fail factory', () {
      final r = ToolResult.fail('bad');
      expect(r.success, false);
      expect(r.output, 'bad');
      expect(r.metadata, isNull);
    });

    test('jsonOutput includes metadata when present', () {
      final r = ToolResult.ok('done', metadata: {'key': 'val'});
      expect(r.jsonOutput, contains('"key"'));
      expect(r.jsonOutput, contains('"val"'));
    });

    test('jsonOutput excludes metadata when null', () {
      final r = ToolResult.ok('done');
      expect(r.jsonOutput, isNot(contains('metadata')));
    });
  });

  // ─── ToolDef ───────────────────────────────────────────────────────

  group('ToolDef', () {
    test('toFunctionSchema produces OpenAI format', () {
      final tool = ToolDef(
        name: 'calc',
        description: 'Calculate',
        inputSchema: {'type': 'object', 'properties': {'expr': {'type': 'string'}}},
        execute: (_) async => ToolResult.ok('1'),
      );

      final schema = tool.toFunctionSchema();
      expect(schema['type'], 'function');
      expect(schema['function']['name'], 'calc');
      expect(schema['function']['description'], 'Calculate');
      expect(schema['function']['parameters'], isA<Map>());
    });
  });

  // ─── ToolEngine ────────────────────────────────────────────────────

  group('ToolEngine', () {
    late ToolEngine engine;

    setUp(() {
      engine = ToolEngine();
    });

    test('register + getTool', () {
      final tool = makeTool(name: 'foo');
      engine.register(tool);
      expect(engine.getTool('foo'), isNotNull);
      expect(engine.getTool('bar'), isNull);
    });

    test('register overwrites by name', () {
      engine.register(makeTool(name: 'foo', output: 'first'));
      engine.register(makeTool(name: 'foo', output: 'second'));
      expect(engine.allTools.length, 1);
    });

    test('registerAll adds multiple tools', () {
      engine.registerAll([makeTool(name: 'a'), makeTool(name: 'b')]);
      expect(engine.allTools.length, 2);
    });

    test('execute unknown tool returns fail', () async {
      final r = await engine.execute('nonexistent', {});
      expect(r.success, false);
      expect(r.output, contains('nonexistent'));
      expect(r.output, contains('not found'));
    });

    test('execute happy path', () async {
      engine.register(makeTool(name: 'calc', output: '42'));
      final r = await engine.execute('calc', {'expr': '6*7'});
      expect(r.success, true);
      expect(r.output, '42');
    });

    test('execute tool that throws returns fail', () async {
      engine.register(ToolDef(
        name: 'boom',
        description: 'throws',
        inputSchema: {},
        execute: (_) async => throw Exception('kaboom'),
      ));
      final r = await engine.execute('boom', {});
      expect(r.success, false);
      expect(r.output, contains('kaboom'));
    });

    // ── Permissions ──

    test('default permission is auto', () {
      engine.register(makeTool(name: 'x'));
      expect(engine.getPermission('x'), PermissionLevel.auto);
    });

    test('deny blocks execution', () async {
      engine.register(makeTool(name: 'dangerous'));
      engine.setPermission('dangerous', PermissionLevel.deny);
      expect(engine.canExecute('dangerous'), false);

      final r = await engine.execute('dangerous', {});
      expect(r.success, false);
      expect(r.output, contains('denied'));
    });

    test('ask does NOT block execution (not enforced)', () async {
      engine.register(makeTool(name: 'careful'));
      engine.setPermission('careful', PermissionLevel.ask);
      expect(engine.canExecute('careful'), true); // ask != deny

      final r = await engine.execute('careful', {});
      expect(r.success, true);
    });

    test('canExecute unknown tool returns true', () {
      expect(engine.canExecute('never-registered'), true);
    });

    // ── Hooks ──

    test('before hook receives null result', () async {
      String? hookTool;
      Map<String, dynamic>? hookArgs;
      ToolResult? hookResult;

      engine.addBeforeHook((name, args, result) async {
        hookTool = name;
        hookArgs = args;
        hookResult = result;
      });

      engine.register(makeTool(name: 'hooked'));
      await engine.execute('hooked', {'a': 1});

      expect(hookTool, 'hooked');
      expect(hookArgs, {'a': 1});
      expect(hookResult, isNull);
    });

    test('after hook receives tool result', () async {
      ToolResult? afterResult;

      engine.addAfterHook((name, args, result) async {
        afterResult = result;
      });

      engine.register(makeTool(name: 'hooked', output: 'result-output'));
      await engine.execute('hooked', {});

      expect(afterResult, isNotNull);
      expect(afterResult!.output, 'result-output');
    });

    test('hook exception is swallowed (execution continues)', () async {
      engine.addBeforeHook((_, __, ___) async => throw Exception('hook crash'));

      engine.register(makeTool(name: 'resilient'));
      final r = await engine.execute('resilient', {});
      expect(r.success, true);
    });

    // ── toFunctionSchemas ──

    test('toFunctionSchemas returns all registered tools', () {
      engine.registerAll([makeTool(name: 'a'), makeTool(name: 'b')]);
      final schemas = engine.toFunctionSchemas();
      expect(schemas.length, 2);
      expect(schemas.every((s) => s['type'] == 'function'), true);
    });

    test('toFunctionSchemas empty when no tools', () {
      expect(engine.toFunctionSchemas(), isEmpty);
    });

    // ── executeToolCalls ──

    test('executeToolCalls maps tool_calls to tool-role messages', () async {
      engine.register(makeTool(name: 'echo', output: 'echoed'));

      final calls = [
        {
          'id': 'call_1',
          'type': 'function',
          'function': {'name': 'echo', 'arguments': '{"msg":"hi"}'},
        },
      ];

      final results = await engine.executeToolCalls(calls);
      expect(results.length, 1);
      expect(results[0]['tool_call_id'], 'call_1');
      expect(results[0]['role'], 'tool');
      expect(results[0]['content'], contains('echoed'));
    });

    test('executeToolCalls handles malformed JSON arguments', () async {
      engine.register(makeTool(name: 'echo'));

      final calls = [
        {
          'id': 'call_2',
          'type': 'function',
          'function': {'name': 'echo', 'arguments': '{bad json'},
        },
      ];

      final results = await engine.executeToolCalls(calls);
      // Malformed JSON args → silently becomes {}
      expect(results[0]['content'], isNotNull);
    });

    test('executeToolCalls missing id defaults to empty string', () async {
      engine.register(makeTool(name: 'echo'));

      final calls = [
        {
          'type': 'function',
          'function': {'name': 'echo', 'arguments': '{}'},
        },
      ];

      final results = await engine.executeToolCalls(calls);
      expect(results[0]['tool_call_id'], '');
    });
  });

  // ─── toolNamesString ───────────────────────────────────────────────

  group('toolNamesString', () {
    test('lists tool names with dashes', () {
      final engine = ToolEngine();
      engine.registerAll([makeTool(name: 'alpha'), makeTool(name: 'beta')]);
      final str = engine.toolNamesString();
      expect(str, contains('- alpha'));
      expect(str, contains('- beta'));
    });

    test('empty when no tools', () {
      final engine = ToolEngine();
      expect(engine.toolNamesString().trim(), isEmpty);
    });
  });
}
