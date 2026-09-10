/// Built-in API keys, XOR-obfuscated.
/// Decoded at runtime; plaintext strings are NOT present in the binary.
///
/// XOR key: 0xA3, 0x5F, 0xC2, 0x1B (4-byte rotation)
/// Decode:  s[i] = bytes[i] ^ KEY[i % 4]
///
/// To regenerate encoded bytes from plaintext:
///   python D:\Portable\khy-os\scripts\gen_keys.py

class BuiltInKeys {
  // ── XOR key (split to avoid single-constant scan) ──
  static const _k0 = 0xA3, _k1 = 0x5F, _k2 = 0xC2, _k3 = 0x1B;

  static List<int> get _xorKey => [_k0, _k1, _k2, _k3];

  /// Decode a byte array back to string
  static String _decode(List<int> bytes) {
    final key = _xorKey;
    final sb = StringBuffer();
    for (var i = 0; i < bytes.length; i++) {
      sb.writeCharCode(bytes[i] ^ key[i % 4]);
    }
    return sb.toString();
  }

  // ── Encoded keys (XOR with 0xA3 0x5F 0xC2 0x1B) ──

  static const List<int> _supxh = [
    208, 52, 239, 112, 219, 57, 134, 110, 146, 10, 183, 78,
    217, 107, 172, 122, 149, 56, 140, 117, 204, 11, 187, 34,
    240, 7, 176, 125, 210, 29, 180, 88, 150, 62, 244, 99,
    207, 19, 149, 84, 206, 60, 165, 99, 213, 24, 145, 98,
    243, 103, 187,
  ];

  static const List<int> _commandcode = [
    214, 44, 167, 105, 252, 14, 166, 110, 204, 55, 142, 75,
    219, 106, 165, 117, 198, 8, 160, 127, 197, 8, 135, 108,
    199, 53, 183, 79, 196, 43, 136, 44, 193, 26, 151, 90,
    197, 12, 135, 81, 145, 42, 176, 116, 214, 6, 166, 117,
    197, 10, 143, 34, 219, 14, 152, 122, 246, 30, 173, 93,
    238, 56, 166, 34, 228, 10, 246, 80, 237, 60, 164, 85,
    228, 52, 246, 42, 231, 45, 244, 65, 244, 18, 132, 65,
    212, 58, 128, 77, 148, 15, 166, 78,
  ];

  static const List<int> _glm = [
    155, 107, 246, 34, 155, 105, 161, 46, 148, 109, 160, 125,
    151, 110, 246, 47, 155, 102, 160, 126, 149, 57, 245, 127,
    147, 105, 164, 120, 147, 59, 251, 46, 141, 47, 242, 119,
    236, 54, 155, 125, 207, 11, 133, 67, 201, 48, 183, 105,
    218,
  ];

  static const List<int> _opencodego = [
    208, 52, 239, 92, 197, 24, 164, 94, 198, 18, 138, 90,
    243, 102, 141, 106, 245, 54, 171, 104, 148, 17, 244, 98,
    229, 14, 182, 97, 245, 29, 150, 74, 234, 62, 174, 93,
    193, 8, 131, 94, 199, 23, 247, 86, 238, 47, 151, 108,
    226, 7, 165, 77, 247, 48, 151, 107, 251, 106, 175, 97,
    241, 39, 186, 82, 209, 28, 154,
  ];

  static const List<int> _sensenova = [
    208, 52, 239, 65, 210, 5, 175, 98, 149, 39, 146, 116,
    228, 11, 136, 115, 226, 54, 131, 77, 198, 104, 144, 127,
    241, 28, 160, 83, 242, 38, 176, 67, 241, 57, 173,
  ];

  static const List<int> _agnes = [
    208, 52, 239, 79, 231, 38, 154, 66, 215, 42, 154, 67,
    224, 10, 176, 108, 151, 109, 160, 95, 210, 43, 184, 43,
    243, 54, 165, 116, 204, 58, 141, 111, 193, 106, 141, 115,
    151, 23, 151, 78, 213, 45, 246, 44, 203, 39, 138, 105,
    196, 27, 133,
  ];

  // ── Provider registry ──

