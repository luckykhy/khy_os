import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AppConfigData {
  final String baseUrl;
  final String apiKey;
  final String model;
  final String systemPrompt;

  const AppConfigData({
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    this.systemPrompt = '',
  });

  bool get isConfigured => apiKey.isNotEmpty && baseUrl.isNotEmpty;

  String get maskedApiKey {
    if (apiKey.length <= 16) return apiKey;
    return '${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}';
  }

  Map<String, dynamic> toJson() => {
    'baseUrl': baseUrl,
    'apiKey': apiKey,
    'model': model,
    'systemPrompt': systemPrompt,
  };

  factory AppConfigData.fromJson(Map<String, dynamic> json) => AppConfigData(
    baseUrl: json['baseUrl'] ?? '',
    apiKey: json['apiKey'] ?? '',
    model: json['model'] ?? '',
    systemPrompt: json['systemPrompt'] ?? '',
  );

  AppConfigData copyWith({String? baseUrl, String? apiKey, String? model, String? systemPrompt}) {
    return AppConfigData(
      baseUrl: baseUrl ?? this.baseUrl,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      systemPrompt: systemPrompt ?? this.systemPrompt,
    );
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

  static Future<void> save({String? baseUrl, String? apiKey, String? model, String? systemPrompt}) async {
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
}

// Alias for backward compatibility
typedef ApiConfig = AppConfigData;
