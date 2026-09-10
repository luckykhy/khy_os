import 'dart:io';
import 'dart:typed_data';
import '../services/app_logger.dart';

/// 智能 DNS 解析器
/// 自动选择最佳解析方式：系统 DNS → 原始 UDP DNS → 内置 IP
class SmartDns {
  final AppLogger _logger = AppLogger();

  /// 内置 IP 映射（当 DNS 完全不可用时的最后手段）
  static const Map<String, List<String>> hardcodedIps = {
    'api.commandcode.ai': ['172.67.167.23', '104.21.49.202'],
    'api.deepseek.com': ['182.247.248.128', '103.220.64.100'],
    'open.bigmodel.cn': ['8.137.193.178', '8.137.196.223'],
    'dashscope.aliyuncs.com': ['39.96.213.166', '8.140.217.18'],
    'api.moonshot.cn': ['8.147.223.37'],
    'openrouter.ai': ['104.18.2.115', '104.18.3.115'],
    'api.openai.com': ['13.107.42.14', '204.79.197.200'],
    'opencode.ai': ['104.21.23.123', '172.67.178.42'],
  };

  /// 公共 DNS 服务器
  static const List<_DnsServer> _publicDnsServers = [
    _DnsServer('阿里 DNS', '223.5.5.5', 53),
    _DnsServer('腾讯 DNS', '119.29.29.29', 53),
    _DnsServer('114 DNS', '114.114.114.114', 53),
    _DnsServer('Google DNS', '8.8.8.8', 53),
  ];

  /// 解析域名，自动选择最佳方式
  Future<List<String>> resolve(String hostname) async {
    _logger.i(LogCategory.dns, '开始智能解析', details: {'hostname': hostname});

    // 方式 1: 系统 DNS
    try {
      final result = await InternetAddress.lookup(hostname)
          .timeout(const Duration(seconds: 3));
      if (result.isNotEmpty) {
        _logger.dns(hostname: hostname, success: true, ips: result.map((e) => e.address).toList());
        return result.map((e) => e.address).toList();
      }
    } catch (e) {
      _logger.w(LogCategory.dns, '系统 DNS 解析失败', error: e);
    }

    // 方式 2: 原始 UDP DNS 查询
    final udpResult = await _resolveViaRawUdp(hostname);
    if (udpResult.isNotEmpty) {
      return udpResult;
    }

    // 方式 3: 内置 IP
    if (hardcodedIps.containsKey(hostname)) {
      final ips = hardcodedIps[hostname]!;
      _logger.dns(hostname: hostname, success: true, ips: ips);
      return ips;
    }

    _logger.dns(hostname: hostname, success: false, error: '所有方式均失败');
    return [];
  }

  /// 通过原始 UDP 查询 DNS
  Future<List<String>> _resolveViaRawUdp(String hostname) async {
    for (final server in _publicDnsServers) {
      try {
        final ips = await _queryDnsServer(hostname, server.address, server.port)
            .timeout(const Duration(seconds: 3));
        if (ips.isNotEmpty) {
          _logger.dns(hostname: hostname, success: true, ips: ips);
          return ips;
        }
      } catch (e) {
        _logger.w(LogCategory.dns, 'UDP DNS ${server.name} 失败', error: e);
      }
    }
    return [];
  }

  /// 向指定 DNS 服务器发送 UDP 查询
  Future<List<String>> _queryDnsServer(String hostname, String server, int port) async {
    final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    try {
      // 构建 DNS 查询报文
      final query = _buildDnsQuery(hostname);
      socket.send(query, InternetAddress(server), port);

      // 等待响应
      await for (final event in socket) {
        if (event == RawSocketEvent.read) {
          final packet = socket.receive();
          if (packet != null) {
            return _parseDnsResponse(packet.data);
          }
        }
      }
    } finally {
      socket.close();
    }
    return [];
  }

  /// 构建 DNS A 记录查询报文
  Uint8List _buildDnsQuery(String hostname) {
    final buffer = BytesBuilder();

    // Transaction ID
    buffer.addByte(0x12); buffer.addByte(0x34);
    // Flags: standard query
    buffer.addByte(0x01); buffer.addByte(0x00);
    // Questions: 1
    buffer.addByte(0x00); buffer.addByte(0x01);
    // Answer RRs: 0
    buffer.addByte(0x00); buffer.addByte(0x00);
    // Authority RRs: 0
    buffer.addByte(0x00); buffer.addByte(0x00);
    // Additional RRs: 0
    buffer.addByte(0x00); buffer.addByte(0x00);

    // Query name
    for (final part in hostname.split('.')) {
      final bytes = part.codeUnits;
      buffer.addByte(bytes.length);
      buffer.add(bytes);
    }
    buffer.addByte(0x00); // End of name

    // Type: A
    buffer.addByte(0x00); buffer.addByte(0x01);
    // Class: IN
    buffer.addByte(0x00); buffer.addByte(0x01);

    return buffer.toBytes();
  }

  /// 解析 DNS 响应报文
  List<String> _parseDnsResponse(Uint8List data) {
    final ips = <String>[];
    if (data.length < 12) return ips;

    // 跳过 header (12 bytes)
    var offset = 12;

    // 跳过 question section
    final questions = (data[4] << 8) | data[5];
    for (var i = 0; i < questions; i++) {
      while (offset < data.length && data[offset] != 0) {
        if ((data[offset] & 0xC0) == 0xC0) { offset += 2; break; }
        offset += data[offset] + 1;
      }
      if (data[offset] == 0) offset++;
      offset += 4; // Type + Class
    }

    // 解析 answer section
    final answers = (data[6] << 8) | data[7];
    for (var i = 0; i < answers && offset + 12 <= data.length; i++) {
      // 跳过 name (可能压缩)
      if ((data[offset] & 0xC0) == 0xC0) {
        offset += 2;
      } else {
        while (offset < data.length && data[offset] != 0) offset++;
        offset++;
      }

      if (offset + 10 > data.length) break;

      final type = (data[offset] << 8) | data[offset + 1];
      offset += 8; // Type(2) + Class(2) + TTL(4)
      final rdLength = (data[offset] << 8) | data[offset + 1];
      offset += 2;

      if (type == 1 && rdLength == 4 && offset + 4 <= data.length) {
        ips.add('${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}');
      }
      offset += rdLength;
    }

    return ips;
  }

  /// 获取最佳可用 IP（自动诊断）
  Future<String?> resolveBest(String hostname) async {
    final ips = await resolve(hostname);
    return ips.isNotEmpty ? ips.first : null;
  }

  /// 检查是否为已知域名，返回内置 IP
  bool hasHardcodedIp(String hostname) => hardcodedIps.containsKey(hostname);

  /// 获取所有已知域名
  List<String> get knownDomains => hardcodedIps.keys.toList();
}

class _DnsServer {
  final String name;
  final String address;
  final int port;
  const _DnsServer(this.name, this.address, this.port);
}