import 'dart:io';
import 'package:path_provider/path_provider.dart';

/// 日志级别
enum LogLevel { debug, info, warn, error }

/// 日志分类
enum LogCategory {
  network,    // 网络请求
  dns,        // DNS 解析
  auth,       // 认证
  ui,         // 界面操作
  config,     // 配置
  api,        // API 调用
  error,      // 错误
  system,     // 系统
}

/// 结构化日志服务
/// 格式: [时间][级别][分类] 消息 | 详情 | 堆栈
class AppLogger {
  static final AppLogger _instance = AppLogger._internal();
  factory AppLogger() => _instance;
  AppLogger._internal();

  File? _logFile;
  bool _initialized = false;
  final List<String> _buffer = [];

  Future<void> init() async {
    if (_initialized) return;
    try {
      final dir = await getApplicationDocumentsDirectory();
      _logFile = File('${dir.path}/khy-os.log');
      _initialized = true;
      _writeHeader();
    } catch (e) {
      _initialized = true;
    }
  }

  void _writeHeader() {
    final now = DateTime.now();
    final header = [
      '',
      '=' * 60,
      'khy-os 日志会话开始',
      '时间: ${_formatDateTime(now)}',
      '平台: ${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
      '=' * 60,
      '',
    ];
    for (final line in header) {
      _writeLine(line);
    }
  }

  void _writeLine(String line) {
    try {
      _logFile?.writeAsStringSync('$line\n', mode: FileMode.append);
    } catch (_) {}
  }

  String _formatDateTime(DateTime dt) {
    return '${dt.year}-${_pad(dt.month)}-${_pad(dt.day)} '
           '${_pad(dt.hour)}:${_pad(dt.minute)}:${_pad(dt.second)}.${_pad(dt.millisecond, 3)}';
  }

  String _pad(int n, [int width = 2]) => n.toString().padLeft(width, '0');

  String _levelLabel(LogLevel level) {
    switch (level) {
      case LogLevel.debug: return 'DBG';
      case LogLevel.info:  return 'INF';
      case LogLevel.warn:  return 'WRN';
      case LogLevel.error: return 'ERR';
    }
  }

  String _categoryLabel(LogCategory cat) {
    switch (cat) {
      case LogCategory.network: return 'NET';
      case LogCategory.dns:     return 'DNS';
      case LogCategory.auth:    return 'ATH';
      case LogCategory.ui:      return 'UI ';
      case LogCategory.config:  return 'CFG';
      case LogCategory.api:     return 'API';
      case LogCategory.error:   return 'ERR';
      case LogCategory.system:  return 'SYS';
    }
  }

  /// 记录日志
  void log(
    LogLevel level,
    LogCategory category,
    String message, {
    Map<String, dynamic>? details,
    Object? error,
    StackTrace? stackTrace,
  }) {
    final timestamp = _formatDateTime(DateTime.now());
    final levelStr = _levelLabel(level);
    final catStr = _categoryLabel(category);

    final buffer = StringBuffer();
    buffer.writeln('[$timestamp][$levelStr][$catStr] $message');

    if (details != null && details.isNotEmpty) {
      for (final entry in details.entries) {
        buffer.writeln('    ${entry.key}: ${entry.value}');
      }
    }

    if (error != null) {
      buffer.writeln('    ERROR: $error');
    }

    if (stackTrace != null) {
      final lines = stackTrace.toString().split('\n').take(5);
      for (final line in lines) {
        if (line.trim().isNotEmpty) {
          buffer.writeln('    $line');
        }
      }
    }

    final logText = buffer.toString();
    _buffer.add(logText);
    _writeLine(logText);

    // 保持缓冲区大小
    if (_buffer.length > 1000) {
      _buffer.removeRange(0, _buffer.length - 500);
    }
  }

  void d(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.debug, cat, msg, details: details);

  void i(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.info, cat, msg, details: details);

  void w(LogCategory cat, String msg, {Map<String, dynamic>? details, Object? error}) =>
      log(LogLevel.warn, cat, msg, details: details, error: error);

  void e(LogCategory cat, String msg, {Map<String, dynamic>? details, Object? error, StackTrace? stackTrace}) =>
      log(LogLevel.error, cat, msg, details: details, error: error, stackTrace: stackTrace);

