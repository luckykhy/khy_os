import 'dart:io';
import 'dart:convert';
import 'package:path_provider/path_provider.dart';

/// ───────────────────────────────────────────────
/// khy-os 日志规范 v2
///
/// 错误码体系（3 位数字）：
///   E1xx  网络类  E101 DNS / E102 连接 / E103 超时 / E104 HTTP 4xx / E105 HTTP 5xx
///   E2xx  API 类  E201 认证 / E202 参数 / E203 模型 / E204 限流
///   E3xx  工具类  E301 工具执行 / E302 无障碍 / E303 截屏 / E304 Shell
///   E4xx  系统类  E401 权限 / E402 配置 / E403 存储
///   E5xx  未知    E500
///
/// 日志级别：
///   DEBUG  开发调试，Release 不输出
///   INFO   正常操作记录
///   WARN   可恢复的异常（自动重试、降级）
///   ERROR  需关注的错误（用户可见）
///   FATAL  致命错误（无法恢复，需人工介入）
///
/// 日志格式：
///   [时间戳][级别][分类] 消息
///     code: E101
///     context: {...}
///     error: ...
///     stack: ...（最多 5 帧）
/// ───────────────────────────────────────────────

/// 日志级别
enum LogLevel { debug, info, warn, error, fatal }

/// 日志分类
enum LogCategory {
  network, // 网络请求
  dns,     // DNS 解析
  auth,    // 认证
  ui,      // 界面操作
  config,  // 配置
  api,     // API 调用
  tool,    // 工具执行
  device,  // 设备操作
  system,  // 系统
  unknown, // 未分类
}

/// 错误码常量
class ErrorCode {
  // ── E1xx 网络 ──
  static const String dns = 'E101';
  static const String connection = 'E102';
  static const String timeout = 'E103';
  static const String http4xx = 'E104';
  static const String http5xx = 'E105';

  // ── E2xx API ──
  static const String auth = 'E201';
  static const String param = 'E202';
  static const String model = 'E203';
  static const String rateLimit = 'E204';

  // ── E3xx 工具 ──
  static const String toolExec = 'E301';
  static const String accessibility = 'E302';
  static const String screenCapture = 'E303';
  static const String shell = 'E304';

  // ── E4xx 系统 ──
  static const String permission = 'E401';
  static const String configMissing = 'E402';
  static const String storage = 'E403';

  // ── E5xx 未知 ──
  static const String unknown = 'E500';

  /// 根据 HTTP 状态码返回错误码
  static String forHttpStatus(int code) {
    if (code >= 400 && code < 500) return http4xx;
    if (code >= 500) return http5xx;
    return unknown;
  }
}

/// 结构化错误记录
class ErrorRecord {
  final String code;
  final String message;
  final LogCategory category;
  final Map<String, dynamic> context;
  final Object? exception;
  final StackTrace? stack;
  final DateTime timestamp;
  final LogLevel severity;

  const ErrorRecord({
    required this.code,
    required this.message,
    required this.category,
    required this.context,
    this.exception,
    this.stack,
    required this.timestamp,
    this.severity = LogLevel.error,
  });

  /// 生成人类可读摘要
  String get summary => '[$code] $message (${category.name})';

  /// 生成日志行
  String toLogLine() {
    final ts = '${timestamp.year}-${timestamp.month.toString().padLeft(2, '0')}-${timestamp.day.toString().padLeft(2, '0')} '
        '${timestamp.hour.toString().padLeft(2, '0')}:${timestamp.minute.toString().padLeft(2, '0')}:${timestamp.second.toString().padLeft(2, '0')}';
    final sev = severity == LogLevel.fatal ? 'FTL' : (severity == LogLevel.error ? 'ERR' : (severity == LogLevel.warn ? 'WRN' : 'INF'));
    final cat = category.name.toUpperCase().substring(0, 3);
    final sb = StringBuffer();
    sb.writeln('$ts[$sev][$cat] $message');
    sb.writeln('    code: $code');
    if (context.isNotEmpty) {
      sb.writeln('    context: ${jsonEncode(context)}');
    }
    if (exception != null) {
      sb.writeln('    error: $exception');
    }
    if (stack != null) {
      final lines = stack!.toString().split('\n').take(5);
      for (final line in lines) {
        if (line.trim().isNotEmpty) {
          sb.writeln('    ${line.trim()}');
        }
      }
    }
    return sb.toString();
  }
}

/// 结构化日志服务
class AppLogger {
  static final AppLogger _instance = AppLogger._internal();
  factory AppLogger() => _instance;
  AppLogger._internal();

