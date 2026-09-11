import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/device_control.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('openApp / openUrl', () {
    test('openApp success', () async {
      mockChannel((call) {
        expect(call.method, 'openApp');
        return {'success': true};
      });
      expect(await DeviceControl.openApp('com.tencent.mm'), true);
    });

    test('openApp failure', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.openApp('com.unknown'), false);
    });

    test('openApp exception returns false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.openApp('com.x'), false);
    });

    test('openUrl success', () async {
      mockChannel((call) {
        expect(call.method, 'openUrl');
        return {'success': true};
      });
      expect(await DeviceControl.openUrl('https://example.com'), true);
    });

    test('openUrl exception returns false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.openUrl('https://x.com'), false);
    });
  });

  group('Clipboard', () {
    test('getClipboard returns text', () async {
      mockChannel((call) {
        expect(call.method, 'getClipboard');
        return {'text': 'hello world'};
      });
      expect(await DeviceControl.getClipboard(), 'hello world');
    });

    test('getClipboard missing key returns empty', () async {
      mockChannel((_) => <Object?>{});
      expect(await DeviceControl.getClipboard(), '');
    });

    test('setClipboard success', () async {
      mockChannel((call) {
        expect(call.method, 'setClipboard');
        return {'success': true};
      });
      expect(await DeviceControl.setClipboard('data'), true);
    });
  });

  group('searchApps / findApp', () {
    test('searchApps maps results', () async {
      mockChannel((call) {
        expect(call.method, 'searchApps');
        return {
          'success': true,
          'apps': [
            {'label': 'Chrome', 'package': 'com.android.chrome'},
            {'label': 'DingTalk', 'package': 'com.alibaba.android.rimet'},
          ],
        };
      });
      final apps = await DeviceControl.searchApps('browser');
      expect(apps.length, 2);
      expect(apps[0].label, 'Chrome');
      expect(apps[0].packageName, 'com.android.chrome');
    });

    test('searchApps not-success returns empty', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.searchApps('x'), isEmpty);
    });

    test('searchApps exception returns empty', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.searchApps('x'), isEmpty);
    });

    test('findApp falls back to first app when no match', () async {
      mockChannel((_) => {
        'success': true,
        'apps': [
          {'label': 'Some App', 'package': 'com.example.app'},
        ],
      });
      final found = await DeviceControl.findApp('completely unrelated');
      expect(found, isNotNull);
      expect(found!.label, 'Some App');
    });

    test('findApp returns null when searchApps empty', () async {
      mockChannel((_) => {'success': true, 'apps': <Object?>[]});
      final found = await DeviceControl.findApp('anything');
      expect(found, isNull);
    });
  });

  group('Accessibility', () {
    test('isAccessibilityReady true', () async {
      mockChannel((call) {
        expect(call.method, 'isAccessibilityReady');
        return {'ready': true};
      });
      expect(await DeviceControl.isAccessibilityReady(), true);
    });

    test('isAccessibilityReady false', () async {
      mockChannel((_) => {'ready': false});
      expect(await DeviceControl.isAccessibilityReady(), false);
    });

    test('a11yTap passes coordinates', () async {
      mockChannel((call) {
        expect(call.method, 'a11yTap');
        expect(call.arguments['x'], 100);
        expect(call.arguments['y'], 200);
        return {'success': true};
      });
      expect(await DeviceControl.a11yTap(100, 200), true);
    });

    test('a11yGlobalAction HOME', () async {
      mockChannel((call) {
        expect(call.method, 'a11yGlobalAction');
        expect(call.arguments['action'], 2);
        return {'success': true};
      });
      expect(await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome), true);
    });
  });

  group('Screen Capture', () {
    test('isScreenCaptureReady', () async {
      mockChannel((call) {
        expect(call.method, 'isScreenCaptureReady');
        return {'ready': true};
      });
      expect(await DeviceControl.isScreenCaptureReady(), true);
    });

    test('captureFrame returns data', () async {
      mockChannel((_) => {'success': true, 'data': 'iVBORw0KGgo='});
      expect(await DeviceControl.captureFrame(), 'iVBORw0KGgo=');
    });

    test('captureFrame not-success returns null', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.captureFrame(), isNull);
    });
  });

  group('execShell', () {
    test('success with stdout', () async {
      mockChannel((call) {
        expect(call.method, 'shell');
        expect(call.arguments['command'], 'echo hi');
        return {'success': true, 'stdout': 'hi\n', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShell('echo hi');
      expect(r.success, true);
      expect(r.stdout, 'hi\n');
      expect(r.exitCode, 0);
    });

    test('failure with stderr', () async {
      mockChannel((_) => {'success': false, 'stdout': '', 'stderr': 'Permission denied', 'exitCode': 126});
      final r = await DeviceControl.execShell('rm /');
      expect(r.success, false);
      expect(r.stderr, 'Permission denied');
      expect(r.exitCode, 126);
    });

    test('exception returns failure', () async {
      mockChannel((_) => throw PlatformException(code: 'timeout'));
      final r = await DeviceControl.execShell('hang');
      expect(r.success, false);
      expect(r.exitCode, -1);
    });
  });

  group('checkPermissions', () {
    test('all granted', () async {
      mockChannel((call) {
        expect(call.method, 'checkPermissions');
        return {'notifications': true, 'overlay': true, 'accessibility': true};
      });
      final status = await DeviceControl.checkPermissions();
      expect(status.allGranted, true);
      expect(status.missingList, isEmpty);
    });

    test('some missing', () async {
      mockChannel((_) => {'notifications': true, 'overlay': false, 'accessibility': false});
      final status = await DeviceControl.checkPermissions();
      expect(status.allGranted, false);
      expect(status.anyMissing, true);
      expect(status.missingList.length, 2);
    });

    test('exception returns all-false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      final status = await DeviceControl.checkPermissions();
      expect(status.notifications, false);
      expect(status.overlay, false);
      expect(status.accessibility, false);
      expect(status.missingList.length, 3);
    });
  });

  group('getDeviceInfo', () {
    test('returns map', () async {
      mockChannel((call) {
        expect(call.method, 'getDeviceInfo');
        return {'manufacturer': 'Google', 'model': 'Pixel 8', 'sdk': 34};
      });
      final info = await DeviceControl.getDeviceInfo();
      expect(info['manufacturer'], 'Google');
      expect(info['model'], 'Pixel 8');
    });

    test('exception returns empty map', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.getDeviceInfo(), isEmpty);
    });
  });
}
