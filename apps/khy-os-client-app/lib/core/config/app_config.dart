import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiConfig {
  static const String defaultApiKey = '';
  
  static const _keyApiKey = 'api_key';

  static Future<ApiConfig> load() async {
    const storage = FlutterSecureStorage();
    return ApiConfig(
      apiKey: await _storage.read(key: _keyApiKey) ?? defaultApiKey,
    );
  }

  final String apiKey;

  const ApiConfig({
    required this.apiKey,
  });

  Future<void> save({
    String? apiKey,
  }) async {
    const storage = FlutterSecureStorage();
    if (apiKey != null) await _storage.write(key: _keyApiKey, value: apiKey);
  }

  bool get isConfigured => apiKey.isNotEmpty;

  String get maskedApiKey {
    if (apiKey.length <= 16) return apiKey;
    return '\${apiKey.substring(0, 8)}...\${apiKey.substring(apiKey.length - 4)}';
  }

  Map<String, dynamic> toJson() => {
    'apiKey': apiKey,
  };

  factory ApiConfig.fromJson(Map<String, dynamic> json) => ApiConfig(
    apiKey: json['apiKey'] ?? '',
  );
}
