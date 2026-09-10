/// Built-in API keys embedded in the APK.
/// These are NOT visible to users in the UI.
/// Users can enter their own keys in settings to override.
///
/// Source: docs/opencode-provider-keys.md
class BuiltInKeys {
  // Provider name → (baseUrl, apiKey, defaultModel, modelList)

  static const Map<String, BuiltInProvider> providers = {
    'SupXH': BuiltInProvider(
      baseUrl: 'https://speed44.toter.me/v1',
      apiKey: 'sk-kxfDu1UuUz4na6gNnoTy9SXrfqBvC5a6xlLWOmcgxvGSyP8y',
      defaultModel: 'claude-sonnet-4-5',
      models: [
        'claude-sonnet-4-5',
        'claude-opus-4-5',
        'gemini-3-flash',
        'gemini-2.5-pro',
        'gemini-3.1-pro',
      ],
    ),
    'Command Code': BuiltInProvider(
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiKey:
          'user_QduohLPx5gneWbdfWEwdjuTgtJ7bEUAfSEJ2urouYdnfUM9xQZaUAoFMgd9GU4KNcfNGk41Dr6ZWMFZweBV7PdU',
      defaultModel: 'claude-sonnet-5',
      models: [
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-opus-5',
        'claude-opus-4-8',
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'deepseek/deepseek-v4-pro',
        'deepseek/deepseek-v4-flash',
        'moonshotai/Kimi-K3',
        'zai-org/GLM-5.3',
        'zai-org/GLM-5.2',
        'MiniMaxAI/MiniMax-M3',
        'xiaomi/mimo-v2.5-pro',
        'Qwen/Qwen3.8-Max',
        'google/gemini-3.7-flash',
        'xai/grok-4.5',
      ],
    ),
    '智谱 GLM': BuiltInProvider(
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: '844986c572bf414489be6f7d06fc0d95.p0lOiYflTGXjoury',
      defaultModel: 'glm-5.3',
      models: ['glm-5.3', 'glm-5.3-flash'],
    ),
    'OpenCode Go': BuiltInProvider(
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey:
          'sk-GfGfEeMHAP9OqViis7N6yFQtzVBTQIalFbWAEdH5MMpUwAXgVToUpX5mzRxxIrCX',
      defaultModel: 'deepseek-v4-pro',
      models: [
        'grok-4.5',
        'gpt-5.6-luna',
        'glm-5.3',
        'glm-5.2',
        'glm-5.1',
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'minimax-m3',
        'minimax-m2.7',
        'minimax-m2.5',
        'qwen3.8-max',
        'qwen3.7-max',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'hy3',
        'ox-alpha-free',
      ],
    ),
    'OpenRouter': BuiltInProvider(
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '', // No built-in key, user must provide
      defaultModel: 'z-ai/glm-5.2:free',
      models: [
        'z-ai/glm-5.2:free',
        'cohere/north-mini-code:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3.5-lightning:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'thinkingmachines/inkling:free',
        'thinkingmachines/inkling-small:free',
        'poolside/laguna-s-2.1:free',
        'poolside/laguna-xs-2.1:free',
        'google/gemma-4-31b-it:free',
        'google/gemma-4-26b-a4b-it:free',
        'dots-studio/dots-3-note-preview:free',
        'minimax/minimax-m3:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'nvidia/nemotron-3.5-content-safety:free',
        'liquid/lfm-2.5-2.6b:free',
      ],
    ),
    'Sense Nova': BuiltInProvider(
      baseUrl: 'https://token.sensenova.cn/v1',
      apiKey: 'sk-ZqZmy6xPoGTJhAiAVe7RdRCbHQyrXRfo',
      defaultModel: 'sensenova-6.7-flash-lite',
      models: ['sensenova-6.7-flash-lite'],
    ),
    'Agnes': BuiltInProvider(
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: 'sk-TDyXYtuXXCUrw42bDqtz0PigooeOtb5Oh4HUUvr47hxHrgDG',
      defaultModel: 'agnes-2.0-flash',
      models: [
        'agnes-2.0-flash',
        'agnes-2.5-flash',
        'agnes-2.5-pro-alpha',
      ],
    ),
    'OpenCode Zen': BuiltInProvider(
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKey: 'public',
      defaultModel: 'default',
      models: [
        'default',
        'big-pickle',
        'ling-3.0-flash-fin-free',
        'mimo-v2.5-free',
        'muse-spark-1.2-contributor-free',
        'muse-spark-1.3-contributor-free',
        'nemotron-3-ultra-free',
        'nemotron-3.5-lightning-free',
      ],
    ),
  };

  /// Get a provider by name
  static BuiltInProvider? get(String name) => providers[name];

  /// Get the default provider (first one with a non-empty key)
  static BuiltInProvider get defaultProvider {
    for (final p in providers.values) {
      if (p.apiKey.isNotEmpty && p.apiKey != 'public') return p;
    }
    return providers.values.first;
  }

  /// Check if a baseUrl matches any built-in provider
  static String? matchBaseUrl(String baseUrl) {
    for (final entry in providers.entries) {
      if (entry.value.baseUrl == baseUrl) return entry.key;
    }
    return null;
  }

  /// Check if a baseUrl has a built-in key
  static bool hasBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return false;
    final p = providers[name];
    return p != null && p.apiKey.isNotEmpty && p.apiKey != 'public';
  }

  /// Get the built-in key for a baseUrl
  static String getBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return '';
    return providers[name]?.apiKey ?? '';
  }
}

class BuiltInProvider {
  final String baseUrl;
  final String apiKey;
  final String defaultModel;
  final List<String> models;

  const BuiltInProvider({
    required this.baseUrl,
    required this.apiKey,
    required this.defaultModel,
    required this.models,
  });

  bool get hasKey => apiKey.isNotEmpty && apiKey != 'public';
}
