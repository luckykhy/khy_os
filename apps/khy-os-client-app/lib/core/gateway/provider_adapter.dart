import 'dart:convert';
import 'package:dio/dio.dart';
import '../../data/models/models.dart';

/// AI Provider 能力
enum Capability {
  chat,
  vision,
  toolCall,
  streaming,
  imageGeneration,
}

/// 路由策略
enum RoutingStrategy {
  cost,       // 成本优先
  performance, // 性能优先
  capability,  // 能力优先
  specific,    // 指定模型
}

/// 聊天请求
class ChatRequest {
  final List<ChatMessage> messages;
  final String? model;
  final double temperature;
  final int? maxTokens;
  final bool stream;
  final List<Capability> requiredCapabilities;
  final RoutingStrategy strategy;
  final String? providerId;
  final List<Map<String, dynamic>>? tools;

  const ChatRequest({
    required this.messages,
    this.model,
    this.temperature = 0.7,
    this.maxTokens,
    this.stream = false,
    this.requiredCapabilities = const [],
    this.strategy = RoutingStrategy.performance,
    this.providerId,
    this.tools,
  });
}

/// 聊天响应
class ChatResponse {
  final String id;
  final String content;
  final MessageRole role;
  final TokenUsage? usage;
  final String? model;
  final bool done;

  const ChatResponse({
    required this.id,
    required this.content,
    this.role = MessageRole.assistant,
    this.usage,
    this.model,
    this.done = true,
  });
}

/// Provider 适配器接口
abstract class ProviderAdapter {
  String get id;
  String get name;
  bool get isAvailable;

  bool supports(List<Capability> capabilities);
  Future<ChatResponse> chat(ChatRequest request);
  Future<Stream<ChatResponse>> streamChat(ChatRequest request);
}

/// OpenAI 兼容适配器
class OpenAIAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String baseUrl;
  final String apiKey;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => apiKey.isNotEmpty;

  OpenAIAdapter({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 60),
        ));

  @override
  bool supports(List<Capability> capabilities) {
    return true; // OpenAI 兼容 API 支持所有能力
  }

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/chat/completions',
      data: {
        'model': request.model ?? model,
        'messages': _buildMessages(request.messages),
        'temperature': request.temperature,
        'max_tokens': request.maxTokens,
        'tools': request.tools,
      },
      options: Options(headers: {
        'Authorization': 'Bearer $apiKey',
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;
    final choice = data['choices'][0];
    final message = choice['message'];

    return ChatResponse(
      id: data['id'] ?? '',
      content: message['content'] ?? '',
      role: MessageRole.assistant,
      usage: data['usage'] != null
          ? TokenUsage(
              promptTokens: data['usage']['prompt_tokens'] ?? 0,
              completionTokens: data['usage']['completion_tokens'] ?? 0,
              totalTokens: data['usage']['total_tokens'] ?? 0,
            )
          : null,
      model: data['model'],
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/chat/completions',
      data: {
        'model': request.model ?? model,
        'messages': _buildMessages(request.messages),
        'temperature': request.temperature,
        'max_tokens': request.maxTokens,
        'stream': true,
        'tools': request.tools,
      },
      options: Options(
        headers: {
          'Authorization': 'Bearer $apiKey',
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    return response.data.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.startsWith('data: ') && line != 'data: [DONE]')
        .map((line) {
      final json = jsonDecode(line.substring(6));
      final choice = json['choices'][0];
      final delta = choice['delta'];

      return ChatResponse(
        id: json['id'] ?? '',
        content: delta['content'] ?? '',
        role: MessageRole.assistant,
        done: choice['finish_reason'] != null,
        model: json['model'],
      );
    });
  }

  List<Map<String, dynamic>> _buildMessages(List<ChatMessage> messages) {
    return messages.map((m) => {
      'role': m.role == MessageRole.tool ? 'tool' : m.role.name,
      'content': m.content,
    }).toList();
  }
}

/// DeepSeek 适配器 (OpenAI 兼容)
class DeepSeekAdapter extends OpenAIAdapter {
  DeepSeekAdapter({
    required super.id,
    required super.name,
    required super.apiKey,
    required super.model,
    super.dio,
  }) : super(
          baseUrl: 'https://api.deepseek.com/v1',
        );
}

/// Anthropic Claude 适配器
class AnthropicAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String apiKey;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => apiKey.isNotEmpty;

  AnthropicAdapter({
    required this.id,
    required this.name,
    required this.apiKey,
    this.model = 'claude-sonnet-4-20250514',
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          baseUrl: 'https://api.anthropic.com/v1',
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 120),
        ));

  @override
  bool supports(List<Capability> capabilities) => true;

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '/messages',
      data: {
        'model': request.model ?? model,
        'max_tokens': request.maxTokens ?? 4096,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
      },
      options: Options(headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;
    final content = data['content'][0]['text'];

    return ChatResponse(
      id: data['id'] ?? '',
      content: content,
      usage: data['usage'] != null
          ? TokenUsage(
              promptTokens: data['usage']['input_tokens'] ?? 0,
              completionTokens: data['usage']['output_tokens'] ?? 0,
              totalTokens: (data['usage']['input_tokens'] ?? 0) +
                  (data['usage']['output_tokens'] ?? 0),
            )
          : null,
      model: data['model'],
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '/messages',
      data: {
        'model': request.model ?? model,
        'max_tokens': request.maxTokens ?? 4096,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': true,
      },
      options: Options(
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    return response.data.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.startsWith('data: '))
        .map((line) {
      final json = jsonDecode(line.substring(6));
      String content = '';
      if (json['type'] == 'content_block_delta') {
        content = json['delta']['text'] ?? '';
      }
      return ChatResponse(
        id: json['message?']['id'] ?? '',
        content: content,
        done: json['type'] == 'message_stop',
      );
    });
  }
}

/// Ollama 本地适配器
class OllamaAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String baseUrl;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => true;

  OllamaAdapter({
    required this.id,
    required this.name,
    this.baseUrl = 'http://localhost:11434',
    this.model = 'llama3.2',
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 120),
        ));

  @override
  bool supports(List<Capability> capabilities) {
    return true;
  }

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/api/chat',
      data: {
        'model': request.model ?? model,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': false,
        'options': {
          'temperature': request.temperature,
        },
      },
      options: Options(headers: {
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;

    return ChatResponse(
      id: '',
      content: data['message']['content'] ?? '',
      model: data['model'],
      done: true,
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/api/chat',
      data: {
        'model': request.model ?? model,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': true,
        'options': {
          'temperature': request.temperature,
        },
      },
      options: Options(
        headers: {
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    return response.data.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.isNotEmpty)
        .map((line) {
      final json = jsonDecode(line);
      return ChatResponse(
        id: '',
        content: json['message']['content'] ?? '',
        done: json['done'] ?? false,
        model: json['model'],
      );
    });
  }

  /// 检查 Ollama 是否运行
  Future<bool> checkAvailable() async {
    try {
      final response = await _dio.get('$baseUrl/api/tags');
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 获取可用模型列表
  Future<List<String>> listModels() async {
    try {
      final response = await _dio.get('$baseUrl/api/tags');
      final models = response.data['models'] as List?;
      return models?.map((m) => m['name'] as String).toList() ?? [];
    } catch (_) {
      return [];
    }
  }
}