  /// 网络请求专用
  void network({
    required String method,
    required String url,
    int? statusCode,
    int? durationMs,
    String? error,
    Map<String, dynamic>? extra,
  }) {
    final details = <String, dynamic>{
      'method': method,
      'url': url,
    };
    if (statusCode != null) details['status'] = statusCode;
    if (durationMs != null) details['duration'] = '${durationMs}ms';
    if (extra != null) details.addAll(extra);

    if (error != null) {
      e(LogCategory.network, '$method $url 失败', details: details, error: error);
    } else {
      i(LogCategory.network, '$method $url', details: details);
    }
  }

  /// DNS 解析专用
  void dns({
    required String hostname,
    required bool success,
    List<String>? ips,
    String? error,
    String? dohServer,
    int? durationMs,
  }) {
    final details = <String, dynamic>{
      'hostname': hostname,
      'success': success,
    };
    if (ips != null) details['ips'] = ips.join(', ');
    if (dohServer != null) details['doh_server'] = dohServer;
    if (durationMs != null) details['duration'] = '${durationMs}ms';

    if (success) {
      i(LogCategory.dns, 'DNS 解析成功: $hostname', details: details);
    } else {
      e(LogCategory.dns, 'DNS 解析失败: $hostname', details: details, error: error);
    }
  }

  /// API 调用专用
  void api({
    required String provider,
    required String model,
    required String action,
    bool success = true,
    int? tokensIn,
    int? tokensOut,
    int? durationMs,
    String? error,
  }) {
    final details = <String, dynamic>{
      'provider': provider,
      'model': model,
      'action': action,
    };
    if (tokensIn != null) details['tokens_in'] = tokensIn;
    if (tokensOut != null) details['tokens_out'] = tokensOut;
    if (durationMs != null) details['duration'] = '${durationMs}ms';

    if (success) {
      i(LogCategory.api, '$provider/$model $action 成功', details: details);
    } else {
      e(LogCategory.api, '$provider/$model $action 失败', details: details, error: error);
    }
  }

  /// 错误专用 - 包含完整诊断信息
  void err({
    required String code,
    required String message,
    String? resolution,
    Object? exception,
    StackTrace? stackTrace,
  }) {
    final details = <String, dynamic>{
      'error_code': code,
    };
    if (resolution != null) details['resolution'] = resolution;

    e(LogCategory.error, '[$code] $message',
        details: details, error: exception, stackTrace: stackTrace);
  }

  /// 获取日志文件路径
  String? get logFilePath => _logFile?.path;

  /// 读取全部日志
  Future<String> readLogs() async {
    try {
      if (_logFile != null && await _logFile!.exists()) {
        return await _logFile!.readAsString();
      }
      return '暂无日志';
    } catch (e) {
      return '读取日志失败: $e';
    }
  }

  /// 读取最近 N 行
  Future<String> readRecentLogs([int lines = 100]) async {
    try {
      final all = await readLogs();
      final allLines = all.split('\n');
      if (allLines.length <= lines) return all;
      return allLines.sublist(allLines.length - lines).join('\n');
    } catch (e) {
      return '读取失败: $e';
    }
  }

  /// 导出日志（带摘要）
  Future<String> exportLogs() async {
    final logs = await readLogs();
    final now = _formatDateTime(DateTime.now());
    final summary = [
      '# khy-os 日志导出',
      '# 导出时间: $now',
      '# 日志行数: ${logs.split('\n').length}',
      '#',
      '',
    ];
    return summary.join('\n') + logs;
  }

  /// 清空日志
  Future<void> clearLogs() async {
    try {
      if (_logFile != null && await _logFile!.exists()) {
        await _logFile!.writeAsString('');
        _writeHeader();
      }
      _buffer.clear();
    } catch (_) {}
  }

  /// 获取日志大小
  Future<String> getLogSize() async {
    try {
      if (_logFile != null && await _logFile!.exists()) {
        final size = await _logFile!.length();
        if (size < 1024) return '$size B';
        if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(1)} KB';
        return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
      }
      return '0 B';
    } catch (_) {
      return '未知';
    }
  }

  /// 获取错误统计
  Future<Map<String, int>> getErrorStats() async {
    final stats = <String, int>{};
    try {
      final logs = await readLogs();
      for (final line in logs.split('\n')) {
        if (line.contains('[ERR]')) {
          // 提取错误代码
          final match = RegExp(r'\[ERR\]\[([A-Z]{3})\]').firstMatch(line);
          if (match != null) {
            final cat = match.group(1)!;
            stats[cat] = (stats[cat] ?? 0) + 1;
          }
        }
      }
    } catch (_) {}
    return stats;
  }
}