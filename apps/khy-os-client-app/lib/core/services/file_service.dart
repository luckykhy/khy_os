import 'package:flutter/services.dart';

/// File system operations within the app's working directory.
/// All paths are relative to the app's external files dir.
class FileService {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  /// Get the working directory path
  static Future<Map<String, dynamic>> getWorkDir() async {
    try {
      final result = await _channel.invokeMethod('getWorkDir');
      return Map<String, dynamic>.from(result as Map);
    } catch (_) {
      return {'path': '', 'exists': false};
    }
  }

  /// List files in a directory (relative path, "" = root)
  static Future<Map<String, dynamic>> listFiles(String path) async {
    try {
      final result = await _channel.invokeMethod('fileList', {'path': path});
      return Map<String, dynamic>.from(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Read a file (relative path)
  static Future<Map<String, dynamic>> readFile(String path) async {
    try {
      final result = await _channel.invokeMethod('fileRead', {'path': path});
      return Map<String, dynamic>.from(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Write a file (relative path + content)
  static Future<Map<String, dynamic>> writeFile(String path, String content) async {
    try {
      final result = await _channel.invokeMethod('fileWrite', {
        'path': path,
        'content': content,
      });
      return Map<String, dynamic>.from(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Create a directory
  static Future<Map<String, dynamic>> createDir(String path) async {
    try {
      final result = await _channel.invokeMethod('fileCreateDir', {'path': path});
      return Map<String, dynamic>.from(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }
}
