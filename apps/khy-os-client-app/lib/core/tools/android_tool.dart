import 'dart:async';
import 'tool_engine.dart';
import '../services/device_control.dart';
import '../services/file_service.dart';

/// Unified professional Android system tool.
/// One tool, many subcommands - easier for LLM than 15 fragmented tools.
List<ToolDef> createAndroidTool() => [
  ToolDef(
    name: 'android',
    description:
        'Android system ops (unified). Use cmd for subcommand, action+args for details. '
        'cmds: system|shell|app|screen|input|file|network|process|settings|log',
    inputSchema: {
      'type': 'object',
      'properties': {
        'cmd': {
          'type': 'string',
          'enum': ['system','shell','app','screen','input','file','network','process','settings','log'],
        },
        'action': {'type': 'string', 'description': 'sub-action: open/stop/dump/capture/tap/swipe/text/key/list/read/write/mkdir/get/set'},
        'args': {'type': 'object', 'description': 'parameters: package, url, x, y, text, key, path, content, command, prop, key_setting, value'},
      },
      'required': ['cmd'],
    },
    execute: (toolArgs) async {
      final cmd = toolArgs['cmd'] ?? '';
      final action = toolArgs['action'] ?? '';
      final args = (toolArgs['args'] as Map<String, dynamic>?) ?? {};

      switch (cmd) {
        case 'system':
          return _cmdSystem(args);
        case 'shell':
          return _cmdShell(args);
        case 'app':
          return _cmdApp(action, args);
        case 'screen':
          return _cmdScreen(action, args);
        case 'input':
          return _cmdInput(action, args);
        case 'file':
          return _cmdFile(action, args);
        case 'network':
          return _cmdNetwork(args);
        case 'process':
          return _cmdProcess(args);
        case 'settings':
          return _cmdSettings(action, args);
        case 'log':
          return _cmdLog(args);
        default:
          return ToolResult.fail('unknown cmd: $cmd. Valid: system|shell|app|screen|input|file|network|process|settings|log');
      }
    },
    tags: ['android', 'system'],
  ),
];

// --- system ---
Future<ToolResult> _cmdSystem(Map<String, dynamic> args) async {
  if (args['prop'] != null) {
    final prop = args['prop'] as String;
    final r = await DeviceControl.execShell('getprop $prop');
    return r.success ? ToolResult.ok('$prop=${r.stdout.trim()}') : ToolResult.fail(r.stderr);
  }
  final info = await DeviceControl.getDeviceInfo();
  final json = info.entries.map((e) => '"${e.key}":"${e.value}"').join(',');
  return ToolResult.ok('{$json}');
}

// --- shell ---
Future<ToolResult> _cmdShell(Map<String, dynamic> args) async {
  final command = args['command'] as String? ?? '';
  if (command.isEmpty) return ToolResult.fail('provide args.command');
  final timeout = args['timeout'] as int? ?? 30;
  final r = await DeviceControl.execShell(command, timeoutSeconds: timeout);
  if (r.success) {
    final out = r.stdout.trim();
    return ToolResult.ok(out.isNotEmpty ? out : '(ok, no output)');
  }
  return ToolResult.fail('exit=${r.exitCode}: ${r.stderr.trim()}', );
}

