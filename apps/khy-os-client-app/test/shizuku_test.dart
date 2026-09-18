import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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

  group('Shizuku', () {
    test('shizukuStatus available when installed + running', () async {
      mockChannel((call) {
        expect(call.method, 'shizukuStatus');
        return {'installed': true, 'running': true, 'version': '13.1.5'};
      });
      final status = await DeviceControl.getShizukuStatus();
      expect(status.available, true);
      expect(status.version, '13.1.5');
      expect(status.toString(), contains('已就绪'));
    });

    test('shizukuStatus installed but not running', () async {
      mockChannel((_) => {'installed': true, 'running': false, 'version': '13.1.5'});
      final status = await DeviceControl.getShizukuStatus();
      expect(status.installed, true);
      expect(status.available, false);
      expect(status.toString(), contains('未启动'));
    });

    test('shizukuStatus channel error degrades to not-installed', () async {
      mockChannel((_) => throw PlatformException(code: 'no impl'));
      final status = await DeviceControl.getShizukuStatus();
      expect(status.installed, false);
      expect(status.available, false);
      expect(status.toString(), contains('未安装'));
    });

    test('execShellElevated uses shizuku path when available', () async {
      var shizukuCalled = false;
      mockChannel((call) {
        switch (call.method) {
          case 'shizukuStatus':
            return {'installed': true, 'running': true, 'version': '13.1.5'};
          case 'shizukuShell':
            shizukuCalled = true;
            return {'success': true, 'stdout': 'ok', 'stderr': '', 'exitCode': 0, 'via': 'shizuku'};
          default:
            return <Object?>{};
        }
      });
      final r = await DeviceControl.execShellElevated('dumpsys battery');
      expect(shizukuCalled, true);
      expect(r.success, true);
      expect(r.stdout, 'ok');
    });

    test('execShellElevated falls back to plain shell when shizuku absent', () async {
      var plainCalled = false;
      mockChannel((call) {
        switch (call.method) {
          case 'shizukuStatus':
            return {'installed': false, 'running': false, 'version': ''};
          case 'shell':
            plainCalled = true;
            return {'success': false, 'stdout': '', 'stderr': 'permission denied', 'exitCode': 126};
          default:
            return <Object?>{};
        }
      });
      final r = await DeviceControl.execShellElevated('screencap /sdcard/x.png');
      expect(plainCalled, true);
      expect(r.success, false);
      expect(r.stderr, contains('permission denied'));
    });

    test('autoInstallShizuku reports triggered when installer fires', () async {
      mockChannel((call) {
        expect(call.method, 'shizukuAutoInstall');
        return {'triggered': true, 'reason': '已弹出系统安装器'};
      });
      final r = await DeviceControl.autoInstallShizuku();
      expect(r.triggered, true);
      expect(r.reason, isNotEmpty);
    });

    test('autoInstallShizuku degrades to not-triggered on channel error', () async {
      mockChannel((_) => throw PlatformException(code: 'no impl'));
      final r = await DeviceControl.autoInstallShizuku();
      expect(r.triggered, false);
      expect(r.reason, contains('通道错误'));
    });
  });
}
