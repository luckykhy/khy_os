import 'package:flutter/services.dart';

/// Result shape returned by [FileService] methods.
typedef FileResult = Map<String, dynamic>;

/// Coerce a raw MethodChannel map (Object?, Object?) into a String-keyed map
/// so callers can safely index with string keys and cast element types.
FileResult _mapResult(Map raw) =>
    raw.map((key, value) => MapEntry(key.toString(), value));

/// File system operations within the app's working directory.
/// All paths are relative to the app's external files dir.
class FileService {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  /// Get the working directory path
  static Future<Map<String, dynamic>> getWorkDir() async {
    try {
      final result = await _channel.invokeMethod('getWorkDir');
      return _mapResult(result as Map);
    } catch (_) {
      return {'path': '', 'exists': false};
    }
  }

  /// List files in a directory (relative path, "" = root)
  static Future<Map<String, dynamic>> listFiles(String path) async {
    try {
      final result = await _channel.invokeMethod('fileList', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Read a file (relative path)
  static Future<Map<String, dynamic>> readFile(String path) async {
    try {
      final result = await _channel.invokeMethod('fileRead', {'path': path});
      return _mapResult(result as Map);
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
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Create a directory
  static Future<Map<String, dynamic>> createDir(String path) async {
    try {
      final result = await _channel.invokeMethod('fileCreateDir', {'path': path});
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Edit a file (string replacement)
  static Future<Map<String, dynamic>> editFile(
    String path,
    String oldText,
    String newText, {
    bool replaceAll = false,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileEdit', {
        'path': path,
        'oldText': oldText,
        'newText': newText,
        'replaceAll': replaceAll,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Find files by glob pattern
  static Future<Map<String, dynamic>> findFiles(
    String dir,
    String pattern, {
    int maxResults = 50,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileFind', {
        'dir': dir,
        'pattern': pattern,
        'maxResults': maxResults,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }

  /// Search file contents with regex
  static Future<Map<String, dynamic>> grepFiles(
    String dir,
    String regex, {
    String filePattern = '',
    int maxResults = 30,
  }) async {
    try {
      final result = await _channel.invokeMethod('fileGrep', {
        'dir': dir,
        'regex': regex,
        'filePattern': filePattern,
        'maxResults': maxResults,
      });
      return _mapResult(result as Map);
    } catch (_) {
      return {'success': false, 'error': 'channel error'};
    }
  }
}
