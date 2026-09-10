import 'dart:io';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'smart_dns.dart';

class DiagnosticResult {
  final String name;
  final bool success;
  final String message;
  final int? durationMs;
  final Map<String, dynamic> details;
  DiagnosticResult({required this.name, required this.success, required this.message, this.durationMs, this.details = const {}});
}

class NetworkDiagnostic {
  final SmartDns _smartDns = SmartDns();
  final List<DiagnosticResult> _results = [];
  final List<String> _detailedLogs = [];
  List<DiagnosticResult> get results => _results;
  List<String> get detailedLogs => _detailedLogs;

  Future<List<DiagnosticResult>> runFullDiagnostic() async {
    _results.clear();
    _detailedLogs.clear();
    _addLog('=== 网络诊断开始 ===');
    _addLog('时间: ${DateTime.now().toIso8601String()}');
    _addLog('设备: ${Platform.operatingSystem} ${Platform.operatingSystemVersion}');
    await _checkSystemInfo();
    await _checkSystemDns();
    await _checkSmartDns();
    await _checkRawUdpDns();
    await _checkTcpConnectivity();
    await _checkHttpsConnection();
    _addLog('');
    _addLog('=== 诊断完成 ===');
    return _results;
  }

  void _addLog(String msg) {
    _detailedLogs.add(msg);
  }

  Future<void> _checkSystemInfo() async {
    _addLog('--- 系统网络信息 ---');
    try {
      final interfaces = await NetworkInterface.list();
      for (final iface in interfaces) {
        final addrs = iface.addresses.map((a) => a.address).join(', ');
        _addLog('接口: ${iface.name} - $addrs');
        _results.add(DiagnosticResult(
          name: '网卡 ${iface.name}',
          success: true,
          message: iface.addresses.isNotEmpty ? iface.addresses.first.address : '无IP',
        ));
      }
    } catch (e) {
      _addLog('获取网卡信息失败: $e');
    }
    _addLog('');
  }

  Future<void> _checkSystemDns() async {
    _addLog('--- 系统DNS解析 ---');
    final targets = [
      {'n': '百度', 'h': 'www.baidu.com'},
      {'n': '腾讯', 'h': 'www.qq.com'},
      {'n': '阿里', 'h': 'www.taobao.com'},
    ];
    for (final d in targets) {
      final start = DateTime.now();
      try {
        final results = await InternetAddress.lookup(d['h']!).timeout(const Duration(seconds: 3));
        final ms = DateTime.now().difference(start).inMilliseconds;
        _addLog('OK ${d['h']} -> ${results.first.address} (${ms}ms)');
        _results.add(DiagnosticResult(name: '系统DNS ${d['n']}', success: true, message: results.first.address, durationMs: ms));
      } catch (e) {
        _addLog('FAIL ${d['h']} -> 解析失败');
        _results.add(DiagnosticResult(name: '系统DNS ${d['n']}', success: false, message: '解析失败'));
      }
    }
    _addLog('');
  }

  Future<void> _checkSmartDns() async {
    _addLog('--- 智能DNS解析 (内置) ---');
    final targets = [
      {'n': 'Command Code', 'h': 'api.commandcode.ai'},
      {'n': 'DeepSeek', 'h': 'api.deepseek.com'},
      {'n': '智谱GLM', 'h': 'open.bigmodel.cn'},
      {'n': '阿里通义', 'h': 'dashscope.aliyuncs.com'},
      {'n': 'OpenRouter', 'h': 'openrouter.ai'},
      {'n': 'OpenAI', 'h': 'api.openai.com'},
    ];
    for (final d in targets) {
      final start = DateTime.now();
      try {
        final ips = await _smartDns.resolve(d['h']!);
        final ms = DateTime.now().difference(start).inMilliseconds;
        if (ips.isNotEmpty) {
          _addLog('OK ${d['h']} -> ${ips.join(', ')} (${ms}ms)');
          _results.add(DiagnosticResult(name: '智能解析 ${d['n']}', success: true, message: ips.first, durationMs: ms, details: {'ips': ips}));
        } else {
          _addLog('FAIL ${d['h']} -> 无可用IP');
          _results.add(DiagnosticResult(name: '智能解析 ${d['n']}', success: false, message: '无可用IP'));
        }
      } catch (e) {
        _addLog('FAIL ${d['h']} -> 异常');
        _results.add(DiagnosticResult(name: '智能解析 ${d['n']}', success: false, message: '解析异常'));
      }
    }
    _addLog('');
  }

