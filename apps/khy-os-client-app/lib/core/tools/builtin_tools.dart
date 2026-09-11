import 'dart:convert';
import 'dart:math';
import 'package:flutter/services.dart';
import 'package:dio/dio.dart';
import 'tool_engine.dart';
import '../services/device_control.dart';
import 'skills.dart';
import 'retry_engine.dart';
import '../config/app_config.dart';

/// All built-in tools for the Flutter client
List<ToolDef> createBuiltinTools() => [
  // ---- App Control ----
  ToolDef(
    name: 'open_app',
    description: '打开手机上的任意应用（统一入口）。支持中文名、英文名、拼音、包名。如: "微信"、"Baidu"、"qq"、"com.android.chrome"。也支持直接传 URL 打开网页。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '应用名称或包名，如 "浏览器"、"微信"、"com.android.chrome"'},
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      if (query.isEmpty) return ToolResult.fail('请指定要打开的应用');

      // Check if it's a URL
      if (query.startsWith('http://') || query.startsWith('https://')) {
        final ok = await DeviceControl.openUrl(query);
        return ok ? ToolResult.ok('已打开 $query') : ToolResult.fail('打开失败: $query');
      }

      final app = await DeviceControl.findApp(query);
      if (app == null) return ToolResult.fail('未找到应用: $query，请确认应用已安装');

      final ok = await DeviceControl.openApp(app.packageName);
      return ok
          ? ToolResult.ok('已打开 ${app.label}', metadata: {'package': app.packageName})
          : ToolResult.fail('启动失败: ${app.label}');
    },
  ),

  ToolDef(
    name: 'open_url',
    description: '在系统浏览器中打开一个网址。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {'type': 'string', 'description': '完整 URL，如 "https://www.baidu.com"'},
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      if (url.isEmpty) return ToolResult.fail('请提供 URL');
      final ok = await DeviceControl.openUrl(url);
      return ok ? ToolResult.ok('已打开 $url') : ToolResult.fail('打开失败: $url');
    },
  ),

  ToolDef(
    name: 'search_apps',
    description: '搜索手机上已安装的应用列表。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '搜索关键词（应用名或包名）'},
      },
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      final apps = query.isEmpty
          ? await DeviceControl.listApps()
          : await DeviceControl.searchApps(query);
      if (apps.isEmpty) return ToolResult.fail('手机未安装匹配 "" 的应用。建议: 让用户安装该应用，或改用其他已安装的应用。');
      final list = apps.take(10).map((a) => '${a.label} (${a.packageName})').join('\n');
      return ToolResult.ok('找到 ${apps.length} 个应用:\n$list');
    },
  ),

  // ---- Clipboard ----
  ToolDef(
    name: 'read_clipboard',
    description: '读取系统剪贴板中的文本内容。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      try {
        final data = await Clipboard.getData(Clipboard.kTextPlain);
        final text = data?.text ?? '';
        return text.isEmpty
            ? ToolResult.ok('剪贴板为空')
            : ToolResult.ok('剪贴板内容:\n$text');
      } catch (e) {
        return ToolResult.fail('读取剪贴板失败: $e');
      }
    },
  ),

  ToolDef(
    name: 'write_clipboard',
    description: '将文本写入系统剪贴板。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'text': {'type': 'string', 'description': '要写入的文本'},
      },
      'required': ['text'],
    },
    execute: (args) async {
      final text = args['text'] ?? '';
      await Clipboard.setData(ClipboardData(text: text));
      return ToolResult.ok('已写入剪贴板: ${text.length > 50 ? text.substring(0, 50) + "..." : text}');
    },
  ),

  // ---- Calculator ----
  ToolDef(
    name: 'calculator',
    description: '计算数学表达式。支持加减乘除、括号、幂运算等。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'expression': {'type': 'string', 'description': '数学表达式，如 "2+3*4"、"sqrt(144)"'},
      },
      'required': ['expression'],
    },
    execute: (args) async {
      final expr = args['expression'] ?? '';
      if (expr.isEmpty) return ToolResult.fail('请提供数学表达式');
      try {
        final result = _evalExpression(expr);
        return ToolResult.ok('$expr = $result');
      } catch (e) {
        return ToolResult.fail('计算错误: $e');
      }
    },
  ),

  // ---- App Info ----
  ToolDef(
    name: 'device_info',
    description: '获取当前设备信息（平台、版本等）。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final info = {
        'platform': 'Android',
        'app': 'khy-os-client',
        'version': '1.1.16',
      };
      return ToolResult.ok(jsonEncode(info), metadata: info);
    },
  ),

  // ---- HTTP Request ----
  ToolDef(
    name: 'http_request',
    description: '发送 HTTP 请求。仅允许访问白名单域名。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {'type': 'string', 'description': '请求 URL'},
        'method': {'type': 'string', 'enum': ['GET', 'POST'], 'default': 'GET'},
        'body': {'type': 'string', 'description': 'POST 请求体（JSON 字符串）'},
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      final method = args['method'] ?? 'GET';
      // Simplified: just return URL info for now
      return ToolResult.ok('HTTP $method $url\n(网络请求功能将在后续版本完善)');
    },
  ),

  // ---- Note / Search ----
  ToolDef(
    name: 'search_notes',
    description: '搜索本地保存的笔记/备忘录。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '搜索关键词'},
      },
    },
    execute: (args) async {
      return ToolResult.ok('(笔记功能将在后续版本完善)');
    },
  ),

  // ---- Accessibility Service ----
  ToolDef(
    name: 'a11y_tap',
    description: '通过无障碍服务模拟点击屏幕指定坐标。需要先在系统设置中启用无障碍服务。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'x': {'type': 'integer', 'description': 'X 坐标'},
        'y': {'type': 'integer', 'description': 'Y 坐标'},
      },
      'required': ['x', 'y'],
    },
    execute: (args) async {
      final x = args['x'] ?? 0;
      final y = args['y'] ?? 0;
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用，请先在设置中启用');
      final ok = await DeviceControl.a11yTap(x, y);
      return ok ? ToolResult.ok('已点击 ($x, $y)') : ToolResult.fail('点击失败');
    },
  ),

  ToolDef(
    name: 'a11y_find_and_click',
    description: '通过无障碍服务查找并点击 UI 元素。支持 text=xxx / id=xxx / class=xxx 查询。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {'type': 'string', 'description': '查询条件，如 "text=确定"、"id=com.example:id/btn"'},
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      if (query.isEmpty) return ToolResult.fail('请提供查询条件');
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yFindAndClick(query);
      return ok ? ToolResult.ok('已找到并点击: $query') : ToolResult.fail('未找到匹配元素: $query');
    },
  ),

  ToolDef(
    name: 'a11y_dump_ui',
    description: '通过无障碍服务获取当前屏幕的 UI 树结构（文本、ID、类名等）。用于了解屏幕内容。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final dump = await DeviceControl.a11yDumpUi();
      return dump.isEmpty ? ToolResult.ok('UI 树为空') : ToolResult.ok(dump);
    },
  ),

  ToolDef(
    name: 'a11y_list_clickable',
    description: '列出当前屏幕上所有可点击的元素及其坐标。用于 Agent 决策。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final items = await DeviceControl.a11yListClickable();
      if (items.isEmpty) return ToolResult.ok('无可点击元素');
      final list = items.take(20).map((item) =>
        '${item['text']} (${item['class']}) @ (${item['x']},${item['y']})'
      ).join('\n');
      return ToolResult.ok('可点击元素 (${items.length} 个):\n$list');
    },
  ),

  ToolDef(
    name: 'a11y_type_text',
    description: '通过无障碍服务在当前焦点输入框中输入文字。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'text': {'type': 'string', 'description': '要输入的文字'},
      },
      'required': ['text'],
    },
    execute: (args) async {
      final text = args['text'] ?? '';
      if (text.isEmpty) return ToolResult.fail('请提供要输入的文字');
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yTypeText(text);
      return ok ? ToolResult.ok('已输入: $text') : ToolResult.fail('输入失败');
    },
  ),

  ToolDef(
    name: 'a11y_global_action',
    description: '执行全局操作：返回(1)、主页(2)、最近任务(3)、通知栏(4)。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'action': {'type': 'integer', 'description': '操作代码: 1=返回, 2=主页, 3=最近任务, 4=通知栏'},
      },
      'required': ['action'],
    },
    execute: (args) async {
      final action = args['action'] ?? 2;
      final ready = await DeviceControl.isAccessibilityReady();
      if (!ready) return ToolResult.fail('无障碍服务未启用');
      final ok = await DeviceControl.a11yGlobalAction(action);
      final names = {1: '返回', 2: '主页', 3: '最近任务', 4: '通知栏'};
      return ok ? ToolResult.ok('已执行: ${names[action] ?? "未知操作"}') : ToolResult.fail('操作失败');
    },
  ),

  // ---- Screen Capture ----
  ToolDef(
    name: 'capture_screen',
    description: '截取当前屏幕截图。需要先启动屏幕捕获服务。',
    inputSchema: {'type': 'object', 'properties': {}},
    execute: (args) async {
      final ready = await DeviceControl.isScreenCaptureReady();
      if (!ready) {
        final started = await DeviceControl.startScreenCapture();
        if (!started) return ToolResult.fail('启动屏幕捕获失败，请在弹窗中授权');
        // Wait a moment for service to start
        await Future.delayed(const Duration(seconds: 1));
      }
      final data = await DeviceControl.captureFrame();
      if (data == null) return ToolResult.fail('截屏失败');
      return ToolResult.ok('已截屏 (${data.length} bytes base64)', metadata: {'imageData': data});
    },
  ),

  // ---- Shell Command ----
  ToolDef(
    name: 'exec_shell',
    description: '执行 shell 命令。仅允许白名单命令（am, pm, dumpsys, settings, input 等）。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'command': {'type': 'string', 'description': '要执行的 shell 命令'},
      },
      'required': ['command'],
    },
    execute: (args) async {
      final command = args['command'] ?? '';
      if (command.isEmpty) return ToolResult.fail('请提供命令');
      final result = await DeviceControl.execShell(command);
      if (result.success) {
        return ToolResult.ok(result.stdout.isEmpty ? '(无输出)' : result.stdout);
      } else {
        return ToolResult.fail('命令失败 (exit=${result.exitCode}): ${result.stderr}');
      }
    },
  ),

  // ---- Web Search & Fetch ----
  ToolDef(
    name: 'web_search',
    description: '搜索网络信息。使用 DuckDuckGo 或 Bing API 返回搜索结果。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'query': {
          'type': 'string',
          'description': '搜索关键词',
        },
        'count': {
          'type': 'integer',
          'description': '返回结果数量（默认 5）',
        },
      },
      'required': ['query'],
    },
    execute: (args) async {
      final query = args['query'] ?? '';
      if (query.isEmpty) return ToolResult.fail('请提供搜索关键词');

      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 15),
      ));

      try {
        // 使用 DuckDuckGo 即时 API（无需 key）
        final resp = await dio.get(
          'https://api.duckduckgo.com/?q=${Uri.encodeComponent(query)}&format=json&no_html=1&compact=true',
        );
        final data = resp.data as Map<String, dynamic>;

        final results = <String>[];
        final heading = data['Heading'] ?? '';
        if (heading.isNotEmpty) {
          results.add('摘要: $heading');
        }

        final abstract = data['Abstract'] ?? '';
        if (abstract.isNotEmpty) {
          results.add('说明: $abstract');
        }

        final related = data['RelatedTopics'] as List?;
        if (related != null) {
          for (final topic in related.take(5)) {
            if (topic is Map) {
              final text = topic['Text'] ?? '';
              final url = topic['URL'] ?? '';
              if (text.isNotEmpty) {
                results.add(text);
                if (url.isNotEmpty) results.add(url);
              }
            }
          }
        }

        if (results.isEmpty) {
          return ToolResult.ok('未找到关于 "$query" 的结果');
        }

        return ToolResult.ok('搜索结果 "$query":\n' + results.join('\n'));
      } on DioException catch (e) {
        return ToolResult.fail('搜索失败: ${e.message}');
      }
    },
  ),

  ToolDef(
    name: 'web_fetch',
    description:
        '抓取网页内容并提取正文。支持任意 URL，自动去除 HTML 标签。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'url': {
          'type': 'string',
          'description': '要抓取的网页 URL',
        },
      },
      'required': ['url'],
    },
    execute: (args) async {
      final url = args['url'] ?? '';
      if (url.isEmpty) return ToolResult.fail('请提供 URL');

      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 30),
      ));

      try {
        final resp = await dio.get(url);
        final html = resp.data as String;

        // 简单 HTML → 文本转换
        final text = html
            .replaceAll(RegExp(r'<script[^>]*>.*?</script>',
                caseSensitive: false, dotAll: true), '')
            .replaceAll(RegExp(r'<style[^>]*>.*?</style>',
                caseSensitive: false, dotAll: true), '')
            .replaceAll(RegExp(r'<[^>]+>'), ' ')
            .replaceAll(RegExp(r'\s+'), ' ')
            .trim();

        // 截取前 2000 字符
        final result = text.length > 2000
            ? text.substring(0, 2000) + '...'
            : text;

        return result.isEmpty
            ? ToolResult.fail('页面内容为空')
            : ToolResult.ok('网页内容:\n$result',
                metadata: {'url': url, 'length': text.length});
      } on DioException catch (e) {
        return ToolResult.fail('抓取失败 (${e.response?.statusCode}): ${e.message}');
      }
    },
  ),

  // ---- Skill Executor ----
  ToolDef(
    name: 'execute_skill',
    description: '执行辅助技能（截屏提示、回主页、返回、计算等）。注意: 打开应用请用 open_app 工具。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'skill_name': {
          'type': 'string',
          'description': '技能名称，如 "open-wechat", "open-browser", "go-home", "go-back", "screenshot", "calculate"',
          'enum': builtinSkills.map((s) => s.name).toList(),
        },
      },
      'required': ['skill_name'],
    },
    execute: (args) async {
      final name = args['skill_name'] ?? '';
      if (name.isEmpty) return ToolResult.fail('请提供技能名称');

      final skill = builtinSkills.firstWhere(
        (s) => s.name == name,
        orElse: () => const Skill(name: '', label: '', description: ''),
      );
      if (skill.name.isEmpty) return ToolResult.fail('未知技能: $name');

      final result = await SkillExecutor.execute(skill);
      if (result.isPrompt) {
        // Prompt skills are handled by AI, return hint
        return ToolResult.ok('[技能提示] ${skill.description}', metadata: {'skill': skill.name, 'type': 'prompt'});
      }
      return result.success
          ? ToolResult.ok(result.message)
          : ToolResult.fail(result.message);
    },
  ),

  // ---- Vision / Screenshot Analysis ----
  ToolDef(
    name: 'analyze_screen',
    description:
        '截取当前屏幕并用视觉模型分析。返回屏幕内容的文字描述。',
    inputSchema: {
      'type': 'object',
      'properties': {
        'prompt': {
          'type': 'string',
          'description':
              '分析指令，如"描述屏幕上有哪些按钮"、"找到搜索框的位置"',
        },
      },
    },
    execute: (args) async {
      final prompt = args['prompt'] ?? '描述当前屏幕内容';
      final cfg = await AppConfig.loadEffective();

      if (!cfg.hasVisionConfig) {
        return ToolResult.fail('未配置视觉模型。请在设置中填写。');
      }

      var ready = await DeviceControl.isScreenCaptureReady();
      if (!ready) {
        final started = await DeviceControl.startScreenCapture();
        if (!started) return ToolResult.fail('无法启动屏幕捕获');
        await Future.delayed(const Duration(seconds: 1));
        ready = await DeviceControl.isScreenCaptureReady();
        if (!ready) return ToolResult.fail('屏幕捕获未就绪');
      }

      final dataUrl = await DeviceControl.captureFrame();
      if (dataUrl == null) return ToolResult.fail('截屏失败');

      final base64Image = dataUrl.split(',').last;
      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(minutes: 2),
      ));

      try {
        final resp = await dio.post(
          '${cfg.visionBaseUrl}/chat/completions',
          data: {
            'model': cfg.visionModel,
            'messages': [
              {
                'role': 'user',
                'content': [
                  {'type': 'text', 'text': prompt},
                  {
                    'type': 'image_url',
                    'image_url': {
                      'url': 'data:image/jpeg;base64,$base64Image'
                    },
                  },
                ],
              },
            ],
            'max_tokens': 1024,
          },
          options: Options(
            headers: {
              'Authorization': 'Bearer ${cfg.effectiveVisionKey}',
              'Content-Type': 'application/json',
            },
          ),
        );

        final data = resp.data as Map<String, dynamic>;
        final content = data['choices']?[0]?['message']?['content'] ?? '';
        return ToolResult.ok(content,
            metadata: {'model': cfg.visionModel});
      } on DioException catch (e) {
        return ToolResult.fail(
            '视觉模型请求失败 (HTTP ${e.response?.statusCode}): ${e.message}');
      }
    },
  ),
];

