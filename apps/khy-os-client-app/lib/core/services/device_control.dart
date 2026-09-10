import 'package:flutter/services.dart';

/// Device control service - bridges Dart to Android native code
/// Supports: App/URL, Clipboard, Device info, Accessibility, Screen capture, Shell
class DeviceControl {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  // ==================== App / URL ====================

  /// Open an Android app by package name
  static Future<bool> openApp(String packageName) async {
    try {
      final result = await _channel.invokeMethod('openApp', {'packageName': packageName});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Open a URL in the default browser
  static Future<bool> openUrl(String url) async {
    try {
      final result = await _channel.invokeMethod('openUrl', {'url': url});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Search installed apps by query
  static Future<List<AppInfo>> searchApps(String query) async {
    try {
      final result = await _channel.invokeMethod('searchApps', {'query': query});
      if (result['success'] == true) {
        return (result['apps'] as List).map((a) => AppInfo(
          label: a['label'] ?? '',
          packageName: a['package'] ?? '',
        )).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// List all installed apps
  static Future<List<AppInfo>> listApps() async {
    try {
      final result = await _channel.invokeMethod('listApps');
      if (result['success'] == true) {
        return (result['apps'] as List).map((a) => AppInfo(
          label: a['label'] ?? '',
          packageName: a['package'] ?? '',
        )).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // ==================== Clipboard ====================

  /// Get clipboard text
  static Future<String> getClipboard() async {
    try {
      final result = await _channel.invokeMethod('getClipboard');
      return result['text'] ?? '';
    } catch (e) {
      return '';
    }
  }

  /// Set clipboard text
  static Future<bool> setClipboard(String text) async {
    try {
      final result = await _channel.invokeMethod('setClipboard', {'text': text});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  // ==================== Device ====================

  /// Get device information
  static Future<Map<String, dynamic>> getDeviceInfo() async {
    try {
      final result = await _channel.invokeMethod('getDeviceInfo');
      return Map<String, dynamic>.from(result);
    } catch (e) {
      return {};
    }
  }

  /// Vibrate the device
  static Future<bool> vibrate({int duration = 200}) async {
    try {
      final result = await _channel.invokeMethod('vibrate', {'duration': duration});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Get all installed packages with details
  static Future<List<Map<String, dynamic>>> getInstalledPackages() async {
    try {
      final result = await _channel.invokeMethod('getInstalledPackages');
      if (result['success'] == true) {
        return (result['packages'] as List).cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // ==================== Accessibility Service ====================

  /// Check if accessibility service is ready
  static Future<bool> isAccessibilityReady() async {
    try {
      final result = await _channel.invokeMethod('isAccessibilityReady');
      return result['ready'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Open accessibility settings to enable the service
  static Future<void> openAccessibilitySettings() async {
    try {
      await _channel.invokeMethod('openAccessibilitySettings');
    } catch (e) {}
  }

  /// Tap at coordinates via accessibility service
  static Future<bool> a11yTap(int x, int y) async {
    try {
      final result = await _channel.invokeMethod('a11yTap', {'x': x, 'y': y});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Swipe gesture via accessibility service
  static Future<bool> a11ySwipe(int x1, int y1, int x2, int y2, {int durationMs = 300}) async {
    try {
      final result = await _channel.invokeMethod('a11ySwipe', {
        'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'durationMs': durationMs,
      });
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find and click element by text/id/class
  static Future<bool> a11yFindAndClick(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindAndClick', {'query': query});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find and long-click element
  static Future<bool> a11yFindAndLongClick(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindAndLongClick', {'query': query});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Find element and return its center bounds
  static Future<Map<String, int>?> a11yFindWithBounds(String query) async {
    try {
      final result = await _channel.invokeMethod('a11yFindWithBounds', {'query': query});
      if (result['success'] == true) {
        return {
          'x': result['x'] as int,
          'y': result['y'] as int,
          'w': result['w'] as int,
          'h': result['h'] as int,
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /// Dump the current UI tree (for VLM decision making)
  static Future<String> a11yDumpUi() async {
    try {
      final result = await _channel.invokeMethod('a11yDumpUi');
      return result['dump'] ?? '';
    } catch (e) {
      return '';
    }
  }

  /// List all clickable elements with their bounds
  static Future<List<Map<String, dynamic>>> a11yListClickable() async {
    try {
      final result = await _channel.invokeMethod('a11yListClickable');
      if (result['success'] == true) {
        return (result['items'] as List).cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  /// Type text into focused input field
  static Future<bool> a11yTypeText(String text) async {
    try {
      final result = await _channel.invokeMethod('a11yTypeText', {'text': text});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Perform global action: 1=BACK, 2=HOME, 3=RECENTS, 4=NOTIFICATIONS
  static Future<bool> a11yGlobalAction(int action) async {
    try {
      final result = await _channel.invokeMethod('a11yGlobalAction', {'action': action});
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Global action constants
  static const int globalActionBack = 1;
  static const int globalActionHome = 2;
  static const int globalActionRecents = 3;
  static const int globalActionNotifications = 4;

  // ==================== Screen Capture ====================

  /// Check if screen capture service is ready
  static Future<bool> isScreenCaptureReady() async {
    try {
      final result = await _channel.invokeMethod('isScreenCaptureReady');
      return result['ready'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Start screen capture (will prompt user for permission)
  static Future<bool> startScreenCapture() async {
    try {
      final result = await _channel.invokeMethod('startScreenCapture');
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  /// Capture a single frame, returns base64 JPEG data
  static Future<String?> captureFrame() async {
    try {
      final result = await _channel.invokeMethod('captureFrame');
      if (result['success'] == true) {
        return result['data'] as String?;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /// Stop screen capture service
  static Future<bool> stopScreenCapture() async {
    try {
      final result = await _channel.invokeMethod('stopScreenCapture');
      return result['success'] == true;
    } catch (e) {
      return false;
    }
  }

  // ==================== Shell ====================

  /// Execute a shell command (whitelist restricted)
  static Future<ShellResult> execShell(String command) async {
    try {
      final result = await _channel.invokeMethod('execShell', {'command': command});
      return ShellResult(
        success: result['success'] == true,
        stdout: result['stdout'] ?? '',
        stderr: result['stderr'] ?? '',
        exitCode: result['exitCode'] ?? -1,
      );
    } catch (e) {
      return ShellResult(success: false, stdout: '', stderr: e.toString(), exitCode: -1);
    }
  }

  // ==================== Smart Search ====================

  /// Smart search: try exact match, then fuzzy, then semantic
  static Future<AppInfo?> findApp(String query) async {
    final apps = await searchApps(query);
    if (apps.isEmpty) return null;

    final q = query.toLowerCase();

    // 1. Exact package match
    for (final app in apps) {
      if (app.packageName.toLowerCase() == q) return app;
    }

    // 2. Exact label match
    for (final app in apps) {
      if (app.label.toLowerCase() == q) return app;
    }

    // 3. Label starts with query
    for (final app in apps) {
      if (app.label.toLowerCase().startsWith(q)) return app;
    }

    // 4. Semantic map for common Chinese app names
    final semanticMap = <String, List<String>>{
      '浏览器': ['com.android.browser', 'com.UCMobile', 'org.mozilla.firefox', 'com.android.chrome', 'com.quark.browser'],
      'chrome': ['com.android.chrome'],
      '谷歌': ['com.android.chrome'],
      '微信': ['com.tencent.mm'],
      'qq': ['com.tencent.mobileqq'],
      '淘宝': ['com.taobao.taobao'],
      '支付宝': ['com.eg.android.AlipayGphone'],
      '抖音': ['com.ss.android.ugc.aweme'],
      'b站': ['tv.danmaku.bili', 'com.bilibili.app.in'],
      '哔哩哔哩': ['tv.danmaku.bili'],
      '高德': ['com.autonavi.minimap'],
      '百度': ['com.baidu.searchbox'],
      '设置': ['com.android.settings'],
      '相机': ['com.android.camera', 'com.android.camera2'],
      '相册': ['com.android.gallery3d', 'com.google.android.apps.photos'],
      '电话': ['com.android.dialer', 'com.google.android.dialer'],
      '短信': ['com.android.mms', 'com.google.android.apps.messaging'],
      '音乐': ['com.netease.cloudmusic', 'com.kugou.android'],
      '视频': ['com.youku.phone', 'com.tencent.qqlive'],
      '应用商店': ['com.xiaomi.market', 'com.huawei.appmarket', 'com.android.vending'],
      '日历': ['com.android.calendar'],
      '时钟': ['com.android.deskclock'],
      '文件管理': ['com.android.fileexplorer', 'com.google.android.apps.nbu.files'],
      '计算器': ['com.android.calculator2'],
      '天气': ['com.miui.weather2', 'cn.wildroid.weather'],
      '便签': ['com.miui.notes', 'com.miui.notepad'],
      '外卖': ['com.sankuai.meituan'],
      '美团': ['com.sankuai.meituan'],
      '拼多多': ['com.xunmeng.pinduoduo'],
      '京东': ['com.jingdong.app.mall'],
      '钉钉': ['com.alibaba.android.rimet'],
      '飞书': ['com.ss.android.lark'],
      '知乎': ['com.zhihu.android'],
      '小红书': ['com.xingin.xhs'],
      '微博': ['com.sina.weibo'],
      'twitter': ['com.twitter.android'],
      'x': ['com.twitter.android'],
      'youtube': ['com.google.android.youtube'],
      'telegram': ['org.telegram.messenger'],
      'whatsapp': ['com.whatsapp'],
      'instagram': ['com.instagram.android'],
      'tiktok': ['com.zhiliaoapp.musically'],
      'netflix': ['com.netflix.mediaclient'],
      'spotify': ['com.spotify.music'],
    };

    for (final entry in semanticMap.entries) {
      if (q.contains(entry.key.toLowerCase()) || entry.key.toLowerCase().contains(q)) {
        for (final pkg in entry.value) {
          final match = apps.firstWhere(
            (a) => a.packageName == pkg,
            orElse: () => AppInfo(label: '', packageName: ''),
          );
          if (match.packageName.isNotEmpty) return match;
        }
      }
    }

    // 5. First result as fallback
    return apps.first;
  }
}

class AppInfo {
  final String label;
  final String packageName;

  const AppInfo({required this.label, required this.packageName});

  @override
  String toString() => '$label ($packageName)';
}

class ShellResult {
  final bool success;
  final String stdout;
  final String stderr;
  final int exitCode;

  const ShellResult({
    required this.success,
    required this.stdout,
    required this.stderr,
    required this.exitCode,
  });
}
