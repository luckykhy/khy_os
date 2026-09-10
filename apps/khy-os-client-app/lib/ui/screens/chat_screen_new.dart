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
import '../../data/models/models.dart' hide Conversation;
import '../../core/tools/tool_engine.dart';
import '../../core/tools/builtin_tools.dart';
import '../../core/tools/skills.dart';
import '../../core/services/conversation_db.dart';
import '../../core/services/device_control.dart';
import '../../ui/theme/app_colors.dart';
import 'settings_screen_new.dart';

/// App mode: standalone (direct API) or remote (via khy-os backend)
enum AppMode { remote, standalone }

/// Redesigned chat screen - clean top bar, tool cards, quick actions
class ChatScreenNew extends ConsumerStatefulWidget {
  final KhyOsApi? api;
  const ChatScreenNew({super.key, this.api});

  @override
  ConsumerState<ChatScreenNew> createState() => _ChatScreenNewState();
}

class _ChatScreenNewState extends ConsumerState<ChatScreenNew>
    with SingleTickerProviderStateMixin {
  final _input = TextEditingController();
  final _inputFocus = FocusNode();
  final _scroll = ScrollController();
  final List<ChatMessage> _msgs = [];
  final List<_ToolCard> _toolCards = [];
  bool _busy = false;
  AppConfigData? _cfg;
  KhyOsApi? _api;
  AppMode _mode = AppMode.standalone;
  String? _connStatus;
  late AnimationController _pulseAnim;
  final _logger = AppLogger();
  final _autoFix = NetworkAutoFix();
  final _smartDns = SmartDns();
  late final ToolEngine _toolEngine;

  // Session
  String _currentConvId = 'default';
  String _currentTitle = '新对话';
  List<ConversationSummary> _conversations = [];
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    _pulseAnim = AnimationController(duration: const Duration(seconds: 2), vsync: this)..repeat(reverse: true);
    _input.addListener(() => setState(() {}));
    _api = widget.api;
    if (_api != null && _api!.isConnected) _mode = AppMode.remote;
    _loadConfig();
    _toolEngine = ToolEngine();
    _toolEngine.registerAll(createBuiltinTools());
    _loadConversations();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _pulseAnim.dispose();
    super.dispose();
  }

  Future<void> _loadConfig() async {
    final c = await AppConfig.load();
    if (mounted) setState(() => _cfg = c);
  }

  Future<void> _loadConversations() async {
    final list = await ConversationDB.listAll();
    if (mounted) setState(() => _conversations = list);
  }

  // ==================== Send ====================

  void _sendMessage() {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    if (_cfg == null || !_cfg!.isConfigured) {
      _showError('API 未配置', '请在设置中配置 API Key');
      return;
    }
    _updateTitleFromFirstMessage(text);
    setState(() {
      _msgs.add(ChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        conversationId: _currentConvId,
        role: MessageRole.user, content: text,
        timestamp: DateTime.now(),
      ));
      _toolCards.clear();
      _busy = true;
    });
    _input.clear();
    _scrollToBottom();
    final aid = 'a_${DateTime.now().millisecondsSinceEpoch}';
    setState(() => _msgs.add(ChatMessage(
      id: aid, conversationId: _currentConvId,
      role: MessageRole.assistant, content: '',
      timestamp: DateTime.now(),
    )));
    _sendWithAgentLoop(aid);
  }

  Future<void> _sendWithAgentLoop(String id) async {
    final startTime = DateTime.now();
    try {
      final h = _msgs
          .where((m) => m.content.isNotEmpty && m.id != id)
          .map((m) => {
                'role': m.role == MessageRole.user ? 'user' : 'assistant',
                'content': m.content,
              })
          .toList();
      final basePrompt = _cfg!.systemPrompt.isNotEmpty
          ? _cfg!.systemPrompt
          : '你是 khy-os AI 助手，运行在用户的 Android 手机上。你可以帮用户打开应用、管理剪贴板、计算数学表达式、执行无障碍操作等。使用工具完成用户请求。';
      final sysPrompt = '$basePrompt\n\n${_buildSkillsSummary()}';
      final tools = _toolEngine.toFunctionSchemas();
      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 30),
        receiveTimeout: const Duration(minutes: 5),
      ));

      final messages = <Map<String, dynamic>>[
        {'role': 'system', 'content': sysPrompt},
        ...h,
      ];

      for (var loop = 0; loop < 5; loop++) {
        final requestData = {
          'model': _cfg!.model,
          'messages': messages,
          'temperature': 0.7,
          'max_tokens': 4096,
        };
        if (tools.isNotEmpty) requestData['tools'] = tools;

        final resp = await dio.post(
          '${_cfg!.baseUrl}/chat/completions',
          data: requestData,
          options: Options(
            headers: {
              'Authorization': 'Bearer ${_cfg!.apiKey}',
              'Content-Type': 'application/json',
            },
          ),
        );

        final data = resp.data as Map<String, dynamic>;
        final choice = data['choices']?[0];
        final msg = choice?['message'];
        final content = msg?['content'] ?? '';
        final toolCalls = msg?['tool_calls'] as List?;

        if (content.isNotEmpty) _setContent(id, content);

        if (toolCalls == null || toolCalls.isEmpty) {
          if (content.isEmpty) _setError(id, '无响应内容');
          await _saveConversation();
          return;
        }

        messages.add({'role': 'assistant', 'content': content, 'tool_calls': toolCalls});
        if (content.isEmpty) _setContent(id, '正在执行工具...');

        for (final tc in toolCalls) {
          final fn = tc['function'] ?? {};
          final toolName = fn['name'] ?? '';
          final argsStr = fn['arguments'] ?? '{}';
          Map<String, dynamic> args;
          try {
            args = jsonDecode(argsStr) as Map<String, dynamic>;
          } catch (_) {
            args = <String, dynamic>{};
          }

          // Show tool card in UI
          final card = _ToolCard(name: toolName, args: args);
          setState(() => _toolCards.add(card));
          _scrollToBottom();

          final result = await _toolEngine.execute(toolName, args);
          card.result = result;
          setState(() {});
          _scrollToBottom();

          messages.add({
            'tool_call_id': tc['id'] ?? '',
            'role': 'tool',
            'content': result.jsonOutput,
          });
        }
      }
      await _saveConversation();
    } on DioException catch (e) {
      _handleDioErr(e, id);
    } catch (e) {
      _logger.e(LogCategory.api, '请求失败', error: e);
      _setError(id, '错误: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ==================== Session ====================

  void _updateTitleFromFirstMessage(String text) {
    if (_currentTitle == '新对话' && text.isNotEmpty) {
      setState(() => _currentTitle = text.length > 20 ? text.substring(0, 20) + '...' : text);
    }
  }

  Future<void> _saveConversation() async {
    if (_msgs.isEmpty) return;
    final conv = Conversation(
      id: _currentConvId,
      title: _currentTitle,
      messages: _msgs.map((m) => ChatMsg(
        role: m.role == MessageRole.user ? 'user' : 'assistant',
        content: m.content,
        timestamp: m.timestamp,
      )).toList(),
    );
    await ConversationDB.save(conv);
    await _loadConversations();
  }

  void _newConversation() {
    setState(() {
      _msgs.clear();
      _toolCards.clear();
      _currentConvId = 'conv_${DateTime.now().millisecondsSinceEpoch}';
      _currentTitle = '新对话';
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _loadConversation(String id) async {
    final conv = await ConversationDB.load(id);
    if (conv == null) return;
    setState(() {
      _msgs.clear();
      _toolCards.clear();
      _currentConvId = conv.id;
      _currentTitle = conv.title;
      for (final msg in conv.messages) {
        _msgs.add(ChatMessage(
          id: '${msg.timestamp.millisecondsSinceEpoch}',
          conversationId: conv.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          timestamp: msg.timestamp,
        ));
      }
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _deleteConversation(String id) async {
    await ConversationDB.delete(id);
    if (_currentConvId == id) {
      _newConversation();
    } else {
      await _loadConversations();
    }
  }

  // ==================== UI ====================

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      key: _scaffoldKey,
      drawer: _buildDrawer(cs),
      body: SafeArea(
        child: Column(
          children: [
            _topBar(cs),
            _capabilityStrip(cs),
            Expanded(child: _msgs.isEmpty ? _welcome(cs) : _msgList(cs)),
            _quickActionBar(cs),
            _inputArea(cs),
          ],
        ),
      ),
    );
  }

  /// Clean top bar: hamburger + khy-os logo + settings
  Widget _topBar(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: cs.surface,
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 4, offset: const Offset(0, 2)),
        ],
      ),
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.menu_rounded, size: 20),
            onPressed: () => _scaffoldKey.currentState?.openDrawer(),
            tooltip: '会话列表',
          ),
          const SizedBox(width: 4),
          // Logo
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [cs.primary, cs.tertiary],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Center(
              child: Text('K', style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w800, color: Colors.white,
              )),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('khy-os', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                Text(
                  _mode == AppMode.standalone ? '独立模式' : '远程模式',
                  style: TextStyle(fontSize: 10, color: cs.onSurface.withValues(alpha: 0.5)),
                ),
              ],
            ),
          ),
          // Status dot
          _statusDot(cs),
          const SizedBox(width: 4),
          IconButton(
            icon: const Icon(Icons.settings_rounded, size: 20),
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const SettingsScreenNew())),
            tooltip: '设置',
          ),
        ],
      ),
    );
  }

  Widget _statusDot(ColorScheme cs) {
    final color = _statusColor();
    return GestureDetector(
      onTap: _busy ? null : _testConn,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            _statusText(),
            style: TextStyle(fontSize: 10, color: cs.onSurface.withValues(alpha: 0.5)),
          ),
        ],
      ),
    );
  }

  /// Thin capability strip showing active services
  Widget _capabilityStrip(ColorScheme cs) {
    return Container(
      height: 32,
      color: cs.surfaceVariant.withValues(alpha: 0.5),
      child: Row(
        children: [
          const SizedBox(width: 16),
          _capChip(Icons.accessibility_new, '无障碍', DeviceControl.isAccessibilityReady),
          const SizedBox(width: 8),
          _capChip(Icons.screenshot, '截屏', DeviceControl.isScreenCaptureReady),
          const SizedBox(width: 8),
          _capChip(Icons.terminal, 'Shell', () async => true),
          const Spacer(),
          Text('v1.1', style: TextStyle(fontSize: 10, color: cs.onSurface.withValues(alpha: 0.3))),
          const SizedBox(width: 12),
        ],
      ),
    );
  }

  Widget _capChip(IconData icon, String label, Future<bool> Function() check) {
    return FutureBuilder<bool>(
      future: check(),
      builder: (ctx, snap) {
        final active = snap.data ?? false;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: active
                ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.15)
                : Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: active
                  ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.3)
                  : Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 12, color: active ? AppColors.primary : Colors.grey),
              const SizedBox(width: 4),
              Text(label,
                  style: TextStyle(
                      fontSize: 10,
                      color: active ? AppColors.primary : Colors.grey)),
            ],
          ),
        );
      },
    );
  }

  // ==================== Messages ====================

  Widget _msgList(ColorScheme cs) {
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      itemCount: _msgs.length + _toolCards.length,
      itemBuilder: (_, i) {
        // Interleave tool cards before the last assistant message
        if (i < _msgs.length) {
          final msg = _msgs[i];
          // Show tool cards before assistant messages that triggered them
          if (msg.role == MessageRole.assistant && i == _msgs.length - 1 && _toolCards.isNotEmpty) {
            return Column(
              children: [
                for (final card in _toolCards)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _toolCardWidget(card, cs),
                  ),
                _bubble(msg, cs),
              ],
            );
          }
          return _bubble(msg, cs);
        }
        return SizedBox.shrink();
      },
    );
  }

  Widget _bubble(ChatMessage msg, ColorScheme cs) {
    final isUser = msg.role == MessageRole.user;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [cs.primary, cs.tertiary],
                ),
                shape: BoxShape.circle,
              ),
              child: const Center(
                child: Text('K',
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: Colors.white)),
              ),
            ),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser ? cs.primary : cs.surface,
                borderRadius: BorderRadius.circular(16).copyWith(
                  bottomLeft: isUser
                      ? const Radius.circular(4)
                      : const Radius.circular(16),
                  bottomRight: isUser
                      ? const Radius.circular(16)
                      : const Radius.circular(4),
                ),
                border: Border.all(
                  color: isUser
                      ? Colors.transparent
                      : cs.outlineVariant.withValues(alpha: 0.4),
                ),
              ),
              child: msg.content.isEmpty && _busy && !isUser
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: cs.primary),
                        ),
                        const SizedBox(width: 8),
                        Text('思考中...',
                            style: TextStyle(
                                color: cs.onSurface.withValues(alpha: 0.4),
                                fontSize: 13)),
                      ],
                    )
                  : SelectableText(
                      msg.content,
                      style: TextStyle(
                          color: isUser ? Colors.white : cs.onSurface,
                          fontSize: 14,
                          height: 1.5)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _toolCardWidget(_ToolCard card, ColorScheme cs) {
    final color = card.result?.success == true
        ? AppColors.success
        : (card.result != null ? AppColors.error : cs.primary);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                card.result?.success == true
                    ? Icons.check_circle_outline
                    : (card.result != null
                        ? Icons.error_outline
                        : Icons.hourglass_empty),
                size: 16,
                color: color,
              ),
              const SizedBox(width: 6),
              Text(card.name,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurface)),
              const Spacer(),
              if (card.result != null)
                Icon(
                  card.result!.success
                      ? Icons.check_circle
                      : Icons.cancel,
                  size: 16,
                  color: color,
                ),
            ],
          ),
          if (card.args.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 22),
              child: Text(
                '参数: ${card.args}',
                style: TextStyle(
                    fontSize: 11, color: cs.onSurface.withValues(alpha: 0.4)),
              ),
            ),
          if (card.result != null)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 22),
              child: Text(
                card.result!.output,
                style: TextStyle(
                    fontSize: 12,
                    color: card.result!.success
                        ? cs.onSurface.withValues(alpha: 0.7)
                        : AppColors.error,
                    height: 1.4),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
      ),
    );
  }

  // ==================== Quick Actions ====================

  Widget _quickActionBar(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: cs.surface,
      child: Row(
        children: [
          _quickBtn(Icons.screenshot, '截屏', () async {
            final ok = await DeviceControl.startScreenCapture();
            if (ok) {
              await Future.delayed(const Duration(seconds: 1));
              final data = await DeviceControl.captureFrame();
              if (data != null) {
                _addSystemMsg('📸 已截屏');
              }
            }
          }, cs),
          _quickBtn(Icons.accessibility_new, '无障碍', () {
            DeviceControl.openAccessibilitySettings();
          }, cs),
          _quickBtn(Icons.home, '主页', () async {
            await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome);
          }, cs),
          _quickBtn(Icons.arrow_back, '返回', () async {
            await DeviceControl.a11yGlobalAction(DeviceControl.globalActionBack);
          }, cs),
          _quickBtn(Icons.calculate, '计算', () {
            _input.text = '帮我计算: ';
            _inputFocus.requestFocus();
          }, cs),
          const Spacer(),
        ],
      ),
    );
  }

  Widget _quickBtn(IconData icon, String label, VoidCallback onTap, ColorScheme cs) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(right: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: cs.surfaceVariant.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: cs.primary),
            const SizedBox(width: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: cs.onSurface.withValues(alpha: 0.7))),
          ],
        ),
      ),
    );
  }

  // ==================== Input ====================

  Widget _inputArea(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 4,
              offset: const Offset(0, -2)),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Container(
                constraints: const BoxConstraints(minHeight: 44, maxHeight: 120),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(22),
                  border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _input,
                  focusNode: _inputFocus,
                  maxLines: null,
                  keyboardType: TextInputType.multiline,
                  textInputAction: TextInputAction.send,
                  style: TextStyle(color: cs.onSurface, fontSize: 15),
                  decoration: InputDecoration(
                    hintText: '输入消息...',
                    hintStyle: TextStyle(color: cs.onSurface.withValues(alpha: 0.35)),
                    border: InputBorder.none,
                    contentPadding:
                        const EdgeInsets.symmetric(vertical: 12),
                  ),
                  onSubmitted: (_) => _sendMessage(),
                ),
              ),
            ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: _canSend ? _sendMessage : null,
              child: Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: _canSend ? cs.primary : cs.surfaceContainerHighest,
                  shape: BoxShape.circle,
                  boxShadow: _canSend
                      ? [
                          BoxShadow(
                              color: cs.primary.withValues(alpha: 0.3),
                              blurRadius: 8,
                              offset: const Offset(0, 3)),
                        ]
                      : null,
                ),
                child: Icon(
                  _busy ? Icons.stop : Icons.send_rounded,
                  color: _canSend ? Colors.white : cs.onSurface.withValues(alpha: 0.3),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  bool get _canSend => _input.text.trim().isNotEmpty && !_busy;

  // ==================== Welcome ====================

  Widget _welcome(ColorScheme cs) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedBuilder(
              animation: _pulseAnim,
              builder: (_, __) => Transform.scale(
                scale: 1.0 + _pulseAnim.value * 0.05,
                child: Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [cs.primary, cs.tertiary],
                    ),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Center(
                    child: Text('K',
                        style: TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.w800,
                            color: Colors.white)),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('khy-os 助手',
                style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.bold,
                    color: cs.onSurface)),
            const SizedBox(height: 4),
            Text(
              _mode == AppMode.standalone
                  ? '独立模式 · 直连 API'
                  : '远程模式 · khy-os 后端',
              style: TextStyle(
                  fontSize: 13, color: cs.onSurface.withValues(alpha: 0.5)),
            ),
            const SizedBox(height: 24),
            _welcomeCard(Icons.open_in_new, '打开应用', '打开微信、浏览器、设置等', cs),
            const SizedBox(height: 8),
            _welcomeCard(Icons.screenshot, '截屏分析', '截取屏幕并理解内容', cs),
            const SizedBox(height: 8),
            _welcomeCard(Icons.calculate, '快速计算', '数学表达式计算', cs),
            const SizedBox(height: 8),
            _welcomeCard(Icons.settings, '配置', '设置 API Key 和模型', cs,
                onTap: () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) => const SettingsScreenNew()))),
          ],
        ),
      ),
    );
  }

  Widget _welcomeCard(IconData icon, String title, String sub, ColorScheme cs,
      {VoidCallback? onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: cs.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
              color: cs.outlineVariant.withValues(alpha: 0.3)),
        ),
        child: Row(
          children: [
            Icon(icon, color: cs.primary, size: 22),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                          fontWeight: FontWeight.w600, fontSize: 14)),
                  Text(sub,
                      style: TextStyle(
                          fontSize: 12,
                          color: cs.onSurface.withValues(alpha: 0.45))),
                ],
              ),
            ),
            if (onTap != null)
              Icon(Icons.chevron_right,
                  color: cs.onSurface.withValues(alpha: 0.25)),
          ],
        ),
      ),
    );
  }

  // ==================== Drawer ====================

  Widget _buildDrawer(ColorScheme cs) {
    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                          colors: [cs.primary, cs.tertiary]),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Center(
                        child: Text('K',
                            style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                                color: Colors.white))),
                  ),
                  const SizedBox(width: 8),
                  Text('会话列表',
                      style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: cs.onSurface)),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading:
                  Icon(Icons.add_comment, color: cs.primary, size: 22),
              title: const Text('新对话'),
              onTap: _newConversation,
            ),
            const Divider(height: 1),
            Expanded(
              child: _conversations.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.chat_bubble_outline,
                              size: 40, color: cs.outlineVariant),
                          const SizedBox(height: 8),
                          Text('暂无历史会话',
                              style: TextStyle(
                                  fontSize: 13,
                                  color: cs.onSurface.withValues(alpha: 0.4))),
                        ],
                      ),
                    )
                  : ListView.builder(
                      itemCount: _conversations.length,
                      itemBuilder: (context, index) {
                        final conv = _conversations[index];
                        final isActive = conv.id == _currentConvId;
                        return ListTile(
                          leading: Icon(
                            isActive
                                ? Icons.chat_bubble
                                : Icons.chat_bubble_outline,
                            size: 18,
                            color: isActive ? cs.primary : Colors.grey,
                          ),
                          title: Text(
                            conv.title.isEmpty ? '新对话' : conv.title,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
                              color: isActive ? cs.primary : cs.onSurface,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            '${conv.messageCount} 条消息',
                            style: TextStyle(
                                fontSize: 11, color: Colors.grey[500]),
                          ),
                          trailing: IconButton(
                            icon: Icon(Icons.delete,
                                size: 16, color: Colors.grey[400]),
                            onPressed: () => _deleteConversation(conv.id),
                          ),
                          onTap: () => _loadConversation(conv.id),
                        );
                      },
                    ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: 16, vertical: 8),
              child: Text(
                '${_conversations.length} 个会话',
                style: TextStyle(
                    fontSize: 11, color: Colors.grey[500]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ==================== Helpers ====================

  void _addSystemMsg(String text) {
    setState(() {
      _msgs.add(ChatMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        conversationId: _currentConvId,
        role: MessageRole.assistant,
        content: text,
        timestamp: DateTime.now(),
      ));
    });
    _scrollToBottom();
  }

  void _setContent(String id, String c) {
    setState(() {
      final i = _msgs.indexWhere((m) => m.id == id);
      if (i >= 0) _msgs[i] = _msgs[i].copyWith(content: c);
    });
    _scrollToBottom();
  }

  void _setError(String id, String e) {
    setState(() {
      final i = _msgs.indexWhere((m) => m.id == id);
      if (i >= 0) _msgs[i] = _msgs[i].copyWith(content: '⚠️ $e');
      _busy = false;
    });
  }

  void _showError(String title, String msg) {
    _addSystemMsg('⚠️ $title\n$msg');
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent + 200,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _testConn() async {
    if (_cfg == null) return;
    setState(() => _connStatus = 'testing');
    try {
      final d = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10)));
      await d.get('${_cfg!.baseUrl}/models',
          options: Options(
              headers: {
                'Authorization': 'Bearer ${_cfg!.apiKey}'
              },
              validateStatus: (s) => s != null && s < 500));
      setState(() => _connStatus = 'connected');
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionError &&
          e.message?.contains('Failed host lookup') == true) {
        setState(() => _connStatus = 'dns_error');
      } else {
        setState(() => _connStatus = 'network_error');
      }
    }
  }

  void _handleDioErr(DioException e, String id) {
    if (e.type == DioExceptionType.connectionError &&
        e.message?.contains('Failed host lookup') == true) {
      setState(() => _connStatus = 'dns_error');
      _setError(id, 'DNS 解析失败，请检查网络或点击诊断');
      return;
    }
    switch (e.type) {
      case DioExceptionType.connectionError:
        _setError(id, '网络连接失败');
        break;
      case DioExceptionType.connectionTimeout:
        _setError(id, '连接超时');
        break;
      case DioExceptionType.badResponse:
        _setError(id,
            'API 返回错误 (${e.response?.statusCode})');
        break;
      default:
        _setError(id, '请求失败: ${e.message}');
    }
  }

  Color _statusColor() {
    switch (_connStatus) {
      case 'connected':
        return AppColors.success;
      case 'testing':
        return AppColors.warning;
      case 'dns_error':
      case 'network_error':
        return AppColors.error;
      default:
        return Colors.grey;
    }
  }

  String _statusText() {
    switch (_connStatus) {
      case 'connected':
        return '已连接';
      case 'testing':
        return '测试中';
      case 'dns_error':
        return 'DNS 错误';
      case 'network_error':
        return '网络错误';
      default:
        return '未连接';
    }
  }

  String _buildSkillsSummary() {
    final delegationSkills =
        builtinSkills.where((s) => s.type == SkillType.delegation).toList();
    final buf = StringBuffer('## 可用技能\n');
    buf.write('调用 execute_skill 工具可快速执行：\n');
    for (final s in delegationSkills.take(15)) {
      buf.write('- ${s.name}: ${s.description}\n');
    }
    return buf.toString();
  }
}

/// Lightweight tool execution card
class _ToolCard {
  final String name;
  final Map<String, dynamic> args;
  ToolResult? result;
  _ToolCard({required this.name, required this.args});
}
