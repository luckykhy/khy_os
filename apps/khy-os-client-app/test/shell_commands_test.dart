import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/shell_executor.dart';

void main() {
  // ─── ShellCommands: pure string builders ──────────────────────────

  group('ShellCommands', () {
    test('listPackages default', () {
      expect(ShellCommands.listPackages(), 'pm list packages');
    });

    test('listPackages onlyThirdParty', () {
      expect(ShellCommands.listPackages(onlyThirdParty: true), 'pm list packages -3');
    });

    test('packageInfo', () {
      expect(ShellCommands.packageInfo('com.android.chrome'), 'dumpsys package com.android.chrome');
    });

    test('openApp', () {
      expect(
        ShellCommands.openApp('com.tencent.mm'),
        'monkey -p com.tencent.mm -c android.intent.category.LAUNCHER 1',
      );
    });

    test('startActivity', () {
      expect(
        ShellCommands.startActivity('com.example/.Main'),
        'am start -n com.example/.Main',
      );
    });

    test('tap', () {
      expect(ShellCommands.tap(100, 200), 'input tap 100 200');
    });

    test('swipe default duration', () {
      expect(
        ShellCommands.swipe(10, 20, 30, 40),
        'input swipe 10 20 30 40 300',
      );
    });

    test('swipe custom duration', () {
      expect(
        ShellCommands.swipe(10, 20, 30, 40, durationMs: 500),
        'input swipe 10 20 30 40 500',
      );
    });

    test('inputText', () {
      expect(ShellCommands.inputText('hello'), 'input text "hello"');
    });

    test('inputText escapes double quotes', () {
      expect(ShellCommands.inputText('say "hi"'), 'input text "say \\"hi\\""');
    });

    test('keyEvent', () {
      expect(ShellCommands.keyEvent(4), 'input keyevent 4'); // BACK
    });

    test('screenshot', () {
      expect(
        ShellCommands.screenshot('/sdcard/shot.png'),
        'screencap -p /sdcard/shot.png',
      );
    });

    test('currentActivity', () {
      expect(
        ShellCommands.currentActivity(),
        'dumpsys activity activities | grep mResumedActivity',
      );
    });

    test('windowInfo', () {
      expect(ShellCommands.windowInfo(), 'dumpsys window windows');
    });

    test('runningProcesses', () {
      expect(ShellCommands.runningProcesses(), 'ps -A');
    });

    test('memoryInfo', () {
      expect(
        ShellCommands.memoryInfo('com.example'),
        'dumpsys meminfo com.example',
      );
    });

    test('batteryInfo', () {
      expect(ShellCommands.batteryInfo(), 'dumpsys battery');
    });

    test('networkStatus', () {
      expect(ShellCommands.networkStatus(), 'dumpsys connectivity');
    });

    test('listDir', () {
      expect(ShellCommands.listDir('/tmp'), 'ls -la /tmp');
    });

    test('readFile', () {
      expect(ShellCommands.readFile('/etc/hosts'), 'cat /etc/hosts');
    });

    test('fileExists', () {
      expect(
        ShellCommands.fileExists('/data/local'),
        '[ -f /data/local ] && echo "yes" || echo "no"',
      );
    });

    test('deviceIp', () {
      expect(
        ShellCommands.deviceIp(),
        'ip addr show wlan0 | grep inet',
      );
    });

    test('wifiInfo', () {
      expect(ShellCommands.wifiInfo(), 'dumpsys wifi');
    });

    test('bluetoothStatus', () {
      expect(ShellCommands.bluetoothStatus(), 'dumpsys bluetooth_manager');
    });

    test('sensors', () {
      expect(ShellCommands.sensors(), 'dumpsys sensorservice');
    });

    test('inputDevices', () {
      expect(ShellCommands.inputDevices(), 'dumpsys input');
    });
  });

  // ─── ShellResult (shell_executor version, 6 fields) ───────────────

  group('ShellResult (shell_executor)', () {
    ShellResult makeResult({
      bool success = true,
      String stdout = '',
      String stderr = '',
      int exitCode = 0,
      int durationMs = 100,
      String command = 'echo hi',
    }) {
      return ShellResult(
        success: success,
        stdout: stdout,
        stderr: stderr,
        exitCode: exitCode,
        durationMs: durationMs,
        command: command,
      );
    }

    test('outputLines splits and trims empty lines', () {
      final r = makeResult(stdout: 'line1\n\n  \nline2\n');
      expect(r.outputLines, ['line1', 'line2']);
    });

    test('outputLines empty stdout', () {
      final r = makeResult(stdout: '');
      expect(r.outputLines, isEmpty);
    });

    test('json getter parses valid JSON object', () {
      final r = makeResult(stdout: '{"key": "value"}');
      expect(r.json, {'key': 'value'});
    });

    test('json getter returns null for non-JSON', () {
      final r = makeResult(stdout: 'plain text');
      expect(r.json, isNull);
    });

    test('json getter returns null for array (Map cast fails)', () {
      final r = makeResult(stdout: '[1, 2, 3]');
      expect(r.json, isNull); // casts `as Map<String, dynamic>` which fails for List
    });

    test('jsonList getter parses valid JSON array', () {
      final r = makeResult(stdout: '[1, 2, 3]');
      expect(r.jsonList, [1, 2, 3]);
    });

    test('jsonList getter returns null for object', () {
      final r = makeResult(stdout: '{"a":1}');
      expect(r.jsonList, isNull);
    });

    test('jsonList getter returns null for non-JSON', () {
      final r = makeResult(stdout: 'not json');
      expect(r.jsonList, isNull);
    });

    test('toString format', () {
      final r = makeResult(success: false, stdout: 'out', stderr: 'err', exitCode: 1, durationMs: 50);
      final s = r.toString();
      expect(s, contains('success=false'));
      expect(s, contains('exit=1'));
      expect(s, contains('stdout=3 chars'));
      expect(s, contains('stderr=3 chars'));
    });
  });
}