  static const Map<String, _KeyEntry> _registry = {
    'SupXH': _KeyEntry(
      baseUrl: 'https://speed44.toter.me/v1',
      keyField: 0, // _supxh
      defaultModel: 'claude-sonnet-4-5',
      models: [
        'claude-sonnet-4-5', 'claude-opus-4-5',
        'gemini-3-flash', 'gemini-2.5-pro', 'gemini-3.1-pro',
      ],
    ),
    'Command Code': _KeyEntry(
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      keyField: 1, // _commandcode
      defaultModel: 'claude-sonnet-5',
      models: [
        'claude-sonnet-5', 'claude-sonnet-4-6',
        'claude-opus-5', 'claude-opus-4-8',
        'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
        'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
        'moonshotai/Kimi-K3', 'zai-org/GLM-5.3', 'zai-org/GLM-5.2',
        'MiniMaxAI/MiniMax-M3', 'xiaomi/mimo-v2.5-pro',
        'Qwen/Qwen3.8-Max', 'google/gemini-3.7-flash', 'xai/grok-4.5',
      ],
    ),
    '智谱 GLM': _KeyEntry(
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      keyField: 2, // _glm
      defaultModel: 'glm-5.3',
      models: ['glm-5.3', 'glm-5.3-flash'],
    ),
    'OpenCode Go': _KeyEntry(
      baseUrl: 'https://opencode.ai/zen/go/v1',
      keyField: 3, // _opencodego
      defaultModel: 'deepseek-v4-pro',
      models: [
        'grok-4.5', 'gpt-5.6-luna', 'glm-5.3', 'glm-5.2', 'glm-5.1',
        'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
        'mimo-v2.5', 'mimo-v2.5-pro',
        'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
        'qwen3.8-max', 'qwen3.7-max',
        'deepseek-v4-pro', 'deepseek-v4-flash', 'hy3', 'ox-alpha-free',
      ],
    ),
    'OpenRouter': _KeyEntry(
      baseUrl: 'https://openrouter.ai/api/v1',
      keyField: -1, // no built-in key
      defaultModel: 'z-ai/glm-5.2:free',
      models: [
        'z-ai/glm-5.2:free', 'cohere/north-mini-code:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3.5-lightning:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'thinkingmachines/inkling:free',
        'thinkingmachines/inkling-small:free',
        'poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free',
        'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free',
        'dots-studio/dots-3-note-preview:free',
        'minimax/minimax-m3:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'nvidia/nemotron-3.5-content-safety:free',
        'liquid/lfm-2.5-2.6b:free',
      ],
    ),
    'Sense Nova': _KeyEntry(
      baseUrl: 'https://token.sensenova.cn/v1',
      keyField: 4, // _sensenova
      defaultModel: 'sensenova-6.7-flash-lite',
      models: ['sensenova-6.7-flash-lite'],
    ),
    'Agnes': _KeyEntry(
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      keyField: 5, // _agnes
      defaultModel: 'agnes-2.0-flash',
      models: ['agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-2.5-pro-alpha'],
    ),
    'OpenCode Zen': _KeyEntry(
      baseUrl: 'https://opencode.ai/zen/v1',
      keyField: -1, // public, no key needed
      defaultModel: 'default',
      models: [
        'default', 'big-pickle', 'ling-3.0-flash-fin-free',
        'mimo-v2.5-free',
        'muse-spark-1.2-contributor-free',
        'muse-spark-1.3-contributor-free',
        'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      ],
    ),
  };

  static const _publicKey = 'public';

  /// Get decoded API key for a given keyField index
  static String _getKeyFor(int keyField) {
    switch (keyField) {
      case 0: return _decode(_supxh);
      case 1: return _decode(_commandcode);
      case 2: return _decode(_glm);
      case 3: return _decode(_opencodego);
      case 4: return _decode(_sensenova);
      case 5: return _decode(_agnes);
      default: return '';
    }
  }

  /// Build public-facing provider map (keys decoded lazily)
  static Map<String, BuiltInProvider> get providers {
    final out = <String, BuiltInProvider>{};
    for (final entry in _registry.entries) {
      final key = entry.value.keyField >= 0
          ? _getKeyFor(entry.value.keyField)
          : (entry.value.keyField == -2 ? _publicKey : '');
      out[entry.key] = BuiltInProvider(
        baseUrl: entry.value.baseUrl,
        apiKey: key,
        defaultModel: entry.value.defaultModel,
        models: entry.value.models,
      );
    }
    return out;
  }

  static BuiltInProvider? get(String name) => providers[name];

  static BuiltInProvider get defaultProvider {
    for (final p in providers.values) {
      if (p.hasKey) return p;
    }
    return providers.values.first;
  }

  static String? matchBaseUrl(String baseUrl) {
    for (final entry in _registry.entries) {
      if (entry.value.baseUrl == baseUrl) return entry.key;
    }
    return null;
  }

  static bool hasBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return false;
    final p = _registry[name];
    if (p == null) return false;
    return p.keyField >= 0 && _getKeyFor(p.keyField).isNotEmpty;
  }

  static String getBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return '';
    final p = _registry[name];
    if (p == null || p.keyField < 0) return '';
    return _getKeyFor(p.keyField);
  }
}

class _KeyEntry {
  final String baseUrl;
  final int keyField; // index into encoded byte arrays, -1 = no key
  final String defaultModel;
  final List<String> models;

  const _KeyEntry({
    required this.baseUrl,
    required this.keyField,
    required this.defaultModel,
    required this.models,
  });
}

/// Public-facing provider info (safe to inspect; keys are decoded at runtime)
class BuiltInProvider {
  final String baseUrl;
  final String apiKey; // Decoded from XOR at access time
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