  File? _logFile;
  bool _initialized = false;
  final List<String> _buffer = [];

  // 错误去重：code + message 的组合，10 秒内不重复记录
  final Map<String, DateTime> _errorDedup = {};
  static const _dedupWindow = Duration(seconds: 10);

  // 错误记录（内存中保留最近 100 条）
  final List<ErrorRecord> _errorRecords = [];
  static const _maxErrorRecords = 100;

  Future<void> init() async {
    if (_initialized) return;
    try {
      final dir = await getApplicationDocumentsDirectory();
      _logFile = File('${dir.path}/khy-os.log');
      _initialized = true;
      _writeHeader();
    } catch (_) {
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
      '日志规范: v2（错误码 + 上下文 + 自动堆栈）',
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
      case LogLevel.debug:
        return 'DBG';
      case LogLevel.info:
        return 'INF';
      case LogLevel.warn:
        return 'WRN';
      case LogLevel.error:
        return 'ERR';
      case LogLevel.fatal:
        return 'FTL';
    }
  }

  String _catLabel(LogCategory cat) {
    switch (cat) {
      case LogCategory.network:
        return 'NET';
      case LogCategory.dns:
        return 'DNS';
      case LogCategory.auth:
        return 'ATH';
      case LogCategory.ui:
        return 'UI ';
      case LogCategory.config:
        return 'CFG';
      case LogCategory.api:
        return 'API';
      case LogCategory.tool:
        return 'TOL';
      case LogCategory.device:
        return 'DEV';
      case LogCategory.system:
        return 'SYS';
      case LogCategory.unknown:
        return 'UNK';
    }
  }

  // ─────────────────────────────────────────────
  // 核心日志方法
  // ─────────────────────────────────────────────

