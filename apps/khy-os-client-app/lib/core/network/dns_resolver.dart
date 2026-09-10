import 'package:dio/dio.dart';

/// DNS-over-HTTPS 解析器
/// 绕过运营商 DNS，使用 DoH 解析域名
class DnsOverHttps {
  final Dio _dio;
  
  // 多个 DoH 服务器，按优先级排列
  static const List<String> _dohServers = [
    'https://cloudflare-dns.com/dns-query',      // Cloudflare
    'https://dns.google/resolve',                 // Google
    'https://dns.alidns.com/dns-query',           // 阿里
    'https://doh.pub/dns-query',                  // 腾讯
  ];

  DnsOverHttps({Dio? dio}) : _dio = dio ?? Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 5),
    headers: {'Accept': 'application/dns-json'},
  ));

  /// 解析域名获取 IP 地址
  Future<List<String>> resolve(String hostname) async {
    final errors = <String>[];
    
    for (final server in _dohServers) {
      try {
        final response = await _dio.get(
          server,
          queryParameters: {
            'name': hostname,
            'type': 'A',
          },
        );
        
        if (response.statusCode == 200 && response.data is Map) {
          final data = response.data as Map<String, dynamic>;
          final answers = data['Answer'] as List?;
          
          if (answers != null && answers.isNotEmpty) {
            final ips = answers
                .map((a) => a['data'] as String?)
                .where((ip) => ip != null)
                .cast<String>()
                .toList();
            if (ips.isNotEmpty) return ips;
          }
        }
      } catch (e) {
        errors.add('$server: $e');
      }
    }
    
    throw Exception('DoH 解析失败: ${errors.join('; ')}');
  }

  /// 解析并返回第一个可用 IP
  Future<String> resolveFirst(String hostname) async {
    final ips = await resolve(hostname);
    return ips.first;
  }
}

/// 从 URL 中提取主机名
String extractHostname(String url) {
  try {
    final uri = Uri.parse(url);
    return uri.host;
  } catch (_) {
    var host = url.replaceAll(RegExp(r'^https?://'), '');
    host = host.split('/').first;
    host = host.split(':').first;
    return host;
  }
}