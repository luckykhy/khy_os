import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import '../services/app_logger.dart';

/// Shell 命令执行结果
class ShellResult {
  final bool success;
  final String stdout;
  final String stderr;
  final int exitCode;
  final int durationMs;
  final String command;

  const ShellResult({
    required this.success,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    required this.durationMs,
    required this.command,
  });

  /// 输出行列表
  List<String> get outputLines =>
      stdout.split('\n').where((l) => l.trim().isNotEmpty).toList();

  /// JSON 解析（如果输出是 JSON）
  Map<String, dynamic>? get json {
    try {
      final trimmed = stdout.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return jsonDecode(trimmed) as Map<String, dynamic>;
      }
    } catch (_) {}
    return null;
  }

  List<dynamic>? get jsonList {
    try {
      final trimmed = stdout.trim();
      if (trimmed.startsWith('[')) {
        return jsonDecode(trimmed) as List<dynamic>;
      }
    } catch (_) {}
    return null;
  }

  @override
  String toString() =>
      'ShellResult(success=$success, exit=$exitCode, stdout=${stdout.length} chars, stderr=${stderr.length} chars)';
}

/// Shell 执行器（无 root 环境）
/// 能力边界：以 app UID 执行，不能访问其他 app 私有目录，不能修改系统文件
class ShellExecutor {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');
  static final _logger = AppLogger();

  /// 执行单条命令
  static Future<ShellResult> exec(
    String command, {
    int timeoutSeconds = 30,
    Map<String, String>? env,
  }) async {
    final startTime = DateTime.now();
    try {
      final result = await _channel.invokeMethod('shell', {
        'command': command,
        'timeout': timeoutSeconds,
        if (env != null) 'env': env,
      }).timeout(Duration(seconds: timeoutSeconds + 5));

      final duration = DateTime.now().difference(startTime).inMilliseconds;
      final map = Map<String, dynamic>.from(result as Map);

      return ShellResult(
        success: map['success'] == true,
        stdout: map['stdout']?.toString() ?? '',
        stderr: map['stderr']?.toString() ?? '',
        exitCode: map['exitCode'] as int? ?? -1,
        durationMs: duration,
        command: command,
      );
    } on TimeoutException {
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      _logger.w(LogCategory.system, 'Shell 超时: $command');
      return ShellResult(
        success: false,
        stdout: '',
        stderr: '命令执行超时 (${timeoutSeconds}s)',
        exitCode: -1,
        durationMs: duration,
        command: command,
      );
    } catch (e) {
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      return ShellResult(
        success: false,
        stdout: '',
        stderr: e.toString(),
        exitCode: -1,
        durationMs: duration,
        command: command,
      );
    }
  }

  /// 执行多条命令（串行）
  static Future<List<ShellResult>> execAll(
    List<String> commands, {
    int timeoutSeconds = 30,
  }) async {
    final results = <ShellResult>[];
    for (final cmd in commands) {
      final r = await exec(cmd, timeoutSeconds: timeoutSeconds);
      results.add(r);
      if (!r.success) break; // 失败则停止
    }
    return results;
  }

  /// 执行并解析 JSON 输出
  static Future<ShellResult> execForJson(String command, {int timeoutSeconds = 30}) async {
    final result = await exec(command, timeoutSeconds: timeoutSeconds);
    return result;
  }

  /// 检查命令是否可用
  static Future<bool> isAvailable(String command) async {
    final which = await exec('command -v $command', timeoutSeconds: 5);
    return which.success && which.stdout.trim().isNotEmpty;
  }

  /// 获取系统属性
  static Future<String> getProp(String key) async {
    final r = await exec('getprop $key', timeoutSeconds: 5);
    return r.stdout.trim();
  }

  /// 获取 Android 版本信息
  static Future<Map<String, String>> getSystemInfo() async {
    final info = <String, String>{};
    final keys = [
      'ro.build.version.release',
      'ro.build.version.sdk',
      'ro.product.model',
      'ro.product.brand',
      'ro.product.name',
      'ro.build.display.id',
    ];
    for (final key in keys) {
      final value = await getProp(key);
      if (value.isNotEmpty) info[key] = value;
    }
    return info;
  }
}

/// 常用命令快捷方式
class ShellCommands {
  /// 列出已安装包
  static String listPackages({bool onlyThirdParty = false}) =>
      onlyThirdParty
          ? 'pm list packages -3'
          : 'pm list packages';

  /// 获取包信息
  static String packageInfo(String packageName) =>
      'dumpsys package $packageName';

  /// 启动应用
  static String openApp(String packageName) =>
      'monkey -p $packageName -c android.intent.category.LAUNCHER 1';

  /// 启动 Activity
  static String startActivity(String component) =>
      'am start -n $component';

  /// 模拟点击
  static String tap(int x, int y) => 'input tap $x $y';

  /// 模拟滑动
  static String swipe(int x1, int y1, int x2, int y2, {int durationMs = 300}) =>
      'input swipe $x1 $y1 $x2 $y2 $durationMs';

  /// 模拟输入文字
  static String inputText(String text) => 'input text "${text.replaceAll('"', '\\"')}"';

  /// 模拟按键
  static String keyEvent(int keycode) => 'input keyevent $keycode';

  /// 截屏
  static String screenshot(String path) => 'screencap -p $path';

  /// 获取当前 Activity
  static String currentActivity() =>
      'dumpsys activity activities | grep mResumedActivity';

  /// 获取窗口信息
  static String windowInfo() => 'dumpsys window windows';

  /// 获取运行中的进程
  static String runningProcesses() => 'ps -A';

  /// 获取内存信息
  static String memoryInfo(String packageName) =>
      'dumpsys meminfo $packageName';

  /// 获取电池信息
  static String batteryInfo() => 'dumpsys battery';

  /// 获取网络状态
  static String networkStatus() => 'dumpsys connectivity';

  /// 列出目录
  static String listDir(String path) => 'ls -la $path';

  /// 读取文件
  static String readFile(String path) => 'cat $path';

  /// 文件是否存在
  static String fileExists(String path) =>
      '[ -f $path ] && echo "yes" || echo "no"';

  /// 获取文件权限
  static String filePermissions(String path) => 'ls -la $path';

  /// 获取设备 IP
  static String deviceIp() => 'ip addr show wlan0 | grep inet';

  /// 获取 WiFi 信息
  static String wifiInfo() => 'dumpsys wifi';

  /// 获取蓝牙状态
  static String bluetoothStatus() => 'dumpsys bluetooth_manager';

  /// 获取传感器列表
  static String sensors() => 'dumpsys sensorservice';

  /// 获取输入设备
  static String inputDevices() => 'dumpsys input';
}

