import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/pairing.dart';

/// Contract tests for the consumer half of the pairing payload.
///
/// The canonical input is exactly what
/// `services/backend/src/cli/handlers/mobile.js#buildPairingPayload` emits:
///   `JSON.stringify({ apiBaseUrl: 'http://&lt;lan-ipv4&gt;:&lt;port&gt;' })`
///
/// The three cases below are the ones that regressed in the field: JSON was fed
/// to `Uri.splitQueryString` (which splits on `&` and `=`, not on JSON), so the
/// envelope was handed to `verifyAndSave` verbatim and every connection failed
/// with a malformed-URL error.
void main() {
  group('PairingPayloadParser.parse — JSON envelope', () {
    test('parses the canonical payload the CLI actually emits', () {
      final p = PairingPayloadParser.parse('{"apiBaseUrl":"http://192.168.1.9:3000"}');
      expect(p.apiBaseUrl, 'http://192.168.1.9:3000');
    });

    test('tolerates whitespace and newlines inside and around the JSON', () {
      const raw = '''
      {
        "apiBaseUrl": "http://192.168.1.9:3000"
      }''';
      expect(PairingPayloadParser.parse(raw).apiBaseUrl, 'http://192.168.1.9:3000');
    });

    test('accepts a JSON envelope wrapped in quotes (paste from a terminal)', () {
      final p = PairingPayloadParser.parse('\'{"apiBaseUrl":"http://10.0.0.5:8080"}\'');
      expect(p.apiBaseUrl, 'http://10.0.0.5:8080');
    });

    test('accepts the legacy alternate keys', () {
      expect(
        PairingPayloadParser.parse('{"apiUrl":"http://10.0.0.5:8080"}').apiBaseUrl,
        'http://10.0.0.5:8080',
      );
      expect(
        PairingPayloadParser.parse('{"url":"http://10.0.0.5:8080"}').apiBaseUrl,
        'http://10.0.0.5:8080',
      );
    });

    test('strips a trailing slash so <base>/api/health never doubles it', () {
      expect(
        PairingPayloadParser.parse('{"apiBaseUrl":"http://192.168.1.9:3000/"}').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });

    test('keeps a non-root path (reverse-proxied deployments)', () {
      expect(
        PairingPayloadParser.parse('{"apiBaseUrl":"https://my.host/khy"}').apiBaseUrl,
        'https://my.host/khy',
      );
    });

    test('coerces a scheme-less address to http', () {
      expect(
        PairingPayloadParser.parse('{"apiBaseUrl":"192.168.1.9:3000"}').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });
  });

  group('PairingPayloadParser.parse — bare forms', () {
    test('accepts a bare http URL', () {
      expect(
        PairingPayloadParser.parse('http://192.168.1.9:3000').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });

    test('accepts a bare https URL', () {
      expect(
        PairingPayloadParser.parse('https://khy.example.com').apiBaseUrl,
        'https://khy.example.com',
      );
    });

    test('accepts a bare host:port and assumes http', () {
      expect(
        PairingPayloadParser.parse('192.168.1.9:3000').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });

    test('drops zero-width characters injected by some QR keyboards', () {
      expect(
        PairingPayloadParser.parse('http://192.168.1.9:3000\u200B').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });

    test('uses the first non-empty line of a multi-line paste', () {
      expect(
        PairingPayloadParser.parse('\n\n192.168.1.9:3000\n豆瓣酱\n').apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });
  });

  group('PairingPayloadParser.parse — rejects with an actionable message', () {
    test('rejects the management-page QR (`khy mobile`, not `khy mobile app`)', () {
      expect(
        () => PairingPayloadParser.parse('http://192.168.1.9:9090/admin/ai-gateway'),
        throwsA(
          isA<PairingParseException>().having(
            (e) => e.message,
            'message',
            allOf(contains('管理页二维码'), contains('khy mobile app')),
          ),
        ),
      );
    });

    test('rejects the management page even when it arrives in a JSON envelope', () {
      expect(
        () => PairingPayloadParser.parse(
          '{"apiBaseUrl":"http://192.168.1.9:9090/admin/ai-gateway"}',
        ),
        throwsA(isA<PairingParseException>()),
      );
    });

    test('does not mistake a similarly-prefixed API path for the management page', () {
      expect(
        PairingPayloadParser.parse('http://h:1/admin/ai-gateway-api').apiBaseUrl,
        'http://h:1/admin/ai-gateway-api',
      );
    });

    test('rejects empty input', () {
      expect(
        () => PairingPayloadParser.parse('   '),
        throwsA(
          isA<PairingParseException>()
              .having((e) => e.message, 'message', contains('配对内容为空')),
        ),
      );
    });

    test('rejects malformed JSON with a fix suggestion', () {
      expect(
        () => PairingPayloadParser.parse('{"apiBaseUrl":'),
        throwsA(
          isA<PairingParseException>()
              .having((e) => e.message, 'message', contains('不是合法 JSON')),
        ),
      );
    });

    test('rejects a JSON envelope with no usable key, naming what it saw', () {
      expect(
        () => PairingPayloadParser.parse('{"host":"192.168.1.9","port":3000}'),
        throwsA(
          isA<PairingParseException>()
              .having((e) => e.message, 'message', allOf(contains('apiBaseUrl'), contains('host'))),
        ),
      );
    });

    test('rejects a JSON array (not an object)', () {
      expect(
        () => PairingPayloadParser.parse('["http://192.168.1.9:3000"]'),
        throwsA(isA<PairingParseException>()),
      );
    });

    test('rejects a non-http scheme', () {
      expect(
        () => PairingPayloadParser.parse('ftp://192.168.1.9:3000'),
        throwsA(
          isA<PairingParseException>()
              .having((e) => e.message, 'message', contains('协议不支持')),
        ),
      );
    });

    test('rejects a scheme with no host', () {
      expect(
        () => PairingPayloadParser.parse('http://'),
        throwsA(isA<PairingParseException>()),
      );
    });

    test('rejects an undialable host instead of failing later in dio', () {
      // Dart's Uri is permissive: it happily keeps stray brackets or a space
      // from a mis-scanned QR. The parser must reject them, otherwise the
      // failure resurfaces later as an opaque network error.
      expect(
        () => PairingPayloadParser.parse('[1,2,3]'),
        throwsA(isA<PairingParseException>()),
      );
      expect(
        () => PairingPayloadParser.parse('http://192.168.1"9:3000'),
        throwsA(isA<PairingParseException>()),
      );
      expect(
        () => PairingPayloadParser.parse('http://bad host'),
        throwsA(isA<PairingParseException>()),
      );
    });

    test('rejects a non-numeric port instead of crashing on Uri.port', () {
      // `Uri.port` throws ArgumentError on a non-numeric port. The parser reads
      // the raw port text first so this degrades to a message, not a crash.
      expect(
        () => PairingPayloadParser.parse('http://192.168.1.9:abc'),
        throwsA(
          isA<PairingParseException>().having(
            (e) => e.message,
            'message',
            anyOf(contains('端口越界'), contains('不是有效地址')),
          ),
        ),
      );
    });

    test('rejects out-of-range ports', () {
      for (final bad in ['http://192.168.1.9:0', 'http://192.168.1.9:70000']) {
        expect(
          () => PairingPayloadParser.parse(bad),
          throwsA(
            isA<PairingParseException>().having(
              (e) => e.message,
              'message',
              contains('端口越界'),
            ),
          ),
          reason: bad,
        );
      }
    });

    test('accepts an IPv6 literal, with and without a port', () {
      expect(PairingPayloadParser.parse('http://[::1]').apiBaseUrl, contains('::1'));
      expect(PairingPayloadParser.parse('[::1]:3000').apiBaseUrl, contains('::1'));
    });
  });

  group('PairingPayloadParser.tryParse', () {
    test('returns null instead of throwing on bad input', () {
      expect(PairingPayloadParser.tryParse('not an address at all'), isNull);
      expect(PairingPayloadParser.tryParse(''), isNull);
    });

    test('returns the payload on good input', () {
      expect(
        PairingPayloadParser.tryParse('192.168.1.9:3000')?.apiBaseUrl,
        'http://192.168.1.9:3000',
      );
    });
  });
}
