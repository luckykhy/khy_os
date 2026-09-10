import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Simple conversation storage using SecureStorage
/// (Can be upgraded to SQLite later for larger datasets)
class ConversationDB {
  static const _prefix = 'conv_';
  static const _indexKey = 'conv_index';
  static const _storage = FlutterSecureStorage();

  /// Save a conversation
  static Future<void> save(Conversation conv) async {
    await _storage.write(
      key: _prefix + conv.id,
      value: jsonEncode(conv.toJson()),
    );
    // Update index
    final index = await listIds();
    if (!index.contains(conv.id)) {
      index.add(conv.id);
      await _storage.write(key: _indexKey, value: jsonEncode(index));
    }
  }

  /// Load a conversation
  static Future<Conversation?> load(String id) async {
    final raw = await _storage.read(key: _prefix + id);
    if (raw == null) return null;
    return Conversation.fromJson(jsonDecode(raw));
  }

  /// List all conversation IDs
  static Future<List<String>> listIds() async {
    final raw = await _storage.read(key: _indexKey);
    if (raw == null) return [];
    try {
      return (jsonDecode(raw) as List).cast<String>();
    } catch (_) {
      return [];
    }
  }

  /// List all conversations (summary)
  static Future<List<ConversationSummary>> listAll() async {
    final ids = await listIds();
    final summaries = <ConversationSummary>[];
    for (final id in ids.reversed) {
      final conv = await load(id);
      if (conv != null) {
        summaries.add(ConversationSummary(
          id: conv.id,
          title: conv.title,
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        ));
      }
    }
    return summaries;
  }

  /// Delete a conversation
  static Future<void> delete(String id) async {
    await _storage.delete(key: _prefix + id);
    final index = await listIds();
    index.remove(id);
    await _storage.write(key: _indexKey, value: jsonEncode(index));
  }

  /// Clear all conversations
  static Future<void> clearAll() async {
    final index = await listIds();
    for (final id in index) {
      await _storage.delete(key: _prefix + id);
    }
    await _storage.delete(key: _indexKey);
  }
}

class Conversation {
  final String id;
  final String title;
  final List<ChatMsg> messages;
  final DateTime createdAt;
  final DateTime updatedAt;

  Conversation({
    required this.id,
    this.title = '',
    this.messages = const [],
    DateTime? createdAt,
    DateTime? updatedAt,
  })  : createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now();

  Conversation copyWith({
    String? title,
    List<ChatMsg>? messages,
  }) =>
      Conversation(
        id: id,
        title: title ?? this.title,
        messages: messages ?? this.messages,
        createdAt: createdAt,
        updatedAt: DateTime.now(),
      );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'messages': messages.map((m) => m.toJson()).toList(),
    'createdAt': createdAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
  };

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
    id: json['id'] ?? '',
    title: json['title'] ?? '',
    messages: (json['messages'] as List?)
            ?.map((m) => ChatMsg.fromJson(m))
            .toList() ??
        [],
    createdAt: DateTime.tryParse(json['createdAt'] ?? '') ?? DateTime.now(),
    updatedAt: DateTime.tryParse(json['updatedAt'] ?? '') ?? DateTime.now(),
  );
}

class ChatMsg {
  final String role; // user, assistant, system, tool
  final String content;
  final DateTime timestamp;
  final List<Map<String, dynamic>>? toolCalls;

  ChatMsg({
    required this.role,
    required this.content,
    DateTime? timestamp,
    this.toolCalls,
  }) : timestamp = timestamp ?? DateTime.now();

  Map<String, dynamic> toJson() => {
    'role': role,
    'content': content,
    'timestamp': timestamp.toIso8601String(),
    if (toolCalls != null) 'tool_calls': toolCalls,
  };

  factory ChatMsg.fromJson(Map<String, dynamic> json) => ChatMsg(
    role: json['role'] ?? '',
    content: json['content'] ?? '',
    timestamp: DateTime.tryParse(json['timestamp'] ?? '') ?? DateTime.now(),
    toolCalls: json['tool_calls'] as List<Map<String, dynamic>>?,
  );
}

class ConversationSummary {
  final String id;
  final String title;
  final int messageCount;
  final DateTime createdAt;
  final DateTime updatedAt;

  const ConversationSummary({
    required this.id,
    required this.title,
    required this.messageCount,
    required this.createdAt,
    required this.updatedAt,
  });
}
