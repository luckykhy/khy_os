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

/// 网络自动修复工具
/// 自动诊断并修复网络配置
class NetworkAutoFix {
  final SmartDns _smartDns = SmartDns();
  final AppLogger _logger = AppLogger();

  /// 执行自动修复
  Future<AutoFixResult> fix(String baseUrl) async {
    final hostname = _extractHost(baseUrl);
    _logger.i(LogCategory.system, '开始自动修复网络', details: {'hostname': hostname});

    // 步骤 1: 检查系统 DNS
    _logger.i(LogCategory.dns, '步骤1: 尝试系统 DNS');
    try {
      final result = await InternetAddress.lookup(hostname)
          .timeout(const Duration(seconds: 3));
      if (result.isNotEmpty) {
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

    // 步骤 2: 尝试原始 UDP DNS
    _logger.i(LogCategory.dns, '步骤2: 尝试原始 UDP DNS');
    try {
      final ips = await _smartDns.resolve(hostname);
      if (ips.isNotEmpty) {
        return AutoFixResult(
          success: true,
          method: 'raw_udp_dns',
          message: '原始 UDP DNS 解析成功',
          details: {'ips': ips.join(', ')},
        );
      }
    } catch (e) {
      _logger.w(LogCategory.dns, '原始 UDP DNS 失败', error: e);
    }

    // 步骤 3: 使用内置 IP
    _logger.i(LogCategory.dns, '步骤3: 尝试内置 IP');
    if (_smartDns.hasHardcodedIp(hostname)) {
      final ips = SmartDns.hardcodedIps[hostname];
      return AutoFixResult(
        success: true,
        method: 'hardcoded_ip',
        message: '使用内置 IP 地址',
        details: {'ips': ips?.join(', ')},
      );
    }

    // 所有方式均失败
    return AutoFixResult(
      success: false,
      method: 'all_failed',
      message: '所有修复方式均失败，请检查网络设置',
      details: {'tried': ['system_dns', 'raw_udp_dns', 'hardcoded_ip']},
    );
  }

  /// 自动修复并返回可用的 IP
  Future<String?> fixAndGetIp(String baseUrl) async {
    final hostname = _extractHost(baseUrl);
    final ips = await _smartDns.resolve(hostname);
    return ips.isNotEmpty ? ips.first : null;
  }

  /// 预加载常用域名 IP（后台执行）
  Future<void> preloadCommonIps() async {
    _logger.i(LogCategory.system, '预加载常用域名 IP');
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