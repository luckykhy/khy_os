import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import '../config/app_config.dart';

/// Vision Language Model service
/// Sends images + text prompts to VLM APIs for visual understanding
class VisionService {
  final AppConfigData _config;
  final Dio _dio;

  VisionService({required AppConfigData config})
      : _config = config,
        _dio = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(minutes: 2),
        ));

  /// Analyze an image with a text prompt
  Future<String?> analyze(Uint8List imageBytes, String prompt) async {
    try {
      // Convert to base64
      final base64Image = base64Encode(imageBytes);

      final messages = [
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': prompt},
            {
              'type': 'image_url',
              'image_url': {
                'url': 'data:image/jpeg;base64,$base64Image',
              },
            },
          ],
        },
      ];

      final resp = await _dio.post(
        '${_config.baseUrl}/chat/completions',
        data: {
          'model': _config.model,
          'messages': messages,
          'max_tokens': 1024,
        },
        options: Options(
          headers: {
            'Authorization': 'Bearer ${_config.apiKey}',
            'Content-Type': 'application/json',
          },
        ),
      );

      final data = resp.data as Map<String, dynamic>;
      return data['choices']?[0]?['message']?['content'];
    } catch (e) {
      return null;
    }
  }

  /// Describe what's on screen (for Agent automation)
  Future<String?> describeScreen(Uint8List screenshot) async {
    return analyze(screenshot,
        'Describe what you see on this Android phone screen in detail. '
        'Include: visible apps, UI elements, text, buttons, and their positions. '
        'Be specific about locations (top, bottom, left, right, center).');
  }

  /// Find UI elements for automation
  Future<List<Map<String, String>>> findElements(
    Uint8List screenshot,
    String query,
  ) async {
    final description = await analyze(screenshot,
        'Find UI elements matching "$query" on this Android screen. '
        'For each match, respond in JSON format: '
        '[{"text": "element text", "type": "button/text/input/icon", '
        '"position": "top-left/center/bottom-right"}]. '
        'Return only the JSON array, no other text.');

    if (description == null) return [];

    try {
      // Extract JSON from response
      final jsonStr = description.replaceAll('```json', '').replaceAll('```', '').trim();
      final List<dynamic> parsed = jsonDecode(jsonStr);
      return parsed.cast<Map<String, String>>();
    } catch (_) {
      return [];
    }
  }
}
