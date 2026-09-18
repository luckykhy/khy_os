import 'dart:async';
import 'package:flutter/material.dart';
import '../../core/services/device_control.dart';

/// khyquant 交易面板入口（档位 A 第一步：把交易面板接进统一壳）。
///
/// 最小步形态：原生「交易」Tab 页，
///   1) 显示当前连接的后端节点（KhyOsApi.connectionStream 的 KhyOsConnection，
///      即 khyquant / khy-os 服务地址）；
///   2) 可编辑交易终端 URL（默认从连接地址推导：khyquant Web UI 与后端同主机同端口）；
///   3) 「打开交易终端」经 `DeviceControl.openUrl` 走系统浏览器 / Android Custom Tab
///      （INTERNET 权限已在 manifest，无需新增依赖）；
///   4) 后端未连接时诚实降级：显示原因与「请先在 AI 标签页连接节点」提示，绝不假装可用。
class TradingPanelScreen extends StatefulWidget {
  /// 当前连接快照（KhyOsConnection?），进入页面时的初始值。
  final dynamic connection;

  /// KhyOsApi.connectionStream —— 连接变化时实时刷新本面板状态。
  final Stream<dynamic> connectionStream;

  const TradingPanelScreen({
    super.key,
    required this.connection,
    required this.connectionStream,
  });

  @override
  State<TradingPanelScreen> createState() => _TradingPanelScreenState();
}

class _TradingPanelScreenState extends State<TradingPanelScreen> {
  late final StreamSubscription _sub =
      widget.connectionStream.listen(_onConnectionChanged);
  dynamic _connection;
  late final TextEditingController _urlController =
      TextEditingController(text: _derivePanelUrl(_apiBaseUrlOf(widget.connection)));
  bool _opening = false;
  String? _status;

  _TradingPanelScreenState() {
    _connection = widget.connection;
  }

  @override
  void dispose() {
    _sub.cancel();
    _urlController.dispose();
    super.dispose();
  }

  void _onConnectionChanged(dynamic conn) {
    if (!mounted) return;
    setState(() {
      _connection = conn;
      final base = _apiBaseUrlOf(conn);
      if (base != null) {
        _urlController.text = _derivePanelUrl(base);
      }
    });
  }

  /// 从 KhyOsConnection（动态类型，避免与 gateway 包耦合）取 apiBaseUrl。
  String? _apiBaseUrlOf(dynamic conn) {
    final base = conn?.apiBaseUrl;
    return base is String && base.isNotEmpty ? base : null;
  }

  /// 从 apiBaseUrl 推导交易终端地址：khyquant Web 前端与后端同主机同端口
  /// （vite 默认同域 /api 代理，单端口部署亦同域）。仅去掉尾部斜杠，不硬编码任何主机。
  static String _derivePanelUrl(String? apiBaseUrl) {
    if (apiBaseUrl == null) return 'http://127.0.0.1:3000';
    return apiBaseUrl.replaceFirst(RegExp(r'/?$'), '');
  }

  Future<void> _openTradingTerminal() async {
    final url = _urlController.text.trim();
    if (url.isEmpty) return;
    setState(() {
      _opening = true;
      _status = null;
    });
    try {
      final opened = await DeviceControl.openUrl(url);
      if (mounted) {
        setState(() {
          _opening = false;
          _status = opened ? '已在系统浏览器打开 $url' : '打开失败：无可用浏览器或 URL 无效';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _opening = false;
          _status = '打开失败：$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final apiBase = _apiBaseUrlOf(_connection);
    final connected = apiBase != null;

    return Scaffold(
      appBar: AppBar(title: const Text('交易面板')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // 连接状态卡
          Card(
            color: connected ? cs.primaryContainer : cs.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Icon(
                    connected ? Icons.cached : Icons.link_off,
                    color: connected ? cs.onPrimaryContainer : cs.onErrorContainer,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          connected ? '已连接节点' : '未连接 khy-os 节点',
                          style: theme.textTheme.titleSmall,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          connected
                              ? apiBase
                              : '请先在「AI」标签页连接节点，或直接填写下方交易终端地址',
                          style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // URL 编辑
          Text('交易终端地址', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          TextField(
            controller: _urlController,
            decoration: const InputDecoration(
              hintText: 'http://192.168.x.x:3000',
              prefixIcon: Icon(Icons.link),
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _openTradingTerminal(),
          ),
          const SizedBox(height: 16),

          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _opening ? null : _openTradingTerminal,
              icon: _opening
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.open_in_browser),
              label: Text(_opening ? '正在打开…' : '打开交易终端'),
            ),
          ),
          if (_status != null) ...[
            const SizedBox(height: 12),
            Text(_status!, style: theme.textTheme.bodySmall),
          ],
          const SizedBox(height: 16),

          // 说明
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.info_outline, size: 18),
                      const SizedBox(width: 8),
                      Text('关于交易面板', style: theme.textTheme.titleSmall),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '交易终端（khyquant 量化面板：行情 / 策略 / 交易 / 回测）运行在 '
                    'khy-os 后端节点的 Web 前端上。本页通过系统浏览器打开，'
                    '登录与交易数据保留在 Web 端；本壳保留 Shizuku 提权、设备控制等'
                    '原生能力，无需再装 Capacitor 壳。',
                    style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
