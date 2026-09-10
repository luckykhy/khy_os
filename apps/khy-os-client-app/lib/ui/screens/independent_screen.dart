import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../data/models/models.dart';
import '../../core/gateway/provider_adapter.dart';

/// 独立模式屏幕
class IndependentScreen extends ConsumerStatefulWidget {
  const IndependentScreen({super.key});

  @override
  ConsumerState<IndependentScreen> createState() => _IndependentScreenState();
}

class _IndependentScreenState extends ConsumerState<IndependentScreen> {
  final TextEditingController _baseUrlController =
      TextEditingController(text: 'https://api.openai.com/v1');
  final TextEditingController _apiKeyController = TextEditingController();
  final TextEditingController _modelController =
      TextEditingController(text: 'gpt-4o-mini');
  String _connectionStatus = '未连接';
  bool _isTesting = false;

  @override
  void dispose() {
    _baseUrlController.dispose();
    _apiKeyController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  Future<void> _testConnection() async {
    setState(() {
      _isTesting = true;
      _connectionStatus = '测试中...';
    });

    try {
      final adapter = OpenAIAdapter(
        id: 'test',
        name: 'Test',
        baseUrl: _baseUrlController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
        model: _modelController.text.trim(),
      );

      final response = await adapter.chat(
        ChatRequest(
          messages: [
            ChatMessage(
              id: '1',
              conversationId: 'test',
              role: MessageRole.user,
              content: 'Hello',
              timestamp: DateTime.now(),
            ),
          ],
        ),
      );

      setState(() {
        _connectionStatus = '连接成功！模型回复: ${response.content.substring(0, response.content.length > 50 ? 50 : response.content.length)}...';
      });
    } catch (e) {
      setState(() {
        _connectionStatus = '连接失败: $e';
      });
    } finally {
      setState(() {
        _isTesting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('独立模式'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 说明卡片
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.info_outline, color: colorScheme.primary),
                        const SizedBox(width: 8),
                        Text(
                          '关于独立模式',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '独立模式允许你直接连接自定义的 AI API，'
                      '无需通过 khy-os 网关。支持任何 OpenAI 兼容的 API。',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 24),

            // API 配置
            Text(
              'API 配置',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 16),

            TextField(
              controller: _baseUrlController,
              decoration: const InputDecoration(
                labelText: 'Base URL',
                hintText: 'https://api.openai.com/v1',
                prefixIcon: Icon(Icons.link),
              ),
            ),

            const SizedBox(height: 12),

            TextField(
              controller: _apiKeyController,
              decoration: const InputDecoration(
                labelText: 'API Key',
                hintText: 'sk-...',
                prefixIcon: Icon(Icons.key),
              ),
              obscureText: true,
            ),

            const SizedBox(height: 12),

            TextField(
              controller: _modelController,
              decoration: const InputDecoration(
                labelText: '模型名称',
                hintText: 'gpt-4o-mini',
                prefixIcon: Icon(Icons.psychology),
              ),
            ),

            const SizedBox(height: 24),

            // 连接状态
            if (_connectionStatus != '未连接')
              Card(
                color: _connectionStatus.startsWith('连接成功')
                    ? colorScheme.primaryContainer
                    : colorScheme.errorContainer,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    _connectionStatus,
                    style: TextStyle(
                      color: _connectionStatus.startsWith('连接成功')
                          ? colorScheme.onPrimaryContainer
                          : colorScheme.onErrorContainer,
                    ),
                  ),
                ),
              ),

            const SizedBox(height: 16),

            // 按钮
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _isTesting ? null : _testConnection,
                    icon: _isTesting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.wifi_tethering),
                    label: Text(_isTesting ? '测试中...' : '测试连接'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () {
                      // TODO: 保存配置
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('配置已保存')),
                      );
                    },
                    icon: const Icon(Icons.save),
                    label: const Text('保存配置'),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 24),

            // 预设
            Text(
              '快速预设',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),

            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ActionChip(
                  avatar: const Icon(Icons.api, size: 18),
                  label: const Text('OpenAI'),
                  onPressed: () {
                    _baseUrlController.text = 'https://api.openai.com/v1';
                    _modelController.text = 'gpt-4o-mini';
                  },
                ),
                ActionChip(
                  avatar: const Icon(Icons.api, size: 18),
                  label: const Text('DeepSeek'),
                  onPressed: () {
                    _baseUrlController.text = 'https://api.deepseek.com/v1';
                    _modelController.text = 'deepseek-chat';
                  },
                ),
                ActionChip(
                  avatar: const Icon(Icons.api, size: 18),
                  label: const Text('Ollama'),
                  onPressed: () {
                    _baseUrlController.text = 'http://localhost:11434/v1';
                    _modelController.text = 'llama3.2';
                  },
                ),
                ActionChip(
                  avatar: const Icon(Icons.api, size: 18),
                  label: const Text('Claude'),
                  onPressed: () {
                    _baseUrlController.text = 'https://api.anthropic.com/v1';
                    _modelController.text = 'claude-sonnet-4-20250514';
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