// --- app ---
Future<ToolResult> _cmdApp(String action, Map<String, dynamic> args) async {
  switch (action) {
    case 'open':
    case '':
      final q = args['query'] as String? ?? args['package'] as String? ?? '';
      if (q.isEmpty) return ToolResult.fail('provide args.query or args.package');
      if (q.startsWith('http')) {
        final ok = await DeviceControl.openUrl(q);
        return ok ? ToolResult.ok('opened $q') : ToolResult.fail('open failed: $q');
      }
      final app = await DeviceControl.findApp(q);
      if (app == null) return ToolResult.fail('$q not installed. Suggest user install it.');
      final ok = await DeviceControl.openApp(app.packageName);
      return ok ? ToolResult.ok('opened ${app.label} (${app.packageName})') : ToolResult.fail('launch failed: ${app.label}');
    case 'stop':
    case 'force':
      final pkg = args['package'] as String? ?? '';
      if (pkg.isEmpty) return ToolResult.fail('provide args.package');
      final r = await DeviceControl.execShell('am force-stop $pkg');
      return r.success ? ToolResult.ok('stopped $pkg') : ToolResult.fail(r.stderr);
    case 'list':
      final q = args['query'] as String? ?? '';
      final apps = await DeviceControl.searchApps(q);
      if (apps.isEmpty) return ToolResult.fail('no apps match "$q"');
      final lines = apps.take(15).map((a) => a.label + ' (' + a.packageName + ')').join('\n');
      return ToolResult.ok(lines);
    default:
      return ToolResult.fail('app action: open|stop|force|list');
  }
}

// --- screen ---
Future<ToolResult> _cmdScreen(String action, Map<String, dynamic> args) async {
  switch (action) {
    case 'capture':
    case '':
      if (!await DeviceControl.isScreenCaptureReady()) {
        final ok = await DeviceControl.startScreenCapture();
        if (!ok) return ToolResult.fail('screen capture not authorized. Grant permission in system settings.');
        await Future.delayed(const Duration(seconds: 1));
      }
      final data = await DeviceControl.captureFrame();
      if (data == null) return ToolResult.fail('capture failed');
      return ToolResult.ok('captured (${data.length} chars base64)', metadata: {'imageData': data});
    case 'dump':
      if (!await DeviceControl.isAccessibilityReady()) {
        return ToolResult.fail('accessibility service not enabled. Enable in system settings first.');
      }
      final dump = await DeviceControl.a11yDumpUi();
      return dump.isEmpty ? ToolResult.ok('UI tree empty') : ToolResult.ok(dump.length > 3000 ? dump.substring(0, 3000) : dump);
    case 'click':
    case 'find_click':
      final q = args['query'] as String? ?? '';
      if (q.isEmpty) return ToolResult.fail('provide args.query');
      if (!await DeviceControl.isAccessibilityReady()) {
        return ToolResult.fail('accessibility service not enabled.');
      }
      final ok = await DeviceControl.a11yFindAndClick(q);
      return ok ? ToolResult.ok('clicked "$q"') : ToolResult.fail('"$q" not found on screen');
    default:
      return ToolResult.fail('screen action: capture|dump|click|find_click');
  }
}

// --- input ---
Future<ToolResult> _cmdInput(String action, Map<String, dynamic> args) async {
  if (!await DeviceControl.isAccessibilityReady()) {
    return ToolResult.fail('accessibility service required. Enable in settings.');
  }
  switch (action) {
    case 'tap':
      final x = args['x'] as int? ?? 0;
      final y = args['y'] as int? ?? 0;
      final ok = await DeviceControl.a11yTap(x, y);
      return ok ? ToolResult.ok('tapped ($x,$y)') : ToolResult.fail('tap failed');
    case 'swipe':
      final x1 = args['x1'] as int? ?? 0;
      final y1 = args['y1'] as int? ?? 0;
      final x2 = args['x2'] as int? ?? 0;
      final y2 = args['y2'] as int? ?? 0;
      final dur = args['duration'] as int? ?? 300;
      final ok = await DeviceControl.a11ySwipe(x1, y1, x2, y2, durationMs: dur);
      return ok ? ToolResult.ok('swiped') : ToolResult.fail('swipe failed');
    case 'text':
      final t = args['text'] as String? ?? '';
      if (t.isEmpty) return ToolResult.fail('provide args.text');
      final ok = await DeviceControl.a11yTypeText(t);
      return ok ? ToolResult.ok('typed "${t.length > 30 ? t.substring(0,30)+"..." : t}"') : ToolResult.fail('input failed');
    case 'key':
      final k = args['key'] as int? ?? 3;
      final ok = await DeviceControl.a11yGlobalAction(k == 1 ? DeviceControl.globalActionBack : k == 2 ? DeviceControl.globalActionHome : k == 3 ? DeviceControl.globalActionRecents : DeviceControl.globalActionNotifications);
      return ok ? ToolResult.ok('key $k sent') : ToolResult.fail('key failed');
    default:
      return ToolResult.fail('input action: tap|swipe|text|key');
  }
}

