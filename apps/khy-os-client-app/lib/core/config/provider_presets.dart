class ProviderPreset {
  final String name;
  final String baseUrl;
  final String apiKey;
  final List<String> models;
  final String defaultModel;

  const ProviderPreset({
    required this.name,
    required this.baseUrl,
    required this.apiKey,
    required this.models,
    required this.defaultModel,
  });
}

class ProviderPresets {
  static const List<ProviderPreset> presets = [
    ProviderPreset(
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/v1',
      apiKey: '',
      models: ['deepseek-v3', 'deepseek-r1', 'claude-sonnet-4-20250514', 'gpt-4o'],
      defaultModel: 'deepseek-v3',
    ),
    ProviderPreset(
      name: 'OpenCode Go',
      baseUrl: 'https://api.opencodego.com/v1',
      apiKey: '',
      models: ['gpt-4o', 'claude-sonnet-4-20250514', 'deepseek-v3'],
      defaultModel: 'gpt-4o',
    ),
    ProviderPreset(
      name: 'OpenCode Zen',
      baseUrl: 'https://api.opencodezen.com/v1',
      apiKey: 'public',
      models: ['gpt-4o', 'claude-sonnet-4-20250514', 'deepseek-v3'],
      defaultModel: 'gpt-4o',
    ),
    ProviderPreset(
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-20250514', 'deepseek/deepseek-chat', 'google/gemini-2.5-flash'],
      defaultModel: 'deepseek/deepseek-chat',
    ),
    ProviderPreset(
      name: '智谱GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      models: ['glm-4-flash', 'glm-4-plus', 'glm-4-0520'],
      defaultModel: 'glm-4-flash',
    ),
    ProviderPreset(
      name: 'Agnes',
      baseUrl: 'https://api.agnes.ai/v1',
      apiKey: '',
      models: ['deepseek-v3', 'gpt-4o'],
      defaultModel: 'deepseek-v3',
    ),
    ProviderPreset(
      name: 'SupXH',
      baseUrl: 'https://api.supxh.com/v1',
      apiKey: '',
      models: ['deepseek-v3', 'gpt-4o'],
      defaultModel: 'deepseek-v3',
    ),
    ProviderPreset(
      name: 'Sense Nova',
      baseUrl: 'https://token.sensenova.cn/v1',
      apiKey: '',
      models: ['nova-3', 'nova-ptc-xl'],
      defaultModel: 'nova-3',
    ),
  ];
}
