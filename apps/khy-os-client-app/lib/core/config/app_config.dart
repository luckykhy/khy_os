import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'built_in_keys.dart';

class AppConfigData {
  final String baseUrl;
  final String apiKey; // User-entered key (may be empty)
  final String model;
  final String systemPrompt;

  const AppConfigData({
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    this.systemPrompt = '',
  });

  /// True if the user has entered their own API key
  bool get hasUserKey => apiKey.isNotEmpty;

  /// True if a built-in key is available for this baseUrl
  bool get hasBuiltInKey => BuiltInKeys.hasBuiltInKey(baseUrl);

  /// The effective API key to use for requests:
  /// - If user entered a key, use that
  /// - Otherwise, use the built-in key for this baseUrl
  /// - If neither, return empty
  String get effectiveApiKey {
    if (hasUserKey) return apiKey;
    if (hasBuiltInKey) return BuiltInKeys.getBuiltInKey(baseUrl);
    return '';
  }

  /// Whether the config is usable (has a baseUrl + effective key)
  bool get isConfigured =>
      baseUrl.isNotEmpty && effectiveApiKey.isNotEmpty;

  /// Whether we're using a built-in (non-user) key
  bool get usingBuiltInKey => !hasUserKey && hasBuiltInKey;

  /// Masked version of the effective key for display
  String get maskedEffectiveKey {
    final key = effectiveApiKey;
    if (key.length <= 16) return key;
    return '${key.substring(0, 8)}...${key.substring(key.length - 4)}';
  }

  /// Masked user key for display (in settings)
  String get maskedApiKey {
    if (apiKey.isEmpty) return '';
    if (apiKey.length <= 16) return apiKey;
    return '${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}';
  }

  Map<String, dynamic> toJson() => {
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'model': model,
        'systemPrompt': systemPrompt,
      };

  factory AppConfigData.fromJson(Map<String, dynamic> json) =>
      AppConfigData(
        baseUrl: json['baseUrl'] ?? '',
        apiKey: json['apiKey'] ?? '',
        model: json['model'] ?? '',
        systemPrompt: json['systemPrompt'] ?? '',
      );

  AppConfigData copyWith(
      {String? baseUrl, String? apiKey, String? model, String? systemPrompt}) {
    return AppConfigData(
      baseUrl: baseUrl ?? this.baseUrl,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      systemPrompt: systemPrompt ?? this.systemPrompt,
    );
  }

  /// Auto-fill: if no user key, fill in built-in defaults
  AppConfigData get effective {
    if (hasUserKey) return this;
    final builtIn = BuiltInKeys.getBuiltInKey(baseUrl);
    if (builtIn.isNotEmpty) {
      return copyWith(apiKey: builtIn);
    }
    // No user key and no built-in → try the default provider
    final def = BuiltInKeys.defaultProvider;
    if (def.hasKey) {
      return AppConfigData(
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        model: def.defaultModel,
        systemPrompt: systemPrompt,
      );
    }
    return this;
  }
}

class AppConfig {
  static const _storage = FlutterSecureStorage();
  static const _keyConfig = 'app_config';

  static Future<AppConfigData> load() async {
    try {
      final raw = await _storage.read(key: _keyConfig);
      if (raw != null) {
        return AppConfigData.fromJson(jsonDecode(raw));
      }
    } catch (_) {}
    return const AppConfigData(baseUrl: '', apiKey: '', model: '');
  }

  static Future<void> save(
      {String? baseUrl,
      String? apiKey,
      String? model,
      String? systemPrompt}) async {
    final current = await load();
    final updated = current.copyWith(
      baseUrl: baseUrl ?? current.baseUrl,
      apiKey: apiKey ?? current.apiKey,
      model: model ?? current.model,
      systemPrompt: systemPrompt ?? current.systemPrompt,
    );
    await _storage.write(key: _keyConfig, value: jsonEncode(updated.toJson()));
  }

  static Future<void> reset() async {
    await _storage.delete(key: _keyConfig);
  }

  /// Load and apply built-in key fallback
  /// Returns config with effective keys filled in
  static Future<AppConfigData> loadEffective() async {
    final config = await load();
    return config.effective;
  }
}

// Alias for backward compatibility
typedef ApiConfig = AppConfigData;