  Future<void> _checkRawUdpDns() async {
    _addLog('--- 原始UDP DNS测试 ---');
    final dnsServers = [
      {'n': '阿里DoT', 'ip': '223.5.5.5'},
      {'n': '腾讯DoT', 'ip': '119.29.29.99'},
      {'n': 'Google', 'ip': '8.8.8.8'},
    ];
    for (final dns in dnsServers) {
      try {
        final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
        socket.send(
          Uint8List.fromList([
            0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x03, 0x77, 0x77, 0x77,
            0x05, 0x62, 0x61, 0x69, 0x64, 0x75, 0x03, 0x63,
            0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01,
          ]),
          InternetAddress(dns['ip']!),
          53,
        );
        await Future.delayed(const Duration(milliseconds: 500));
        socket.close();
        _addLog('OK ${dns['n']} UDP可达');
        _results.add(DiagnosticResult(name: 'UDP ${dns['n']}', success: true, message: 'UDP可达'));
      } catch (e) {
        _addLog('FAIL ${dns['n']} UDP不可达');
        _results.add(DiagnosticResult(name: 'UDP ${dns['n']}', success: false, message: 'UDP不可达'));
      }
    }
    _addLog('');
  }

  Future<void> _checkTcpConnectivity() async {
    _addLog('--- TCP连通性测试 ---');
    final targets = [
      {'n': '百度:443', 'h': 'www.baidu.com', 'p': 443},
      {'n': 'DeepSeek:443', 'h': 'api.deepseek.com', 'p': 443},
    ];
    for (final t in targets) {
      final start = DateTime.now();
      try {
        final socket = await Socket.connect(t['h'] as String, t['p'] as int, timeout: const Duration(seconds: 5));
        final ms = DateTime.now().difference(start).inMilliseconds;
        socket.destroy();
        _addLog('OK ${t['n']} TCP连通 (${ms}ms)');
        _results.add(DiagnosticResult(name: 'TCP ${t['n']}', success: true, message: '连通成功', durationMs: ms));
      } catch (e) {
        _addLog('FAIL ${t['n']} TCP不通');
        _results.add(DiagnosticResult(name: 'TCP ${t['n']}', success: false, message: '连接失败'));
      }
    }
    _addLog('');
  }

  Future<void> _checkHttpsConnection() async {
    _addLog('--- HTTPS连接测试 ---');
    final apis = [
      {'n': '百度', 'url': 'https://www.baidu.com'},
      {'n': 'DeepSeek', 'url': 'https://api.deepseek.com/v1/models'},
      {'n': '智谱GLM', 'url': 'https://open.bigmodel.cn/api/paas/v4/models'},
      {'n': '阿里通义', 'url': 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'},
    ];
    for (final api in apis) {
      try {
        final dio = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 8),
          receiveTimeout: const Duration(seconds: 8),
          headers: {
            'User-Agent': 'khy-os/1.0',
            'Accept': 'application/json',
          },
        ));
        (dio.httpClientAdapter as dynamic).onHttpClientCreate = (client) {
          client.badCertificateCallback = (cert, host, port) => true;
          return client;
        };
        final start = DateTime.now();
        final resp = await dio.get(
          api['url']!,
          options: Options(
            validateStatus: (s) => s != null && s < 500,
            followRedirects: false,
          ),
        );
        final ms = DateTime.now().difference(start).inMilliseconds;
        _addLog('OK ${api['n']} HTTPS HTTP ${resp.statusCode} (${ms}ms)');
        _results.add(DiagnosticResult(name: 'HTTPS ${api['n']}', success: true, message: 'HTTP ${resp.statusCode}', durationMs: ms));
      } catch (e) {
        final errMsg = e.toString().split('\n').first;
        _addLog('FAIL ${api['n']} HTTPS: $errMsg');
        _results.add(DiagnosticResult(name: 'HTTPS ${api['n']}', success: false, message: errMsg));
      }
    }
    _addLog('');
  }

  String generateReport() {
    final buf = StringBuffer();
    final ok = _results.where((r) => r.success).length;
    final fail = _results.where((r) => !r.success).length;
    buf.writeln('=== 网络诊断报告 ===');
    buf.writeln('时间: ${DateTime.now().toIso8601String()}');
    buf.writeln('');
    buf.writeln('总计: ${_results.length}项, 通过: $ok, 失败: $fail');
    buf.writeln('');
    for (final r in _results) {
      final icon = r.success ? '[通过]' : '[失败]';
      final ms = r.durationMs != null ? ' (${r.durationMs}ms)' : '';
      buf.writeln('$icon ${r.name}: ${r.message}$ms');
    }
    buf.writeln('');
    buf.writeln('=== 建议 ===');
    if (fail == _results.length) {
      buf.writeln('[全部失败] 所有测试均未通过');
      buf.writeln('1. 检查私有DNS设置');
      buf.writeln('2. 检查app网络权限');
      buf.writeln('3. 切换网络环境');
    } else if (ok > 0) {
      buf.writeln('[部分通过] 部分可用，app会自动选择最优节点');
    }
    return buf.toString();
  }
}