/// Simple expression evaluator
double _evalExpression(String expr) {
  // Remove spaces
  expr = expr.replaceAll(' ', '');

  // Handle sqrt
  expr = expr.replaceAllMapped(
    RegExp(r'sqrt\(([^)]+)\)'),
    (m) {
      final val = _evalExpression(m.group(1)!);
      return sqrt(val).toString();
    },
  );

  // Handle pow
  expr = expr.replaceAllMapped(
    RegExp(r'pow\(([^,]+),([^)]+)\)'),
    (m) {
      final base = _evalExpression(m.group(1)!);
      final exp = _evalExpression(m.group(2)!);
      return pow(base, exp).toString();
    },
  );

  return _parseAddSub(expr, 0).$1;
}

(double, int) _parseAddSub(String expr, int pos) {
  var (left, p) = _parseMulDiv(expr, pos);
  while (p < expr.length && (expr[p] == '+' || expr[p] == '-')) {
    final op = expr[p];
    final (right, p2) = _parseMulDiv(expr, p + 1);
    left = op == '+' ? left + right : left - right;
    p = p2;
  }
  return (left, p);
}

(double, int) _parseMulDiv(String expr, int pos) {
  var (left, p) = _parseUnary(expr, pos);
  while (p < expr.length && (expr[p] == '*' || expr[p] == '/' || expr[p] == '%')) {
    final op = expr[p];
    final (right, p2) = _parseUnary(expr, p + 1);
    left = op == '*' ? left * right : op == '/' ? left / right : left % right;
    p = p2;
  }
  return (left, p);
}

(double, int) _parseUnary(String expr, int pos) {
  if (pos < expr.length && expr[pos] == '-') {
    final (val, p) = _parsePrimary(expr, pos + 1);
    return (-val, p);
  }
  return _parsePrimary(expr, pos);
}

(double, int) _parsePrimary(String expr, int pos) {
  if (pos < expr.length && expr[pos] == '(') {
    final (val, p) = _parseAddSub(expr, pos + 1);
    return (val, p + 1); // skip ')'
  }
  // Parse number
  var end = pos;
  while (end < expr.length && (expr[end].codeUnitAt(0) >= 48 && expr[end].codeUnitAt(0) <= 57 || expr[end] == '.')) {
    end++;
  }
  final num = double.parse(expr.substring(pos, end));
  return (num, end);
}
