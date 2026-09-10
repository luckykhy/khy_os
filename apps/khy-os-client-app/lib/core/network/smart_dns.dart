import 'dart:io';
import '../services/app_logger.dart';

/// 智能 DNS 解析器
/// 策略：系统 DNS → IP 缓存 → 内置 IP
/// 注意：不再使用 raw UDP socket（被 EMUI/Android 9 封锁）
class SmartDns {
  final AppLogger _logger = AppLogger();

  /// IP 缓存（hostname → (ip, expiry)）
  final Map<String, _IpCacheEntry> _cache = {};
  static const _cacheTtl = Duration(hours: 6);

  /// 内置 IP 映射（DNS 完全不可用时的最后手段）
  static const Map<String, List<String>> hardcodedIps = {
    'api.commandcode.ai': ['172.67.167.23', '104.21.49.202'],
    'api.deepseek.com': ['182.247.248.128', '103.220.64.100'],
    'open.bigmodel.cn': ['8.137.193.178', '8.137.196.223'],
    'dashscope.aliyuncs.com': ['39.96.213.166', '8.140.217.18'],
    'api.moonshot.cn': ['8.147.223.37'],
    'openrouter.ai': ['104.18.2.115', '104.18.3.115'],
    'api.openai.com': ['13.107.42.14', '204.79.197.200'],
    'opencode.ai': ['104.21.23.123', '172.67.178.42'],
    'apihub.agnes-ai.com': ['104.21.49.202'],
    'speed44.toter.me': ['104.21.49.202'],
  };

  /// 解析域名：缓存 → 系统 DNS → 内置 IP
  Future<List<String>> resolve(String hostname) async {
    // 1. 查缓存
    final cached = cachedIp(hostname);
    if (cached != null) {
      _logger.i(LogCategory.dns, '缓存命中: $hostname → $cached');
      return [cached];
    }

    // 2. 系统 DNS（Android 原生，不受 UDP 限制）
    try {
      final result = await InternetAddress.lookup(hostname)
          .timeout(const Duration(seconds: 5));
      final ips = result.where((e) => e.address.contains(':') == false)
          .map((e) => e.address)
          .toList();
      if (ips.isNotEmpty) {
        _cache[hostname] = _IpCacheEntry(ips, DateTime.now().add(_cacheTtl));
        _logger.i(LogCategory.dns, '系统 DNS 成功: $hostname',
            details: {'ips': ips.join(', ')});
        return ips;
      }
    } catch (e) {
      _logger.w(LogCategory.dns, '系统 DNS 失败: $hostname', error: e);
    }

    // 3. 内置 IP
    if (hardcodedIps.containsKey(hostname)) {
      final ips = hardcodedIps[hostname]!;
      _cache[hostname] = _IpCacheEntry(
          ips, DateTime.now().add(const Duration(hours: 24)));
      _logger.i(LogCategory.dns, '内置 IP: $hostname',
          details: {'ips': ips.join(', ')});
      return ips;
    }

    _logger.w(LogCategory.dns, '所有 DNS 方式失败: $hostname');
    return [];
  }

  /// 获取缓存 IP（不触发解析）
  String? cachedIp(String hostname) {
    final entry = _cache[hostname];
    if (entry == null) return null;
    if (DateTime.now().isAfter(entry.expiry)) {
      _cache.remove(hostname);
      return null;
    }
    return entry.ips.isNotEmpty ? entry.ips.first : null;
  }

  /// 获取最佳可用 IP
  Future<String?> resolveBest(String hostname) async {
    final cached = cachedIp(hostname);
    if (cached != null) return cached;
    final ips = await resolve(hostname);
    return ips.isNotEmpty ? ips.first : null;
  }

  bool hasHardcodedIp(String hostname) => hardcodedIps.containsKey(hostname);

  List<String> get knownDomains => hardcodedIps.keys.toList();

  /// 手动缓存 IP（供外部使用）
  void cacheIp(String hostname, List<String> ips) {
    _cache[hostname] = _IpCacheEntry(ips, DateTime.now().add(_cacheTtl));
    _logger.i(LogCategory.dns, 'IP 已缓存: $hostname → ${ips.first}');
  }

  /// 清除缓存
  void clearCache() => _cache.clear();
}

class _IpCacheEntry {
  final List<String> ips;
  final DateTime expiry;
  _IpCacheEntry(this.ips, this.expiry);
}
