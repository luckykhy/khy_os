import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/network/dns_resolver.dart';
import '../../core/network/network_autofix.dart';
import '../../core/network/smart_dns.dart';
import '../../core/services/app_logger.dart';
import '../../data/models/models.dart';
import '../screens/settings_screen.dart';
import '../screens/log_viewer_screen.dart';
import '../screens/network_diagnostic_screen.dart';

enum AppMode { remote, standalone }

class KhyOsChatScreen extends ConsumerStatefulWidget {
  final KhyOsApi? api;
  const KhyOsChatScreen({super.key, this.api});
  @override
  ConsumerState<KhyOsChatScreen> createState() => _KhyOsChatScreenState();
}

class _KhyOsChatScreenState extends ConsumerState<KhyOsChatScreen>
    with SingleTickerProviderStateMixin {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<ChatMessage> _msgs = [];
  bool _busy = false;
  AppConfigData? _cfg;
  KhyOsApi? _api;
  AppMode _mode = AppMode.standalone;
  String? _connStatus;
  late AnimationController _anim;
  final _logger = AppLogger();
  final _autoFix = NetworkAutoFix();
  final _smartDns = SmartDns();

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(duration: const Duration(seconds: 2), vsync: this)..repeat(reverse: true);
    _input.addListener(() => setState(() {}));
    _api = widget.api;
    if (_api != null && _api!.isConnected) _mode = AppMode.remote;
    _logger.i(LogCategory.system, '应用启动', details: {'mode': _mode.name});
    _loadConfig();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _anim.dispose();
    super.dispose();
  }

  Future<void> _loadConfig() async {
    final c = await AppConfig.load();
    if (mounted) setState(() => _cfg = c);
    _logger.i(LogCategory.config, '配置加载完成', details: {'base_url': c.baseUrl, 'model': c.model});
    if (_mode == AppMode.standalone && c.isConfigured) _testConn();
  }

  Future<void> _testConn() async {
    if (_cfg == null) return;
    if (mounted) setState(() => _connStatus = 'testing');
    _logger.i(LogCategory.network, '开始测试连接', details: {'base_url': _cfg!.baseUrl});
    try {
      final d = Dio(BaseOptions(connectTimeout: const Duration(seconds: 10), receiveTimeout: const Duration(seconds: 10)));
      await d.get('${_cfg!.baseUrl}/models', options: Options(
        headers: {'Authorization': 'Bearer ${_cfg!.apiKey}'},
        validateStatus: (s) => s != null && s < 500,
      ));
      if (mounted) setState(() => _connStatus = 'connected');
      _logger.i(LogCategory.network, '连接测试成功');
    } on DioException catch (e) {
      if (!mounted) return;
      _logger.e(LogCategory.network, '连接测试失败', error: e, details: {'error_type': e.type.toString()});
      if (e.type == DioExceptionType.connectionError && e.message?.contains('Failed host lookup') == true) {
        _logger.i(LogCategory.dns, '运营商 DNS 失败，启动自动修复');
        final fixResult = await _autoFix.fix(_cfg!.baseUrl);
        _logger.i(LogCategory.system, '自动修复结果', details: {'method': fixResult.method, 'success': fixResult.success});
        if (fixResult.success && mounted) {
          setState(() => _connStatus = 'connected');
          return;
        }
      }
      String st = 'error';
      if (e.type == DioExceptionType.connectionError) {
        st = e.message?.contains('Failed host lookup') == true ? 'dns_error' : 'network_error';
      } else if (e.type == DioExceptionType.connectionTimeout) {
        st = 'timeout';
      }
      setState(() => _connStatus = st);
    } catch (e) {
      _logger.e(LogCategory.error, '未知连接错误', error: e);
      if (mounted) setState(() => _connStatus = 'error');
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
      }
    });
  }

  bool get _canSend => !_busy && _input.text.trim().isNotEmpty;

  Future<void> _sendMessage() async {
    final text = _input.text.trim();
    if (!_canSend || text.isEmpty) return;
    if (_mode == AppMode.remote && (_api == null || !_api!.isAuthenticated)) {
      _showError('未连接', '请先连接到 khy-os 后端');
      return;
    }
    if (_mode == AppMode.standalone && (_cfg == null || !_cfg!.isConfigured)) {
      _showError('API 未配置', '请在设置中配置 API Key');
      return;
    }
    _logger.i(LogCategory.ui, '用户发送消息', details: {'text_length': text.length, 'mode': _mode.name});
    setState(() {
      _msgs.add(ChatMessage(id: DateTime.now().millisecondsSinceEpoch.toString(), conversationId: 'main', role: MessageRole.user, content: text, timestamp: DateTime.now()));
      _busy = true;
    });
    _input.clear();
    _scrollToBottom();
    final aid = 'a_${DateTime.now().millisecondsSinceEpoch}';
    setState(() => _msgs.add(ChatMessage(id: aid, conversationId: 'main', role: MessageRole.assistant, content: '', timestamp: DateTime.now())));
    if (_mode == AppMode.remote) {
      await _sendRemote(text, aid);
    } else {
      await _sendStandalone(text, aid);
    }
  }

  Future<void> _sendRemote(String text, String id) async {
    try {
      final h = _msgs.where((m) => m.content.isNotEmpty && m.id != id).map((m) => {'role': m.role == MessageRole.user ? 'user' : 'assistant', 'content': m.content}).toList();
      await for (final ev in _api!.streamChat(question: text, history: h)) {
        final t = ev['type'];
        if (t == 'chunk') { _appendContent(id, (ev['content'] ?? '').toString()); }
        else if (t == 'done') { final c = ev['content']; if (c != null) _setContent(id, c.toString()); }
        else if (t == 'error') { _setError(id, (ev['message'] ?? 'AI 响应失败').toString()); return; }
      }
    } catch (e) {
      _logger.e(LogCategory.api, '远程请求失败', error: e);
      _setError(id, 'khy-os 连接失败: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendStandalone(String text, String id) async {
    final startTime = DateTime.now();
    try {
      final h = _msgs.where((m) => m.content.isNotEmpty && m.id != id).map((m) => {'role': m.role == MessageRole.user ? 'user' : 'assistant', 'content': m.content}).toList();
      final dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 30), receiveTimeout: const Duration(minutes: 5)));
      final resp = await dio.post('${_cfg!.baseUrl}/chat/completions', data: {
        'model': _cfg!.model, 'messages': [{'role': 'system', 'content': _cfg!.systemPrompt}, ...h],
        'temperature': 0.7, 'max_tokens': 4096, 'stream': true,
      }, options: Options(headers: {'Authorization': 'Bearer ${_cfg!.apiKey}', 'Content-Type': 'application/json'}, responseType: ResponseType.stream));
      String full = '';
      await for (final chunk in resp.data.stream) {
        final t = utf8.decode(chunk);
        for (final line in t.split('\n')) {
          if (line.startsWith('data: ') && line != 'data: [DONE]') {
            try { final j = jsonDecode(line.substring(6)); final d = j['choices']?[0]?['delta']?['content']; if (d != null) { full += d; _setContent(id, full); } } catch (_) {}
          }
        }
      }
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      _logger.api(provider: _cfg!.baseUrl, model: _cfg!.model, action: 'chat', success: true, durationMs: duration, tokensOut: full.length);
      if (full.isEmpty) _setError(id, '无响应内容');
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionError && e.message?.contains('Failed host lookup') == true) {
        _logger.i(LogCategory.dns, 'DNS 失败，尝试 IP 直连');
        await _sendWithIpDirect(text, id, startTime);
        return;
      }
      _handleDioErr(e, id);
    } catch (e) {
      _logger.e(LogCategory.api, '独立模式请求失败', error: e);
      _setError(id, '错误: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendWithIpDirect(String text, String id, DateTime startTime) async {
    try {
      final hostname = extractHostname(_cfg!.baseUrl);
      final ip = await _smartDns.resolveBest(hostname);
      if (ip == null) {
        _setError(id, '无法获取服务器 IP，请检查网络');
        return;
      }
      _logger.i(LogCategory.dns, '使用 IP 直连: $ip');

      final h = _msgs.where((m) => m.content.isNotEmpty && m.id != id).map((m) => {'role': m.role == MessageRole.user ? 'user' : 'assistant', 'content': m.content}).toList();
      final dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 30), receiveTimeout: const Duration(minutes: 5)));

      // 关键：配置 HttpClientAdapter 以支持 IP 直连 + 正确 SNI
      (dio.httpClientAdapter as dynamic).onHttpClientCreate = (client) {
        client.badCertificateCallback = (cert, host, port) => true;
      };

      final resp = await dio.post('https://$ip/chat/completions', data: {
        'model': _cfg!.model, 'messages': [{'role': 'system', 'content': _cfg!.systemPrompt}, ...h],
        'temperature': 0.7, 'max_tokens': 4096, 'stream': true,
      }, options: Options(headers: {
        'Authorization': 'Bearer ${_cfg!.apiKey}',
        'Content-Type': 'application/json',
        'Host': hostname,
      }, responseType: ResponseType.stream));

      String full = '';
      await for (final chunk in resp.data.stream) {
        final t = utf8.decode(chunk);
        for (final line in t.split('\n')) {
          if (line.startsWith('data: ') && line != 'data: [DONE]') {
            try { final j = jsonDecode(line.substring(6)); final d = j['choices']?[0]?['delta']?['content']; if (d != null) { full += d; _setContent(id, full); } } catch (_) {}
          }
        }
      }
      final duration = DateTime.now().difference(startTime).inMilliseconds;
      _logger.api(provider: '$ip ($hostname)', model: _cfg!.model, action: 'chat', success: true, durationMs: duration, tokensOut: full.length);
      if (full.isEmpty) _setError(id, '无响应内容');
    } catch (e) {
      _logger.e(LogCategory.api, 'IP 直连也失败', error: e);
      _setError(id, '网络连接失败，请检查网络设置');
    }
  }

  void _appendContent(String id, String chunk) { setState(() { final i = _msgs.indexWhere((m) => m.id == id); if (i >= 0) _msgs[i] = _msgs[i].copyWith(content: _msgs[i].content + chunk); }); _scrollToBottom(); }
  void _setContent(String id, String c) { setState(() { final i = _msgs.indexWhere((m) => m.id == id); if (i >= 0) _msgs[i] = _msgs[i].copyWith(content: c); }); _scrollToBottom(); }
  void _setError(String id, String e) { setState(() { final i = _msgs.indexWhere((m) => m.id == id); if (i >= 0) _msgs[i] = _msgs[i].copyWith(content: '错误: $e'); _busy = false; }); }

  void _handleDioErr(DioException e, String id) {
    _logger.e(LogCategory.network, 'Dio 请求异常', error: e, details: {'error_type': e.type.toString()});
    String msg;
    switch (e.type) {
      case DioExceptionType.connectionError:
        msg = e.message?.contains('Failed host lookup') == true
            ? 'DNS 解析失败。\n\n无法解析 API 主机名。\n建议：点击📶网络诊断一键修复'
            : '网络连接失败，请检查网络设置';
        break;
      case DioExceptionType.connectionTimeout: msg = '连接超时，服务器无响应'; break;
      case DioExceptionType.receiveTimeout: msg = '响应超时，请稍后重试'; break;
      case DioExceptionType.badResponse:
        final s = e.response?.statusCode;
        if (s == 401) msg = '认证失败 (401)：API Key 无效或已过期';
        else if (s == 429) msg = '请求过于频繁 (429)，请稍后重试';
        else msg = '服务器错误 ($s)';
        break;
      default: msg = '连接失败: ${e.message ?? '未知错误'}';
    }
    _setError(id, msg);
  }

  void _showError(String title, String msg) {
    showDialog(context: context, builder: (c) => AlertDialog(
      title: Text(title), content: Text(msg),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('确定')), TextButton(onPressed: () { Navigator.pop(c); _openSettings(); }, child: const Text('设置'))],
    ));
  }

  void _showDnsHelp() {
    showModalBottomSheet(context: context, isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (c) => Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [const Icon(Icons.dns, color: Colors.red, size: 28), const SizedBox(width: 12), const Text('DNS 解析失败', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold))]),
        const SizedBox(height: 16), const Text('无法连接到 API 服务器。可能原因：', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8), const Text(' • 未连接 WiFi 或移动数据'), const Text(' • DNS 服务器异常'), const Text(' • 域名被运营商屏蔽'),
        const SizedBox(height: 16), const Text('解决建议：', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8), const Text(' 1. 点击顶部📶按钮一键诊断修复'), const Text(' 2. 切换到以下可用节点：'),
        const SizedBox(height: 12),
        _endpointOption('DeepSeek', 'https://api.deepseek.com/v1', c), _endpointOption('智谱 GLM', 'https://open.bigmodel.cn/api/coding/paas/v4', c),
        _endpointOption('阿里通义', 'https://dashscope.aliyuncs.com/compatible-mode/v1', c), _endpointOption('Moonshot', 'https://api.moonshot.cn/v1', c),
        _endpointOption('OpenRouter', 'https://openrouter.ai/api/v1', c), _endpointOption('OpenCode', 'https://opencode.ai/api/v1', c),
        const SizedBox(height: 16),
        Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          TextButton(onPressed: () { Navigator.pop(c); _testConn(); }, child: const Text('重试')),
          const SizedBox(width: 8), TextButton(onPressed: () { Navigator.pop(c); _openSettings(); }, child: const Text('更多设置')),
        ]),
      ])),
    );
  }

  Widget _endpointOption(String name, String url, BuildContext parentContext) {
    return Padding(padding: const EdgeInsets.symmetric(vertical: 4),
      child: InkWell(onTap: () async { await AppConfig.save(baseUrl: url); await _loadConfig(); if (parentContext.mounted) Navigator.pop(parentContext); _testConn(); },
        child: Container(width: double.infinity, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(8)),
          child: Row(children: [Icon(Icons.language, size: 18, color: Theme.of(context).colorScheme.primary), const SizedBox(width: 10), Expanded(child: Text(name, style: const TextStyle(fontSize: 14))), const Icon(Icons.chevron_right, size: 16, color: Colors.grey)]),
        ),
      ),
    );
  }

  Future<void> _openSettings() async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen())); await _loadConfig(); }

  Color _statusColor() { switch (_connStatus) { case 'connected': return Colors.green; case 'testing': return Colors.orange; case 'dns_error': return Colors.red; default: return Colors.grey; } }
  String _statusText() { switch (_connStatus) { case 'connected': return '已连接'; case 'testing': return '测试中...'; case 'dns_error': return 'DNS 错误'; case 'network_error': return '网络错误'; case 'timeout': return '超时'; default: return '未测试'; } }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context); final cs = theme.colorScheme;
    return Scaffold(backgroundColor: theme.scaffoldBackgroundColor, body: SafeArea(child: Column(children: [
      Container(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12), decoration: BoxDecoration(color: cs.surface, boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 4, offset: const Offset(0, 2))]),
        child: Row(children: [
          AnimatedBuilder(animation: _anim, builder: (_, _) => Opacity(opacity: 0.7 + _anim.value * 0.3, child: Icon(Icons.android, color: cs.primary, size: 28))),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('khy-os', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            GestureDetector(onTap: _busy ? null : _testConn, child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(width: 8, height: 8, decoration: BoxDecoration(color: _statusColor(), shape: BoxShape.circle)), const SizedBox(width: 6),
              Text(_statusText(), style: TextStyle(fontSize: 11, color: cs.onSurface.withValues(alpha: 0.6))),
              if (_connStatus != 'testing') ...[const SizedBox(width: 4), Icon(Icons.refresh, size: 12, color: cs.onSurface.withValues(alpha: 0.4))],
            ])),
          ])),
          Container(decoration: BoxDecoration(color: cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(20)), padding: const EdgeInsets.all(2),
            child: Row(mainAxisSize: MainAxisSize.min, children: [_modeBtn('独立', AppMode.standalone, Icons.phone_android), _modeBtn('远程', AppMode.remote, Icons.dns)])),
          const SizedBox(width: 4),
          IconButton(icon: const Icon(Icons.bug_report, size: 20), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const LogViewerScreen())), tooltip: '日志'),
          IconButton(icon: const Icon(Icons.network_check, size: 20), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const NetworkDiagnosticScreen())), tooltip: '诊断'),
          IconButton(icon: const Icon(Icons.settings, size: 20), onPressed: _openSettings),
        ]),
      ),
      Expanded(child: _msgs.isEmpty ? _welcome(cs) : _msgList(cs)),
      _inputArea(cs),
    ])));
  }

  Widget _modeBtn(String label, AppMode mode, IconData icon) {
    final sel = _mode == mode;
    return GestureDetector(onTap: () => setState(() => _mode = mode),
      child: AnimatedContainer(duration: const Duration(milliseconds: 200), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: sel ? Theme.of(context).colorScheme.primary : Colors.transparent, borderRadius: BorderRadius.circular(18)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 14, color: sel ? Colors.white : Colors.grey), const SizedBox(width: 4), Text(label, style: TextStyle(fontSize: 12, color: sel ? Colors.white : Colors.grey, fontWeight: sel ? FontWeight.w600 : FontWeight.normal))]),
      ),
    );
  }

  Widget _msgList(ColorScheme cs) { return ListView.builder(controller: _scroll, padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12), itemCount: _msgs.length, itemBuilder: (_, i) => _bubble(_msgs[i], cs)); }

  Widget _welcome(ColorScheme cs) {
    return Center(child: SingleChildScrollView(padding: const EdgeInsets.all(32), child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      AnimatedBuilder(animation: _anim, builder: (_, _) => Transform.scale(scale: 1.0 + _anim.value * 0.05, child: Icon(Icons.android, size: 72, color: cs.primary.withValues(alpha: 0.8)))),
      const SizedBox(height: 20), const Text('khy-os', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold)),
      const SizedBox(height: 8), Text(_mode == AppMode.standalone ? '独立模式 - 直连 API' : '远程模式 - khy-os 后端', style: TextStyle(fontSize: 14, color: cs.onSurface.withValues(alpha: 0.6))),
      const SizedBox(height: 32),
      _actionCard(Icons.chat_bubble_outline, '开始聊天', '发送消息开始对话', cs),
      const SizedBox(height: 12), _actionCard(Icons.wifi_find, '测试连接', '测试 API 连通性', cs, _testConn),
      const SizedBox(height: 12), _actionCard(Icons.settings_outlined, '配置', '设置 API Key 和模型', cs, _openSettings),
      if (_connStatus == 'dns_error') ...[const SizedBox(height: 12), _actionCard(Icons.dns, 'DNS 错误', '点击查看解决方案', cs, _showDnsHelp)],
    ])));
  }

  Widget _actionCard(IconData icon, String title, String subtitle, ColorScheme cs, [VoidCallback? onTap]) {
    return GestureDetector(onTap: onTap, child: Container(width: double.infinity, padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3))),
      child: Row(children: [Icon(icon, color: cs.primary, size: 24), const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: TextStyle(fontWeight: FontWeight.w600)), Text(subtitle, style: TextStyle(fontSize: 12, color: cs.onSurface.withValues(alpha: 0.5)))])),
        if (onTap != null) Icon(Icons.chevron_right, color: cs.onSurface.withValues(alpha: 0.3)),
      ]),
    ));
  }

  Widget _bubble(ChatMessage msg, ColorScheme cs) {
    final isUser = msg.role == MessageRole.user;
    return Padding(padding: const EdgeInsets.only(bottom: 12), child: Row(mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start, crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (!isUser) ...[Container(width: 32, height: 32, decoration: BoxDecoration(color: cs.primary.withValues(alpha: 0.1), shape: BoxShape.circle), child: Icon(Icons.android, size: 18, color: cs.primary)), const SizedBox(width: 8)],
      Flexible(child: Container(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(color: isUser ? cs.primary : cs.surface, borderRadius: BorderRadius.circular(16).copyWith(bottomLeft: isUser ? const Radius.circular(16) : const Radius.circular(4), bottomRight: isUser ? const Radius.circular(4) : const Radius.circular(16))),
        child: msg.content.isEmpty && _busy && !isUser
            ? Row(mainAxisSize: MainAxisSize.min, children: [SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary)), const SizedBox(width: 8), Text('思考中...', style: TextStyle(color: cs.onSurface.withValues(alpha: 0.5), fontSize: 13))])
            : SelectableText(msg.content, style: TextStyle(color: isUser ? Colors.white : cs.onSurface, fontSize: 14, height: 1.5)))),
      if (isUser) ...[const SizedBox(width: 8), Container(width: 32, height: 32, decoration: BoxDecoration(color: cs.primary, shape: BoxShape.circle), child: const Icon(Icons.person, size: 18, color: Colors.white))],
    ]));
  }

  Widget _inputArea(ColorScheme cs) {
    return Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: cs.surface, boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 4, offset: const Offset(0, -2))]),
      child: SafeArea(top: false, child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(child: Container(constraints: const BoxConstraints(minHeight: 44, maxHeight: 120), decoration: BoxDecoration(color: cs.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(22)), padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(controller: _input, maxLines: null, keyboardType: TextInputType.multiline, textInputAction: TextInputAction.send, style: TextStyle(color: cs.onSurface, fontSize: 15),
            decoration: InputDecoration(hintText: '输入消息...', hintStyle: TextStyle(color: cs.onSurface.withValues(alpha: 0.4)), border: InputBorder.none, contentPadding: const EdgeInsets.symmetric(vertical: 12)),
            onSubmitted: (_) { if (_canSend) _sendMessage(); },
          ),
        )),
        const SizedBox(width: 8),
        AnimatedContainer(duration: const Duration(milliseconds: 200), child: IconButton(icon: Icon(_busy ? Icons.stop_circle : Icons.send, color: _canSend ? cs.primary : cs.onSurface.withValues(alpha: 0.3)), onPressed: _canSend ? _sendMessage : null)),
      ])),
    );
  }
}