import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/provider_presets.dart';
import '../../core/gateway/khyos_api.dart';
import '../screens/connection_screen.dart';
import '../screens/network_diagnostic_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  AppConfigData? _config;
  late TextEditingController _baseUrlController;
  late TextEditingController _apiKeyController;
  late TextEditingController _modelController;
  bool _isSaving = false;
  bool _showApiKey = false;
  String? _testStatus;

  @override
  void initState() {
    super.initState();
    _baseUrlController = TextEditingController();
    _apiKeyController = TextEditingController();
    _modelController = TextEditingController();
    _loadConfig();
  }

  @override
  void dispose() {
    _baseUrlController.dispose();
    _apiKeyController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  Future<void> _loadConfig() async {
    final config = await AppConfig.load();
    setState(() {
      _config = config;
      _baseUrlController.text = config.baseUrl;
      _apiKeyController.text = config.apiKey;
      _modelController.text = config.model;
    });
  }

  Future<void> _saveConfig() async {
    setState(() => _isSaving = true);
    try {
      await AppConfig.save(
        baseUrl: _baseUrlController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
        model: _modelController.text.trim(),
      );
      await _loadConfig();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('配置已保存'),
            backgroundColor: Colors.green.shade600,
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
        );
      }
    } finally {
      setState(() => _isSaving = false);
    }
  }

  Future<void> _testConnection() async {
    setState(() => _testStatus = 'testing');
    try {
      final d = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 10),
      ));
      await d.get('${_baseUrlController.text.trim()}/models', options: Options(
        headers: {'Authorization': 'Bearer ${_apiKeyController.text.trim()}'},
        validateStatus: (s) => s != null && s < 500,
      ));
      if (mounted) setState(() => _testStatus = 'connected');
    } on DioException catch (e) {
      if (!mounted) return;
      if (e.type == DioExceptionType.connectionError) {
        setState(() => _testStatus = 'dns_error');
      } else if (e.type == DioExceptionType.connectionTimeout) {
        setState(() => _testStatus = 'timeout');
      } else if (e.response?.statusCode == 401) {
        setState(() => _testStatus = 'auth_error');
      } else {
        setState(() => _testStatus = 'error');
      }
    } catch (_) {
      if (mounted) setState(() => _testStatus = 'error');
    }
  }

  void _applyProvider(ProviderPreset provider) {
    setState(() {
      _baseUrlController.text = provider.baseUrl;
      _apiKeyController.text = provider.apiKey;
    });
  }

  Future<void> _resetConfig() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('重置配置'),
        content: const Text('将恢复默认配置，自定义设置将丢失。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确定重置', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await AppConfig.reset();
      await _loadConfig();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      appBar: AppBar(
        title: const Text('设置'),
        centerTitle: true,
        actions: [
          TextButton(
            onPressed: _isSaving ? null : _saveConfig,
            child: _isSaving
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Text('保存', style: TextStyle(color: cs.primary, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildTestCard(cs),
          const SizedBox(height: 16),
          _buildSectionCard(
            title: 'Provider 预设',
            icon: Icons.cloud_rounded,
            color: cs.primary,
            children: ProviderPresets.presets.map((p) => _buildProviderTile(p, cs)).toList(),
          ),
          const SizedBox(height: 16),
          _buildSectionCard(
            title: '模型预设',
            icon: Icons.smart_toy_rounded,
            color: cs.tertiary,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _getAllModelChips(cs),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _buildSectionCard(
            title: 'API 配置',
            icon: Icons.api_rounded,
            color: cs.secondary,
            children: [
              _buildTextField(
                controller: _baseUrlController,
                label: 'Base URL',
                hint: 'https://api.example.com/v1',
                icon: Icons.link_rounded,
                theme: theme,
              ),
              const SizedBox(height: 16),
              _buildTextField(
                controller: _apiKeyController,
                label: 'API Key',
                hint: 'sk-...',
                icon: Icons.key_rounded,
                obscure: !_showApiKey,
                theme: theme,
                suffixIcon: IconButton(
                  icon: Icon(
                    _showApiKey ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                    size: 20,
                  ),
                  onPressed: () => setState(() => _showApiKey = !_showApiKey),
                ),
              ),
              const SizedBox(height: 16),
              _buildTextField(
                controller: _modelController,
                label: '模型',
                hint: 'model-name',
                icon: Icons.smart_toy_rounded,
                theme: theme,
              ),
            ],
          ),
          const SizedBox(height: 16),
          _buildSectionCard(
            title: 'khy-os 远程连接',
            icon: Icons.cloud_rounded,
            color: cs.primary,
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('连接到 khy-os 后端'),
                subtitle: const Text('通过 SSE 流式调用 khy-os 网关'),
                leading: const Icon(Icons.dns_outlined),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => ConnectionScreen(
                        api: KhyOsApi(),
                        onConnected: () {
                          Navigator.pop(context);
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: const Text('已连接到 khy-os 后端'),
                              backgroundColor: Colors.green.shade600,
                            ),
                          );
                        },
                      ),
                    ),
                  );
                },
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('断开连接'),
                subtitle: const Text('清除保存的后端配置'),
                leading: const Icon(Icons.cloud_off_rounded),
                onTap: () async {
                  final messenger = ScaffoldMessenger.of(context);
                  final api = KhyOsApi();
                  await api.clearConnection();
                  if (!mounted) return;
                  messenger.showSnackBar(
                    SnackBar(content: const Text('已断开连接')),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 16),
          _buildSectionCard(
            title: '关于',
            icon: Icons.info_outline_rounded,
            color: cs.outline,
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(colors: [cs.primary, cs.tertiary]),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Center(
                    child: Text('K', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: Colors.white, height: 1)),
                  ),
                ),
                title: const Text('khy-os'),
                subtitle: const Text('v0.1.0 · AI Client'),
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('网络诊断'),
                leading: const Icon(Icons.network_check),
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => const NetworkDiagnosticScreen()),
                  );
                },
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('重置为默认配置'),
                leading: const Icon(Icons.restore_rounded),
                onTap: _resetConfig,
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('复制当前配置'),
                leading: const Icon(Icons.copy_rounded),
                onTap: () {
                  final text = 'URL: ${_config?.baseUrl}\nModel: ${_config?.model}';
                  Clipboard.setData(ClipboardData(text: text));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: const Text('已复制到剪贴板')),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Widget _buildTestCard(ColorScheme cs) {
    Color statusColor;
    IconData statusIcon;
    String statusText;
    switch (_testStatus) {
      case 'connected':
        statusColor = Colors.green;
        statusIcon = Icons.check_circle;
        statusText = '连接成功';
        break;
      case 'testing':
        statusColor = Colors.orange;
        statusIcon = Icons.hourglass_top;
        statusText = '测试中...';
        break;
      case 'dns_error':
        statusColor = Colors.red;
        statusIcon = Icons.dns;
        statusText = 'DNS 解析失败';
        break;
      case 'timeout':
        statusColor = Colors.orange;
        statusIcon = Icons.timer_off;
        statusText = '连接超时';
        break;
      case 'auth_error':
        statusColor = Colors.red;
        statusIcon = Icons.lock;
        statusText = '认证失败 (401)';
        break;
      case 'error':
        statusColor = Colors.red;
        statusIcon = Icons.error;
        statusText = '连接失败';
        break;
      default:
        statusColor = cs.outline;
        statusIcon = Icons.wifi_find;
        statusText = '点击测试当前配置';
    }

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: statusColor.withValues(alpha: 0.3)),
      ),
      child: InkWell(
        onTap: _testStatus == 'testing' ? null : _testConnection,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Icon(statusIcon, color: statusColor, size: 28),
            const SizedBox(width: 12),
            Expanded(child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('测试连接', style: TextStyle(fontWeight: FontWeight.bold, color: cs.onSurface)),
                Text(statusText, style: TextStyle(fontSize: 12, color: statusColor)),
              ],
            )),
            if (_testStatus == 'testing')
              SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: statusColor))
            else
              Icon(Icons.chevron_right, color: cs.outline),
          ]),
        ),
      ),
    );
  }

  List<Widget> _getAllModelChips(ColorScheme cs) {
    final chips = <Widget>[];
    for (final provider in ProviderPresets.presets) {
      for (final model in provider.models) {
        chips.add(_buildPresetChip(model, model, cs));
      }
    }
    return chips;
  }

  Widget _buildProviderTile(ProviderPreset provider, ColorScheme cs) {
    final isSelected = _baseUrlController.text == provider.baseUrl;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: () => _applyProvider(provider),
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: isSelected ? cs.primary.withValues(alpha: 0.1) : cs.surfaceContainerHighest.withValues(alpha: 0.3),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: isSelected ? cs.primary : cs.outlineVariant.withValues(alpha: 0.3),
              width: isSelected ? 2 : 1,
            ),
          ),
          child: Row(children: [
            Icon(
              isSelected ? Icons.check_circle_rounded : Icons.cloud_rounded,
              color: isSelected ? cs.primary : cs.onSurface.withValues(alpha: 0.6),
              size: 20,
            ),
            const SizedBox(width: 12),
            Expanded(child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(provider.name, style: TextStyle(fontWeight: FontWeight.w600, color: cs.onSurface)),
                Text('${provider.models.length} 个模型', style: TextStyle(fontSize: 11, color: cs.onSurface.withValues(alpha: 0.5))),
              ],
            )),
            if (isSelected) Icon(Icons.check, size: 18, color: cs.primary),
          ]),
        ),
      ),
    );
  }

  Widget _buildSectionCard({
    required String title,
    required IconData icon,
    required Color color,
    required List<Widget> children,
  }) {
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon, size: 20, color: color),
              const SizedBox(width: 8),
              Text(title, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
            ]),
            const SizedBox(height: 16),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController controller,
    required String label,
    required String hint,
    required IconData icon,
    required ThemeData theme,
    bool obscure = false,
    Widget? suffixIcon,
  }) {
    final cs = theme.colorScheme;
    return TextField(
      controller: controller,
      obscureText: obscure,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        prefixIcon: Icon(icon, size: 20),
        suffixIcon: suffixIcon,
        filled: true,
        fillColor: cs.surfaceContainerHighest.withValues(alpha: 0.5),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: cs.primary, width: 1.5),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
    );
  }

  Widget _buildPresetChip(String modelId, String modelName, ColorScheme cs) {
    final isSelected = _modelController.text == modelId;
    return ChoiceChip(
      label: Text(modelName, style: const TextStyle(fontSize: 11)),
      selected: isSelected,
      selectedColor: cs.primaryContainer,
      onSelected: (_) {
        setState(() => _modelController.text = modelId);
      },
    );
  }
}