import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'provider_adapter.dart';
import '../../data/models/models.dart';

/// AI 网关 - 统一管理所有 Provider
class AIGateway {
  final Map<String, ProviderAdapter> _providers = {};

  /// 注册 Provider
  void registerProvider(String id, ProviderAdapter provider) {
    _providers[id] = provider;
  }

  /// 获取 Provider
  ProviderAdapter? getProvider(String id) => _providers[id];

  /// 获取所有 Provider
  List<ProviderAdapter> get allProviders => _providers.values.toList();

  /// 获取可用 Provider
  List<ProviderAdapter> get availableProviders =>
      _providers.values.where((p) => p.isAvailable).toList();

  /// 智能路由 - 选择最佳 Provider
  ProviderAdapter? selectProvider(ChatRequest request) {
    final available = availableProviders;
    if (available.isEmpty) return null;

    switch (request.strategy) {
      case RoutingStrategy.specific:
        return request.providerId != null
            ? _providers[request.providerId]
            : available.first;
      case RoutingStrategy.capability:
        return _selectByCapability(available, request.requiredCapabilities);
      case RoutingStrategy.cost:
        return available.first; // 简化：返回第一个
      case RoutingStrategy.performance:
        return available.first; // 简化：返回第一个
    }
  }

  ProviderAdapter? _selectByCapability(
    List<ProviderAdapter> providers,
    List<Capability> capabilities,
  ) {
    for (final p in providers) {
      if (p.supports(capabilities)) return p;
    }
    return providers.first;
  }

  /// 聊天
  Future<ChatResponse> chat(ChatRequest request) async {
    final provider = selectProvider(request);
    if (provider == null) {
      throw Exception('No available AI provider');
    }
    return provider.chat(request);
  }

  /// 流式聊天
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final provider = selectProvider(request);
    if (provider == null) {
      throw Exception('No available AI provider');
    }
    return provider.streamChat(request);
  }
}

/// Gateway Provider
final aiGatewayProvider = Provider<AIGateway>((ref) {
  return AIGateway();
});

/// 默认 Provider 配置
final defaultProviderConfigProvider = StateProvider<ProviderConfig?>((ref) {
  return null;
});
