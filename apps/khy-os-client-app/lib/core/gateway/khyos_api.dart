import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// khy-os 后端连接配置
class KhyOsConnection {
  final String apiBaseUrl;
  final String? accessToken;
  final String? refreshToken;
  final Map<String, dynamic>? user;

  const KhyOsConnection({
    required this.apiBaseUrl,
    this.accessToken,
    this.refreshToken,
    this.user,
  });

  bool get isConnected => apiBaseUrl.isNotEmpty;
  bool get isAuthenticated => accessToken?.isNotEmpty == true;

  Map<String, dynamic> toJson() => {
        'apiBaseUrl': apiBaseUrl,
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'user': user,
      };

  factory KhyOsConnection.fromJson(Map<String, dynamic> json) => KhyOsConnection(
        apiBaseUrl: json['apiBaseUrl'] ?? '',
        accessToken: json['accessToken'],
        refreshToken: json['refreshToken'],
        user: json['user'],
      );

  KhyOsConnection copyWith({
    String? apiBaseUrl,
    String? accessToken,
    String? refreshToken,
    Map<String, dynamic>? user,
  }) =>
      KhyOsConnection(
        apiBaseUrl: apiBaseUrl ?? this.apiBaseUrl,
        accessToken: accessToken ?? this.accessToken,
        refreshToken: refreshToken ?? this.refreshToken,
        user: user ?? this.user,
      );
}

/// khy-os 后端 API 服务
class KhyOsApi {
  static const _storage = FlutterSecureStorage();
  static const _keyConnection = 'khyos_connection';

  KhyOsConnection? _connection;
  final _connectionController = StreamController<KhyOsConnection?>.broadcast();

  Stream<KhyOsConnection?> get connectionStream => _connectionController.stream;
  KhyOsConnection? get connection => _connection;
  bool get isConnected => _connection?.isConnected == true;
  bool get isAuthenticated => _connection?.isAuthenticated == true;

  /// 加载保存的连接配置
  Future<KhyOsConnection?> loadConnection() async {
    final raw = await _storage.read(key: _keyConnection);
    if (raw == null) return null;
    try {
      _connection = KhyOsConnection.fromJson(jsonDecode(raw));
      _connectionController.add(_connection);
      return _connection;
    } catch (_) {
      return null;
    }
  }

  /// 保存连接配置
  Future<void> saveConnection(KhyOsConnection conn) async {
    _connection = conn;
    await _storage.write(key: _keyConnection, value: jsonEncode(conn.toJson()));
    _connectionController.add(_connection);
  }

  /// 清除连接配置
  Future<void> clearConnection() async {
    _connection = null;
    await _storage.delete(key: _keyConnection);
    _connectionController.add(null);
  }

  /// 验证并保存后端地址
  Future<void> verifyAndSave(String apiBaseUrl) async {
    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ));

    // 验证后端是否可达
    final response = await dio.get('$apiBaseUrl/api/health');
    if (response.statusCode != 200) {
      throw Exception('后端不可达 (HTTP ${response.statusCode})');
    }

    await saveConnection(KhyOsConnection(apiBaseUrl: apiBaseUrl));
  }

  /// 登录
  Future<Map<String, dynamic>> login(String username, String password) async {
    if (_connection == null) throw Exception('请先配置后端地址');

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ));

    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/auth/login',
      data: {'username', 'password'},
      options: Options(contentType: 'application/json'),
    );

    final data = response.data;
    final conn = _connection!.copyWith(
      accessToken: data['accessToken'] ?? data['access_token'],
      refreshToken: data['refreshToken'] ?? data['refresh_token'],
      user: data['user'],
    );
    await saveConnection(conn);

    return data;
  }

  /// 刷新 Token
  Future<void> refreshSession() async {
    if (_connection?.refreshToken == null) throw Exception('无刷新令牌');

    final dio = Dio();
    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/auth/refresh',
      data: {'refreshToken': _connection!.refreshToken},
      options: Options(contentType: 'application/json'),
    );

    final conn = _connection!.copyWith(
      accessToken: response.data['accessToken'] ?? response.data['access_token'],
      refreshToken: response.data['refreshToken'] ?? response.data['refresh_token'] ?? _connection!.refreshToken,
    );
    await saveConnection(conn);
  }

  /// 登出
  Future<void> logout() async {
    if (_connection?.accessToken != null) {
      try {
        final dio = Dio();
        await dio.post(
          '${_connection!.apiBaseUrl}/api/auth/logout',
          options: Options(
            headers: {'Authorization': 'Bearer ${_connection!.accessToken}'},
          ),
        );
      } catch (_) {}
    }
    await clearConnection();
  }

  /// 获取可用模型列表
  Future<List<Map<String, dynamic>>> fetchModels() async {
    if (_connection == null) return [];

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      headers: {'Authorization': 'Bearer ${_connection!.accessToken}'},
    ));

    final response = await dio.get('${_connection!.apiBaseUrl}/api/ai/models');
    if (response.data is List) {
      return List<Map<String, dynamic>>.from(response.data);
    }
    return [];
  }

  /// SSE 流式聊天
  Stream<Map<String, dynamic>> streamChat({
    required String question,
    required List<Map<String, String>> history,
  }) async* {
    if (_connection == null) throw Exception('未连接到 khy-os 后端');

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(minutes: 5),
      headers: {
        'Authorization': 'Bearer ${_connection!.accessToken}',
        'Content-Type': 'application/json',
      },
      responseType: ResponseType.stream,
    ));

    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/ai/chat/stream',
      data: {
        'question': question,
        'conversationHistory': history,
      },
    );

    if (response.statusCode != 200) {
      throw Exception('流式连接失败 (HTTP ${response.statusCode})');
    }

    await for (final chunk in response.data.stream) {
      final text = utf8.decode(chunk);
      final lines = text.split('\n');
      for (final line in lines) {
        if (line.startsWith('data:')) {
          final raw = line.substring(5).trim();
          if (raw.isEmpty || raw == '[DONE]') continue;
          try {
            yield jsonDecode(raw);
          } catch (_) {
            yield {'type': 'chunk', 'content': raw};
          }
        }
      }
    }
  }

  /// 通用 API 请求
  Future<Response> apiFetch(String path, {
    String method = 'GET',
    Map<String, dynamic>? data,
    bool auth = true,
  }) async {
    if (_connection == null) throw Exception('未连接到 khy-os 后端');

    final headers = <String, String>{};
    if (auth && _connection!.accessToken != null) {
      headers['Authorization'] = 'Bearer ${_connection!.accessToken}';
    }

    final dio = Dio(BaseOptions(
      baseUrl: '${_connection!.apiBaseUrl}/',
      headers: headers,
    ));

    return dio.request(
      path,
      data: data,
      options: Options(method: method, contentType: 'application/json'),
    );
  }

  /// 上报工具执行日志到 khy-os 后端
  Future<void> reportExecution(Map<String, dynamic> log) async {
    if (!isConnected) return;
    try {
      await apiFetch('/api/mobile/execution-log',
          method: 'POST', data: log);
    } catch (_) {
      // 上报失败不影响本地执行
    }
  }

  void dispose() {
    _connectionController.close();
  }
}
