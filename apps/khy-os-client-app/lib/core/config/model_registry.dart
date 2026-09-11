import 'dart:convert';
import 'package:dio/dio.dart';
import '../config/built_in_keys.dart';

/// 模型信息
class ModelInfo {
  final String id;
  final String name;
  final String provider;

  const ModelInfo({
    required this.id,
    required this.name,
    required this.provider,
  });

  factory ModelInfo.fromJson(Map<String, dynamic> json, String provider) {
    final id = json['id']?.toString() ?? '';
    final name = json['name']?.toString() ?? id;
    return ModelInfo(id: id, name: name, provider: provider);
  }
}

/// 模型注册表：从各 provider 获取可用模型列表
class ModelRegistry {
  static final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 15),
  ));

  /// 从指定 provider 获取模型列表
  static Future<List<ModelInfo>> fetchModels(String baseUrl, String apiKey) async {
    try {
      final resp = await _dio.get(
        '$baseUrl/models',
        options: Options(
          headers: {'Authorization': 'Bearer $apiKey'},
        ),
      );
      final data = resp.data as Map<String, dynamic>;
      final models = data['data'] as List?;
      if (models == null) return [];
      
      return models
          .map((m) => ModelInfo.fromJson(m as Map<String, dynamic>, baseUrl))
          .toList();
    } catch (e) {
      return [];
    }
  }

  /// 从所有内置 provider 获取模型列表
  static Future<Map<String, List<ModelInfo>>> fetchAllModels() async {
    final result = <String, List<ModelInfo>>{};
    
    for (final entry in BuiltInKeys.providers.entries) {
      final provider = entry.key;
      final p = entry.value;
      if (!p.hasKey) continue;
      
      final models = await fetchModels(p.baseUrl, p.apiKey);
      if (models.isNotEmpty) {
        result[provider] = models;
      }
    }
    
    return result;
  }

  /// 获取 provider 的默认模型列表（离线）
  static List<ModelInfo> getDefaultModels(String providerName) {
    final p = BuiltInKeys.get(providerName);
    if (p == null) return [];
    return p.models.map((id) => ModelInfo(
      id: id,
      name: id,
      provider: providerName,
    )).toList();
  }

  /// 获取所有 provider 及其默认模型
  static Map<String, List<ModelInfo>> getAllDefaultModels() {
    final result = <String, List<ModelInfo>>{};
    for (final entry in BuiltInKeys.providers.entries) {
      result[entry.key] = getDefaultModels(entry.key);
    }
    return result;
  }

  /// 验证模型是否存在于 provider 中
  static bool isModelValidForProvider(String baseUrl, String modelId) {
    for (final p in BuiltInKeys.providers.values) {
      if (p.baseUrl == baseUrl) {
        return p.models.contains(modelId);
      }
    }
    return false;
  }

  /// 获取模型的显示名称
  static String getModelDisplayName(String provider, String modelId) {
    // 清理模型名：去掉前缀，保留最后部分
    final parts = modelId.split('/');
    final shortName = parts.last;
    return shortName;
  }
}
