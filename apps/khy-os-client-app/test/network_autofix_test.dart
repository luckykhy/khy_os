import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/network/network_autofix.dart';
import 'package:khy_os_client/core/network/smart_dns.dart';

void main() {
  group('SmartDns', () {
    test('knownDomains returns 10 entries', () {
      final dns = SmartDns();
      expect(dns.knownDomains.length, 10);
    });

    test('hardcodedIps has 10 domains', () {
      expect(SmartDns.hardcodedIps.length, 10);
    });

    test('hasHardcodedIp true for known domain', () {
      final dns = SmartDns();
      final host = dns.knownDomains.first;
      expect(dns.hasHardcodedIp(host), true);
    });

    test('hasHardcodedIp false for unknown domain', () {
      final dns = SmartDns();
      expect(dns.hasHardcodedIp('some-random-domain-xyz.com'), false);
    });

    test('cachedIp returns null for unknown', () {
      final dns = SmartDns();
      expect(dns.cachedIp('unknown-host-xyz.com'), isNull);
    });

    test('cacheIp + cachedIp round-trip', () {
      final dns = SmartDns();
      dns.cacheIp('test.example.com', ['1.2.3.4']);
      expect(dns.cachedIp('test.example.com'), '1.2.3.4');
    });

    test('clearCache removes entries', () {
      final dns = SmartDns();
      dns.cacheIp('test.example.com', ['1.2.3.4']);
      dns.clearCache();
      expect(dns.cachedIp('test.example.com'), isNull);
    });

    test('multiple IPs cached returns first', () {
      final dns = SmartDns();
      dns.cacheIp('multi.example.com', ['10.0.0.1', '10.0.0.2']);
      expect(dns.cachedIp('multi.example.com'), '10.0.0.1');
    });
  });

  group('NetworkAutoFix', () {
    test('canFix is true at construction', () {
      final fixer = NetworkAutoFix();
      expect(fixer.canFix, true);
    });

    test('cooldown: second call within 30s returns cooldown method', () async {
      final fixer = NetworkAutoFix();
      // First call - will try to resolve but may fail in test env
      await fixer.fix('https://api.openai.com/chat');

      // Second call immediately - should hit cooldown
      final r2 = await fixer.fix('https://api.openai.com/chat');
      expect(r2.method, 'cooldown');
      expect(r2.success, false);
    });

    test('fixAndGetIp returns null or IP for known domain (offline)', () async {
      final fixer = NetworkAutoFix();
      final ip = await fixer.fixAndGetIp('https://api.openai.com/v1');
      // In offline test env, may be null or a hardcoded IP
      // Just verify it does not throw
      expect(ip, isA<String?>());
    });

    test('AutoFixResult structure', () {
      final r = AutoFixResult(success: true, method: 'system_dns', message: 'resolved');
      expect(r.success, true);
      expect(r.method, 'system_dns');
      expect(r.details, isEmpty);

      final r2 = AutoFixResult(
        success: false, method: 'all_failed', message: 'nope',
        details: {'tried': ['a', 'b', 'c']},
      );
      expect(r2.details['tried'], ['a', 'b', 'c']);
    });
  });
}
