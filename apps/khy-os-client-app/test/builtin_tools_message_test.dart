import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/builtin_tools.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// Regression tests for user-facing tool messages.
///
/// Guards against the "手机未安装匹配 "" 的应用" bug: Dart string
/// interpolation (`$query`) was silently stripped, leaving literal empty
/// quotes/parentheses in tool output shown to the LLM and the user.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// Grab a tool definition by name from the builtin set.
  ToolDef tool(String name) =>
      createBuiltinTools().firstWhere((t) => t.name == name);

  group('search_apps messages', () {
    test('no match interpolates the query (not empty quotes)', () async {
      mockChannel((call) {
        if (call.method == 'searchApps') {
          return {'success': true, 'apps': <Object?>[], 'total': 0};
        }
        return <Object?>{};
      });
      final result = await tool('search_apps').execute({'query': '微信'});
      expect(result.success, false);
      expect(result.output, contains('微信'));
      expect(result.output, isNot(contains('匹配 ""')));
      expect(result.output, contains('未找到匹配'));
    });

    test('empty query lists all apps without failing', () async {
      mockChannel((call) {
        if (call.method == 'listApps') {
          return {
            'success': true,
            'apps': [
              {'label': 'Chrome', 'package': 'com.android.chrome'},
            ],
          };
        }
        return <Object?>{};
      });
      final result = await tool('search_apps').execute({});
      expect(result.success, true);
      expect(result.output, contains('Chrome'));
    });
  });

  group('open_app messages', () {
    test('not installed error names the app and gives a concrete next step', () async {
      mockChannel((call) {
        switch (call.method) {
          case 'listApps':
            return {'success': true, 'apps': <Object?>[]};
          case 'searchApps':
            return {'success': true, 'apps': <Object?>[], 'total': 0};
          default:
            return <Object?>{};
        }
      });
      final result = await tool('open_app').execute({'query': '微信'});
      expect(result.success, false);
      expect(result.output, contains('微信'));
      expect(result.output, contains('未安装'));
      // No stripped-interpolation leftovers
      expect(result.output, isNot(contains('未找到应用: ，')));
    });

    test('opens a semantically-mapped installed app', () async {
      var opened = '';
      mockChannel((call) {
        switch (call.method) {
          case 'listApps':
            return {
              'success': true,
              'apps': [
                {'label': '微信', 'package': 'com.tencent.mm'},
              ],
            };
          case 'openApp':
            opened = call.arguments['packageName'] as String;
            return {'success': true};
          default:
            return <Object?>{};
        }
      });
      final result = await tool('open_app').execute({'query': '微信'});
      expect(result.success, true);
      expect(opened, 'com.tencent.mm');
      expect(result.output, contains('已打开 微信'));
    });
  });

  group('file tools messages', () {
    test('edit_file success names the file and replacement count', () async {
      mockChannel((call) {
        if (call.method == 'fileEdit') {
          return {'success': true, 'replacements': 2, 'size': 10};
        }
        return <Object?>{};
      });
      final result =
          await tool('edit_file').execute({'path': 'a.txt', 'oldText': 'x', 'newText': 'y'});
      expect(result.success, true);
      expect(result.output, contains('a.txt'));
      expect(result.output, contains('2'));
      expect(result.output, isNot(contains('replaced  occurrence')));
    });

    test('grep_files success formats file:line matches', () async {
      mockChannel((call) {
        if (call.method == 'fileGrep') {
          return {
            'success': true,
            'matches': [
              {'file': 'a.txt', 'line': 3, 'text': 'match me'},
            ],
          };
        }
        return <Object?>{};
      });
      final result = await tool('grep_files').execute({'regex': 'match me'});
      expect(result.success, true);
      expect(result.output, contains('a.txt:3'));
      expect(result.output, contains('match me'));
      // No stripped-interpolation leftovers (a placeholder line was ' :: ')
      expect(result.output, isNot(contains(':: ::')));
    });
  });
}