  /// 通用日志
  void log(
    LogLevel level,
    LogCategory category,
    String message, {
    Map<String, dynamic>? details,
    Object? error,
    StackTrace? stackTrace,
    String? code,
  }) {
    final timestamp = _formatDateTime(DateTime.now());
    final levelStr = _levelLabel(level);
    final catStr = _catLabel(category);

    final buffer = StringBuffer();
    final codeStr = code != null ? ' $code' : '';
    buffer.writeln('[$timestamp][$levelStr][$catStr]$codeStr $message');

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
          buffer.writeln('    ${line.trim()}');
        }
      }
    }

    final logText = buffer.toString();
    _buffer.add(logText);
    _writeLine(logText);

    if (_buffer.length > 1000) {
      _buffer.removeRange(0, _buffer.length - 500);
    }
  }

  // ── 快捷方法 ──

  void d(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.debug, cat, msg, details: details);

  void i(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.info, cat, msg, details: details);

  void w(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          String? code}) =>
      log(LogLevel.warn, cat, msg,
          details: details, error: error, code: code);

  void e(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          StackTrace? stackTrace,
          String? code,
          LogLevel severity = LogLevel.error}) =>
      log(LogLevel.error, cat, msg,
          details: details,
          error: error,
          stackTrace: stackTrace,
          code: code);

  void f(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          StackTrace? stackTrace,
          String? code}) =>
      log(LogLevel.fatal, cat, msg,
          details: details, error: error, stackTrace: stackTrace, code: code);

  // ─────────────────────────────────────────────
  // 错误记录方法（带去重 + 自动堆栈 + 上下文）
  // ─────────────────────────────────────────────

  /// 记录一个结构化错误（带去重、自动堆栈）
  ///
  /// [code]    错误码，如 ErrorCode.dns
  /// [message] 人类可读描述
  /// [category] 日志分类
  /// [context]  上下文（屏幕、模式、操作等）
  /// [exception] 原始异常对象
  /// [stack]   堆栈（null 则自动捕获）
  void recordError({
    required String code,
    required String message,
    required LogCategory category,
    Map<String, dynamic>? context,
    Object? exception,
    StackTrace? stack,
    LogLevel severity = LogLevel.error,
  }) {
    // 去重检查
    final dedupKey = '$code|$message';
    final now = DateTime.now();
    final lastTime = _errorDedup[dedupKey];
    if (lastTime != null && now.difference(lastTime) < _dedupWindow) {
      return; // 10 秒内同 code+message 不重复记录
    }
    _errorDedup[dedupKey] = now;

    // 自动捕获堆栈
    final autoStack = stack ?? StackTrace.current;

    final record = ErrorRecord(
      code: code,
      message: message,
      category: category,
      context: context ?? {},
      exception: exception,
      stack: autoStack,
      timestamp: now,
      severity: severity,
    );

    _errorRecords.add(record);
    if (_errorRecords.length > _maxErrorRecords) {
      _errorRecords.removeRange(0, _errorRecords.length - _maxErrorRecords);
    }

    // 写入日志
    e(
      category,
      message,
      details: context,
      error: exception,
      stackTrace: autoStack,
      code: code,
      severity: severity,
    );
  }

  /// 便捷：网络错误
  void networkError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.network,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：API 错误
  void apiError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.api,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：工具错误
  void toolError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.tool,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：设备错误
  void deviceError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.device,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：系统错误
  void systemError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.system,
        context: context,
        exception: exception,
        severity: severity,
      );

  // ─────────────────────────────────────────────
  // 专用日志方法
  // ─────────────────────────────────────────────

  /// 网络请求
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
      final code = statusCode != null
          ? ErrorCode.forHttpStatus(statusCode)
          : ErrorCode.connection;
      recordError(
        code: code,
        message: '$method $url 失败 (HTTP ${statusCode ?? "?"})',
        category: LogCategory.network,
        context: details,
        exception: error,
      );
    } else {
      i(LogCategory.network, '$method $url', details: details);
    }
  }

  /// DNS 解析
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
      i(LogCategory.dns, 'DNS 解析: $hostname', details: details);
    } else {
      recordError(
        code: ErrorCode.dns,
        message: 'DNS 解析失败: $hostname',
        category: LogCategory.dns,
        context: details,
        exception: error,
      );
    }
  }

  /// API 调用
  void api({
    required String provider,
    required String model,
    required String action,
    bool success = true,
    int? tokensIn,
    int? tokensOut,
    int? durationMs,
    String? error,
    int? statusCode,
  }) {
    final details = <String, dynamic>{
      'provider': provider,
      'model': model,
      'action': action,
    };
    if (tokensIn != null) details['tokens_in'] = tokensIn;
    if (tokensOut != null) details['tokens_out'] = tokensOut;
    if (durationMs != null) details['duration'] = '${durationMs}ms';
    if (statusCode != null) details['status'] = statusCode;

    if (success) {
      i(LogCategory.api, '$provider/$model $action', details: details);
    } else {
      final code = statusCode != null
          ? ErrorCode.forHttpStatus(statusCode)
          : ErrorCode.http4xx;
      recordError(
        code: code,
        message: '$provider/$model $action 失败',
        category: LogCategory.api,
        context: details,
        exception: error,
      );
    }
  }

  // ─────────────────────────────────────────────
  // 查询与导出
  // ─────────────────────────────────────────────

  String? get logFilePath => _logFile?.path;

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

  Future<String> exportLogs() async {
    final logs = await readLogs();
    final now = _formatDateTime(DateTime.now());
    final errors = _errorRecords.toList();
    final summary = [
      '# khy-os 日志导出',
      '# 导出时间: $now',
      '# 日志行数: ${logs.split("\n").length}',
      '# 错误记录: ${errors.length} 条',
      '#',
      if (errors.isNotEmpty) ...[
        '#',
        '# 错误摘要',
        ...errors.map((e) => '#   ${e.summary} @ ${_formatDateTime(e.timestamp)}'),
        '#',
      ],
      '',
    ];
    return summary.join('\n') + logs;
  }

  Future<void> clearLogs() async {
    try {
      if (_logFile != null && await _logFile!.exists()) {
        await _logFile!.writeAsString('');
        _writeHeader();
      }
      _buffer.clear();
      _errorRecords.clear();
    } catch (_) {}
  }

  Future<String> getLogSize() async {
    try {
      if (_logFile != null && await _logFile!.exists()) {
        final size = await _logFile!.length();
        if (size < 1024) return '$size B';
        if (size < 1024 * 1024) {
          return '${(size / 1024).toStringAsFixed(1)} KB';
        }
        return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
      }
      return '0 B';
    } catch (_) {
      return '未知';
    }
  }

  /// 获取最近的错误记录
  List<ErrorRecord> get recentErrors => List.unmodifiable(_errorRecords);

  /// 按错误码统计
  Map<String, int> get errorCodeStats {
    final stats = <String, int>{};
    for (final e in _errorRecords) {
      stats[e.code] = (stats[e.code] ?? 0) + 1;
    }
    return stats;
  }

  /// 获取错误统计（兼容旧接口）
  Future<Map<String, int>> getErrorStats() async {
    return errorCodeStats;
  }

  // ─────────────────────────────────────────────
  // 私有辅助
  // ─────────────────────────────────────────────

  String _sevLabel(LogLevel level) => _levelLabel(level);
}

/// 兼容旧接口
typedef ApiConfig = AppLogger;
