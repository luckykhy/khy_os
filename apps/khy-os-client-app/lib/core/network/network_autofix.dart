import 'dart:io';
import 'smart_dns.dart';
import '../services/app_logger.dart';

/// 网络自动修复结果
class AutoFixResult {
  final bool success;
  final String method;
  final String message;
  final Map<String, dynamic> details;

  AutoFixResult({
    required this.success,
    required this.method,
    required this.message,
    this.details = const {},
  });
}

/// 网络自动修复工具（带冷却期防循环）
class NetworkAutoFix {
  final SmartDns _smartDns = SmartDns();
  final AppLogger _logger = AppLogger();

  // ── 冷却期：30 秒内不重复触发 ──
  DateTime _lastFixTime = DateTime.fromMillisecondsSinceEpoch(0);
  static const _cooldown = Duration(seconds: 30);

  /// 是否可以执行修复（冷却期检查）
  bool get canFix =>
      DateTime.now().difference(_lastFixTime) >= _cooldown;

  /// 执行自动修复（带冷却期）
  Future<AutoFixResult> fix(String baseUrl) async {
    if (!canFix) {
      _logger.i(LogCategory.system, '自动修复冷却中，跳过');
      return AutoFixResult(
        success: false,
        method: 'cooldown',
        message: '修复冷却中（${_cooldown.inSeconds}s 内不重复触发）',
      );
    }
    _lastFixTime = DateTime.now();

    final hostname = _extractHost(baseUrl);
    _logger.i(LogCategory.system, '开始自动修复网络',
        details: {'hostname': hostname});

    // 步骤 1: 系统 DNS
    _logger.i(LogCategory.dns, '步骤 1/3: 系统 DNS');
    try {
      final result = await InternetAddress.lookup(hostname)
          .timeout(const Duration(seconds: 3));
      if (result.isNotEmpty) {
        _logger.i(LogCategory.dns, '系统 DNS 成功',
            details: {'ip': result.first.address});
        return AutoFixResult(
          success: true,
          method: 'system_dns',
          message: '系统 DNS 正常',
          details: {'ip': result.first.address},
        );
      }
    } catch (e) {
      _logger.w(LogCategory.dns, '系统 DNS 失败', error: e);
    }

    // 步骤 2: SmartDNS（DoH + 缓存）
    _logger.i(LogCategory.dns, '步骤 2/3: SmartDNS 解析');
    try {
      final ips = await _smartDns.resolve(hostname);
      if (ips.isNotEmpty) {
        _logger.i(LogCategory.dns, 'SmartDNS 成功',
            details: {'ips': ips.join(', ')});
        return AutoFixResult(
          success: true,
          method: 'smart_dns',
          message: 'SmartDNS 解析成功',
          details: {'ips': ips.join(', ')},
        );
      }
    } catch (e) {
      _logger.w(LogCategory.dns, 'SmartDNS 失败', error: e);
    }

    // 步骤 3: 内置 IP
    _logger.i(LogCategory.dns, '步骤 3/3: 内置 IP 缓存');
    if (_smartDns.hasHardcodedIp(hostname)) {
      final ips = SmartDns.hardcodedIps[hostname];
      return AutoFixResult(
        success: true,
        method: 'hardcoded_ip',
        message: '使用内置 IP',
        details: {'ips': ips?.join(', ')},
      );
    }

    _logger.w(LogCategory.dns, '所有修复方式均失败');
    return AutoFixResult(
      success: false,
      method: 'all_failed',
      message: '所有修复方式均失败',
      details: {'tried': ['system_dns', 'smart_dns', 'hardcoded_ip']},
    );
  }

  /// 获取可用 IP
  Future<String?> fixAndGetIp(String baseUrl) async {
    final hostname = _extractHost(baseUrl);
    // 先查缓存
    final cached = _smartDns.cachedIp(hostname);
    if (cached != null) return cached;

    final ips = await _smartDns.resolve(hostname);
    return ips.isNotEmpty ? ips.first : null;
  }

  Future<void> preloadCommonIps() async {
    for (final domain in _smartDns.knownDomains) {
      try {
        await _smartDns.resolve(domain);
      } catch (_) {}
    }
  }

  String _extractHost(String url) {
    try {
      return Uri.parse(url).host;
    } catch (_) {
      var host = url.replaceAll(RegExp(r'^https?://'), '');
      host = host.split('/').first;
      host = host.split(':').first;
      return host;
    }
  }
}
