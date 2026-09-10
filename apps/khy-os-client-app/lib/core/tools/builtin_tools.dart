import 'dart:convert';
import 'dart:math';
import 'package:flutter/services.dart';
import 'tool_engine.dart';
import '../services/device_control.dart';

/// All built-in tools for the Flutter client
List<ToolDef> createBuiltinTools() => [
  // ---- App Control ----
  ToolDef(
    name: 'open_app',
    description: '打开手机上的应用。可以传入应用名称（中文/拼音）或包名。',
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
      if (apps.isEmpty) return ToolResult.ok('未找到匹配的应用');
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