// --- file ---
Future<ToolResult> _cmdFile(String action, Map<String, dynamic> args) async {
  final path = args['path'] as String? ?? '';
  switch (action) {
    case 'read':
      if (path.isEmpty) return ToolResult.fail('provide args.path');
      final r = await FileService.readFile(path);
      return r['success'] == true
          ? ToolResult.ok((r['content'] as String).length > 5000 ? (r['content'] as String).substring(0,5000) : r['content'] as String)
          : ToolResult.fail(r['error']?.toString() ?? 'read failed');
    case 'write':
      final content = args['content'] as String? ?? '';
      if (path.isEmpty || content.isEmpty) return ToolResult.fail('provide args.path and args.content');
      final r = await FileService.writeFile(path, content);
      return r['success'] == true ? ToolResult.ok('wrote $path (${content.length} chars)') : ToolResult.fail(r['error']?.toString() ?? 'write failed');
    case 'list':
    case '':
      final r = await FileService.listFiles(path);
      if (r['success'] == true) {
        final files = (r['files'] as List).cast<Map<String, dynamic>>();
        if (files.isEmpty) return ToolResult.ok('empty dir: $path');
        return ToolResult.ok(files.map((f) => '${f['isDir']==true ? "D" : "F"} ${f['name']}').join('\n'));
      }
      return ToolResult.fail(r['error']?.toString() ?? 'list failed');
    case 'mkdir':
      final r = await FileService.createDir(path);
      return r['success'] == true ? ToolResult.ok('created $path') : ToolResult.fail(r['error']?.toString() ?? 'mkdir failed');
    default:
      return ToolResult.fail('file action: read|write|list|mkdir');
  }
}

// --- network ---
Future<ToolResult> _cmdNetwork(Map<String, dynamic> args) async {
  final r = await DeviceControl.execShell('dumpsys connectivity 2>/dev/null | head -30');
  return r.success ? ToolResult.ok(r.stdout) : ToolResult.fail(r.stderr);
}

// --- process ---
Future<ToolResult> _cmdProcess(Map<String, dynamic> args) async {
  final pkg = args['package'] as String? ?? '';
  if (pkg.isNotEmpty) {
    final r = await DeviceControl.execShell('dumpsys meminfo $pkg 2>/dev/null | head -20');
    return r.success ? ToolResult.ok(r.stdout) : ToolResult.fail(r.stderr);
  }
  final r = await DeviceControl.execShell('ps -A 2>/dev/null | head -30');
  return r.success ? ToolResult.ok(r.stdout) : ToolResult.fail(r.stderr);
}

// --- settings ---
Future<ToolResult> _cmdSettings(String action, Map<String, dynamic> args) async {
  final key = args['key'] as String? ?? '';
  if (key.isEmpty) return ToolResult.fail('provide args.key');
  if (action == 'get') {
    final r = await DeviceControl.execShell('settings get global $key 2>/dev/null || settings get secure $key 2>/dev/null');
    return r.success ? ToolResult.ok('$key=${r.stdout.trim()}') : ToolResult.fail(r.stderr);
  } else {
    final val = args['value'] as String? ?? '';
    final r = await DeviceControl.execShell('settings put global $key $val 2>/dev/null || settings put secure $key $val');
    return r.success ? ToolResult.ok('$key=$val') : ToolResult.fail(r.stderr);
  }
}

// --- log ---
Future<ToolResult> _cmdLog(Map<String, dynamic> args) async {
  final lines = args['lines'] as int? ?? 50;
  final r = await DeviceControl.execShell('logcat -d -t $lines 2>/dev/null');
  return r.success ? ToolResult.ok(r.stdout) : ToolResult.fail('logcat requires shell/root: ${r.stderr}');
}