import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/config/model_registry.dart';
import '../../core/config/provider_presets.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/device_control.dart';
import '../../ui/theme/app_colors.dart';
import 'network_diagnostic_screen.dart';
import 'log_viewer_screen.dart';

/// Redesigned settings screen - grouped sections
class SettingsScreenNew extends StatefulWidget {
  const SettingsScreenNew({super.key});

  @override
  State<SettingsScreenNew> createState() => _SettingsScreenNewState();
}

class _SettingsScreenNewState extends State<SettingsScreenNew> {
  AppConfigData? _config;
  late TextEditingController _baseUrl;
  late TextEditingController _apiKey;
  late TextEditingController _model;
  late TextEditingController _sysPrompt;
  bool _showKey = false;
  bool _saving = false;
  String? _testResult;
  final _logger = AppLogger();
  bool _loadingModels = false;
  List<ModelInfo> _availableModels = [];

  @override
  void initState() {
    super.initState();
    _baseUrl = TextEditingController();
    _apiKey = TextEditingController();
    _model = TextEditingController();
    _sysPrompt = TextEditingController();
    _load();
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _apiKey.dispose();
    _model.dispose();
    _sysPrompt.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final c = await AppConfig.load();
    setState(() {
      _config = c;
      _baseUrl.text = c.baseUrl;
      _apiKey.text = c.apiKey;
      _model.text = c.model;
      _sysPrompt.text = c.systemPrompt;
    });
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await AppConfig.save(
        baseUrl: _baseUrl.text.trim(),
        apiKey: _apiKey.text.trim(),
        model: _model.text.trim(),
        systemPrompt: _sysPrompt.text.trim(),
      );
      await _load();
      if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('配置已保存'),
          backgroundColor: AppColors.success,
            duration: const Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12)),
          ),
        );
      }
    } finally {
      setState(() => _saving = false);
    }
  }

  Future<void> _test() async {
    setState(() => _testResult = null);
    final url = _baseUrl.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setState(() => _testResult = 'URL 无效：需以 http:// 或 https:// 开头');
      return;
    }
    // Use the effective key (user key or built-in)
    final effectiveKey = _apiKey.text.trim().isNotEmpty
        ? _apiKey.text.trim()
        : BuiltInKeys.getBuiltInKey(url);
    try {
      final d = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10)));
      await d.get('$url/models',
          options: Options(
            headers: {
              'Authorization': 'Bearer $effectiveKey'
            },
            validateStatus: (s) => s != null && s < 500,
          ));
      setState(() => _testResult = '连接成功');
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      final errorCode = code != null
          ? ErrorCode.forHttpStatus(code)
          : (e.type == DioExceptionType.connectionTimeout
              ? ErrorCode.timeout
              : ErrorCode.connection);
      _logger.recordError(
        code: errorCode,
        message: '连接测试失败: $url',
        category: LogCategory.network,
        context: {
          'url': url,
          'type': e.type.name,
          'status': code?.toString() ?? '',
        },
        exception: e,
      );
      setState(() {
        if (code != null) {
          _testResult = 'HTTP $code：${_describeHttpStatus(code)}';
        } else if (e.type == DioExceptionType.connectionTimeout) {
          _testResult = '连接超时：服务器无响应';
        } else if (e.type == DioExceptionType.connectionError) {
          _testResult = '连接失败：请检查网络';
        } else {
          _testResult = '连接失败：${e.message}';
        }
      });
    } catch (e) {
      setState(() => _testResult = '连接失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('设置'),
        leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            onPressed: () => Navigator.pop(context)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── Section: Provider Presets ──
          _sectionHeader('内置提供商', Icons.router, cs),
          const SizedBox(height: 4),
          Text(
            '以下提供商已内置密钥，选择即可使用，无需填写 API Key',
            style: TextStyle(
                fontSize: 12,
                color: cs.onSurface.withValues(alpha: 0.5)),
          ),
          const SizedBox(height: 8),
          ...BuiltInKeys.providers.entries.map(
            (entry) => _presetTile(entry.key, entry.value, cs),
          ),
          const SizedBox(height: 16),

          // ── Section: API Config ──
          _sectionHeader('API 配置', Icons.key, cs),
          const SizedBox(height: 8),
          // Built-in key indicator
          if (_config != null && !_config!.hasUserKey && _config!.hasBuiltInKey)
            Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.success.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: AppColors.success.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  Icon(Icons.lock, size: 16, color: AppColors.success),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '当前使用内置密钥（${_config!.maskedEffectiveKey}）',
                      style: TextStyle(
                          fontSize: 12,
                          color: AppColors.success,
                          height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
          if (_config != null &&
              !_config!.hasUserKey &&
              !_config!.hasBuiltInKey &&
              _config!.baseUrl.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.warning.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: AppColors.warning.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded,
                      size: 16, color: AppColors.warning),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '未配置密钥：请填写 API Key 或选择上方提供商',
                      style: TextStyle(
                          fontSize: 12, color: AppColors.warning, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
          _card(cs, [
            _labeledField('Base URL', _baseUrl,
                hint: 'https://api.example.com/v1', cs: cs),
            const SizedBox(height: 12),
            _labeledFieldWithToggle('API Key', _apiKey,
                hint: 'sk-...', cs: cs, visible: _showKey,
                onToggle: () => setState(() => _showKey = !_showKey)),
            const SizedBox(height: 12),
            _modelSelector(cs),
            const SizedBox(height: 12),
            _labeledField('System Prompt', _sysPrompt,
                hint: '可选 - 自定义系统提示词', cs: cs, multiline: true),
          ]),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Text('保存配置'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _test,
                  child: const Text('测试连接'),
                ),
              ),
            ],
          ),
          if (_testResult != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_testResult!,
                  style: TextStyle(
                      fontSize: 13,
                      color: _testResult!.startsWith('连接成功')
                          ? AppColors.success
                          : AppColors.error)),
            ),
          const SizedBox(height: 20),

          // ── Section: Diagnostics ──
          _sectionHeader('诊断工具', Icons.network_check, cs),
          const SizedBox(height: 8),
          _card(cs, [
            _listTileAction(
              context, cs, Icons.wifi_find, '网络诊断',
              '检查 DNS / 连接 / 自动修复',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const NetworkDiagnosticScreen())),
            ),
            _listTileAction(
              context, cs, Icons.bug_report, '日志查看',
              '查看应用运行日志',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const LogViewerScreen())),
            ),
          ]),
          const SizedBox(height: 20),

          // ── Section: Device ──
          _sectionHeader('设备控制', Icons.devices, cs),
          const SizedBox(height: 8),
          _card(cs, [
            FutureBuilder<bool>(
              future: DeviceControl.isAccessibilityReady(),
              builder: (_, snap) {
                final ready = snap.data ?? false;
                return ListTile(
                  leading: Icon(Icons.accessibility_new,
                      color: ready ? AppColors.success : Colors.grey),
                  title: const Text('无障碍服务'),
                  subtitle: Text(ready ? '已启用' : '未启用'),
                  trailing: ready
                      ? const Icon(Icons.check_circle,
                          color: AppColors.success, size: 20)
                      : TextButton(
                          onPressed: () =>
                              DeviceControl.openAccessibilitySettings(),
                          child: const Text('去开启')),
                );
              },
            ),
            const Divider(height: 1),
            FutureBuilder<bool>(
              future: DeviceControl.isScreenCaptureReady(),
              builder: (_, snap) {
                final ready = snap.data ?? false;
                return ListTile(
                  leading: Icon(Icons.screenshot,
                      color: ready ? AppColors.success : Colors.grey),
                  title: const Text('屏幕捕获'),
                  subtitle: Text(ready ? '运行中' : '未运行'),
                  trailing: TextButton(
                    onPressed: () async {
                      if (ready) {
                        await DeviceControl.stopScreenCapture();
                      } else {
                        await DeviceControl.startScreenCapture();
                      }
                      setState(() {});
                    },
                    child: Text(ready ? '停止' : '启动'),
                  ),
                );
              },
            ),
          ]),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon, ColorScheme cs) {
    return Row(
      children: [
        Icon(icon, size: 18, color: cs.primary),
        const SizedBox(width: 8),
        Text(title,
            style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: cs.onSurface)),
      ],
    );
  }

  String _describeHttpStatus(int code) {
    switch (code) {
      case 400: return '请求参数错误';
      case 401: return 'API Key 无效或过期';
      case 403: return '权限不足';
      case 404: return '模型或路径不存在';
      case 429: return '请求过频，请稍后重试';
      case 500: return '服务器内部错误';
      case 502: return '网关错误';
      case 503: return '服务不可用';
      case 504: return '网关超时';
      default: return '未知错误';
    }
  }

  Widget _card(ColorScheme cs, List<Widget> children) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
      ),
      child: Column(children: children),
    );
  }

  Widget _presetTile(String name, BuiltInProvider p, ColorScheme cs) {
    final isActive = _config?.baseUrl == p.baseUrl;
    final hasKey = p.hasKey;
    return GestureDetector(
      onTap: () {
        setState(() {
          _baseUrl.text = p.baseUrl;
          _model.text = p.defaultModel;
          if (hasKey) {
            _apiKey.text = ''; // Clear user key → use built-in
          }
        });
      },
      child: Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: isActive ? cs.primaryContainer : cs.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: isActive
                ? cs.primary
                : cs.outlineVariant.withValues(alpha: 0.3),
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: isActive ? cs.primary : (hasKey ? AppColors.success : Colors.grey),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name,
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                          color: isActive
                              ? cs.onPrimaryContainer
                              : cs.onSurface)),
                  Text(
                    hasKey ? '内置密钥 · ${p.models.length} 个模型' : '需填写密钥',
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurface.withValues(alpha: 0.45)),
                  ),
                ],
              ),
            ),
            if (isActive)
              Icon(Icons.check, size: 16, color: cs.primary),
          ],
        ),
      ),
    );
  }

  Widget _modelSelector(ColorScheme cs) {
    final currentModel = _model.text.isEmpty ? '选择模型' : _model.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Model',
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: cs.onSurface.withValues(alpha: 0.6))),
        const SizedBox(height: 4),
        GestureDetector(
          onTap: () => _showModelDialog(cs),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: cs.surfaceVariant.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.4)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    currentModel,
                    style: TextStyle(
                      fontSize: 14,
                      color: _model.text.isEmpty
                          ? cs.onSurface.withValues(alpha: 0.4)
                          : cs.onSurface,
                    ),
                  ),
                ),
                if (_loadingModels)
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: cs.primary),
                  )
                else
                  Icon(Icons.expand_more, size: 20, color: cs.onSurfaceVariant),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _showModelDialog(ColorScheme cs) async {
    await _loadModels();
    if (!mounted) return;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Row(
            children: [
              const Text('选择模型'),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh, size: 20),
                onPressed: _loadingModels
                    ? null
                    : () async {
                        setDialogState(() => _loadingModels = true);
                        await _loadModels(forceRefresh: true);
                        setDialogState(() => _loadingModels = false);
                      },
                tooltip: '刷新模型列表',
              ),
            ],
          ),
          content: SizedBox(
            width: double.maxFinite,
            height: 400,
            child: _loadingModels
                ? const Center(child: CircularProgressIndicator())
                : _availableModels.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.cloud_off, size: 40, color: cs.outline),
                            const SizedBox(height: 8),
                            Text('无法加载模型列表',
                                style: TextStyle(color: cs.outline)),
                            const SizedBox(height: 4),
                            Text('请检查网络后刷新',
                                style: TextStyle(
                                    fontSize: 11, color: cs.outline)),
                          ],
                        ),
                      )
                    : ListView.builder(
                        itemCount: _availableModels.length,
                        itemBuilder: (_, i) {
                          final m = _availableModels[i];
                          final isSelected = _model.text == m.id;
                          return ListTile(
                            dense: true,
                            title: Text(m.name,
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected
                                        ? FontWeight.w600
                                        : FontWeight.normal)),
                            subtitle: m.name != m.id
                                ? Text(m.id,
                                    style: const TextStyle(fontSize: 11))
                                : null,
                            trailing: isSelected
                                ? Icon(Icons.check, size: 18, color: cs.primary)
                                : null,
                            onTap: () {
                              setState(() => _model.text = m.id);
                              Navigator.pop(ctx);
                            },
                          );
                        },
                      ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _loadModels({bool forceRefresh = false}) async {
    if (_loadingModels && !forceRefresh) return;
    setState(() => _loadingModels = true);

    final baseUrl = _baseUrl.text.trim();
    final apiKey = _apiKey.text.trim().isEmpty
        ? BuiltInKeys.getBuiltInKey(baseUrl)
        : _apiKey.text.trim();

    if (baseUrl.isNotEmpty && apiKey.isNotEmpty) {
      final models = await ModelRegistry.fetchModels(baseUrl, apiKey);
      if (models.isNotEmpty) {
        setState(() {
          _availableModels = models;
          _loadingModels = false;
        });
        return;
      }
    }

    // 降级：使用内置默认模型列表
    final providerName = BuiltInKeys.matchBaseUrl(baseUrl);
    if (providerName != null) {
      setState(() {
        _availableModels = ModelRegistry.getDefaultModels(providerName);
        _loadingModels = false;
      });
    } else {
      setState(() {
        _availableModels = [];
        _loadingModels = false;
      });
    }
  }

  Widget _labeledField(String label, TextEditingController ctrl,
      {String hint = '', required ColorScheme cs, bool multiline = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: cs.onSurface.withValues(alpha: 0.6))),
        const SizedBox(height: 4),
        TextField(
          controller: ctrl,
          maxLines: multiline ? 3 : 1,
          decoration: InputDecoration(
            hintText: hint,
            isDense: true,
          ),
        ),
      ],
    );
  }

  Widget _labeledFieldWithToggle(String label, TextEditingController ctrl,
      {String hint = '', required ColorScheme cs, bool visible = false,
      required VoidCallback onToggle}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: cs.onSurface.withValues(alpha: 0.6))),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: ctrl,
                obscureText: !visible,
                decoration: InputDecoration(
                  hintText: hint,
                  isDense: true,
                ),
              ),
            ),
            IconButton(
              icon: Icon(
                  visible ? Icons.visibility : Icons.visibility_off,
                  size: 20,
                  color: cs.onSurfaceVariant),
              onPressed: onToggle,
            ),
          ],
        ),
      ],
    );
  }

  Widget _listTileAction(BuildContext context, ColorScheme cs, IconData icon,
      String title, String subtitle, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon, color: cs.primary, size: 22),
      title: Text(title,
          style:
              TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
      subtitle: Text(subtitle,
          style: TextStyle(
              fontSize: 12, color: cs.onSurface.withValues(alpha: 0.45))),
      trailing: Icon(Icons.chevron_right,
          color: cs.onSurface.withValues(alpha: 0.3)),
      onTap: onTap,
    );
  }
}
