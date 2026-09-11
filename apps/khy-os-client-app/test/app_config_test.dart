import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/config/built_in_keys.dart';

void main() {
  group('AppConfigData', () {
    test('hasUserKey', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-123', model: 'gpt-4');
      expect(c.hasUserKey, true);

      final empty = AppConfigData(baseUrl: 'https://x.com', apiKey: '', model: 'gpt-4');
      expect(empty.hasUserKey, false);
    });

    test('isConfigured requires baseUrl AND effectiveApiKey', () {
      final c = AppConfigData(baseUrl: '', apiKey: '', model: 'gpt-4');
      expect(c.isConfigured, false);

      final ok = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-123', model: 'gpt-4');
      expect(ok.isConfigured, true);
    });

    test('effectiveApiKey uses user key when present', () {
      final c = AppConfigData(baseUrl: 'https://unknown.com', apiKey: 'user-key', model: 'm');
      expect(c.effectiveApiKey, 'user-key');
    });

    test('effectiveApiKey falls back to builtin for known baseUrl', () {
      // Use a known builtin provider URL
      final providers = BuiltInKeys.providers;
      expect(providers, isNotEmpty);

      BuiltInProvider? firstWithKey; try { firstWithKey = providers.values.firstWhere((p) => p.hasKey); } catch (_) {}
      if (firstWithKey != null) {
        final c = AppConfigData(baseUrl: firstWithKey.baseUrl, apiKey: '', model: 'm');
        expect(c.hasBuiltInKey, true);
        expect(c.effectiveApiKey, isNotEmpty);
        expect(c.usingBuiltInKey, true);
      }
    });

    test('maskedApiKey shows first8...last4 for long keys', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-abcdefghijklmnop', model: 'm');
      final masked = c.maskedApiKey;
      expect(masked, contains('...'));
      expect(masked.length, lessThan('sk-abcdefghijklmnop'.length));
    });

    test('maskedApiKey short key unchanged', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'short', model: 'm');
      expect(c.maskedApiKey, 'short');
    });

    test('maskedApiKey empty when no user key', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: '', model: 'm');
      expect(c.maskedApiKey, '');
    });

    test('hasVisionConfig', () {
      final no = AppConfigData(baseUrl: 'https://x.com', apiKey: 'k', model: 'm');
      expect(no.hasVisionConfig, false);

      final yes = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'k', model: 'm',
        visionBaseUrl: 'https://vision.com', visionApiKey: 'vk', visionModel: 'gpt-4o',
      );
      expect(yes.hasVisionConfig, true);
    });

    test('effectiveVisionKey falls back to main key', () {
      final c = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'https://vision.com', visionModel: 'gpt-4o',
      );
      expect(c.effectiveVisionKey, 'main-key');

      final withVisionKey = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'https://vision.com', visionApiKey: 'vision-key', visionModel: 'gpt-4o',
      );
      expect(withVisionKey.effectiveVisionKey, 'vision-key');
    });

    test('toJson / fromJson round-trip', () {
      final original = AppConfigData(
        baseUrl: 'https://api.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        systemPrompt: 'be nice',
        visionBaseUrl: 'https://vision.com',
        visionApiKey: 'vk',
        visionModel: 'gpt-4o-vision',
      );
      final restored = AppConfigData.fromJson(original.toJson());
      expect(restored.baseUrl, original.baseUrl);
      expect(restored.apiKey, original.apiKey);
      expect(restored.model, original.model);
      expect(restored.systemPrompt, original.systemPrompt);
      expect(restored.visionBaseUrl, original.visionBaseUrl);
      expect(restored.visionApiKey, original.visionApiKey);
      expect(restored.visionModel, original.visionModel);
    });

    test('copyWith preserves unchanged fields', () {
      final original = AppConfigData(baseUrl: 'https://a.com', apiKey: 'key', model: 'm');
      final updated = original.copyWith(model: 'new-model');
      expect(updated.model, 'new-model');
      expect(updated.baseUrl, 'https://a.com');
      expect(updated.apiKey, 'key');
    });
  });

  group('BuiltInKeys', () {
    test('providers is non-empty', () {
      expect(BuiltInKeys.providers, isNotEmpty);
    });

    test('get returns provider by name or null', () {
      final names = BuiltInKeys.providers.keys.toList();
      final found = BuiltInKeys.get(names.first);
      expect(found, isNotNull);
      expect(found!.baseUrl, isNotEmpty);

      expect(BuiltInKeys.get('nonexistent-provider-xyz'), isNull);
    });

    test('matchBaseUrl exact match', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        expect(BuiltInKeys.matchBaseUrl(withKey.baseUrl), isA<String>());
      }
    });

    test('matchBaseUrl unknown URL returns null', () {
      expect(BuiltInKeys.matchBaseUrl('https://unknown-domain-xyz.com/v1'), isNull);
    });

    test('hasBuiltInKey true for known provider with key', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        expect(BuiltInKeys.hasBuiltInKey(withKey.baseUrl), true);
      }
    });

    test('hasBuiltInKey false for unknown URL', () {
      expect(BuiltInKeys.hasBuiltInKey('https://not-a-provider.com/v1'), false);
    });

    test('getBuiltInKey returns non-empty for known provider', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        final key = BuiltInKeys.getBuiltInKey(withKey.baseUrl);
        expect(key, isNotEmpty);
      }
    });

    test('getBuiltInKey returns empty for unknown URL', () {
      expect(BuiltInKeys.getBuiltInKey('https://unknown.com/v1'), '');
    });

    test('defaultProvider has a key', () {
      expect(BuiltInKeys.defaultProvider.hasKey, true);
    });
  });
}
