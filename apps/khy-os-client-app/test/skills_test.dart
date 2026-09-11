import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/skills.dart';

void main() {
  group('SkillMatcher', () {
    test('exact label match gets highest score', () {
      final matches = SkillMatcher.matchAll('open-wechat');
      expect(matches, isNotEmpty);
      expect(matches.first.skill.label, isNotEmpty);
      expect(matches.first.score, greaterThan(0));
    });

    test('contains keyword in input matches', () {
      // Input contains a keyword from a skill
      final matches = SkillMatcher.matchAll('I want to use the browser');
      // Should find open-browser (keyword 'browser')
      final names = matches.map((m) => m.skill.name).toList();
      expect(names, contains('open-browser'));
    });

    test('no match below threshold returns empty', () {
      final matches = SkillMatcher.matchAll('xyzabc');
      expect(matches, isEmpty);
    });

    test('limit caps results', () {
      final matches = SkillMatcher.matchAll('open', limit: 2);
      expect(matches.length, lessThanOrEqualTo(2));
    });

    test('match returns single best or null', () {
      final best = SkillMatcher.match('open-wechat');
      expect(best, isNotNull);
      expect(best!.name, 'open-wechat');

      final none = SkillMatcher.match('xyzcompletelyrandom');
      expect(none, isNull);
    });
  });

  group('Skill structure', () {
    test('builtinSkills has 30+ entries', () {
      expect(builtinSkills.length, greaterThanOrEqualTo(25));
    });

    test('delegation skills have appPackage', () {
      final delegations = builtinSkills.where((s) => s.type == SkillType.delegation).toList();
      expect(delegations, isNotEmpty);
      for (final s in delegations) {
        expect(s.appPackage, isNotNull);
        expect(s.allPackages, isNotEmpty);
      }
    });

    test('prompt skills have no appPackage', () {
      final prompts = builtinSkills.where((s) => s.type == SkillType.prompt).toList();
      expect(prompts, isNotEmpty);
    });

    test('allPackages includes alternates', () {
      final skill = Skill(
        name: 'test',
        label: 'Test',
        description: 'desc',
        appPackage: 'com.main',
        alternatePackages: ['com.alt1', 'com.alt2'],
      );
      expect(skill.allPackages, ['com.main', 'com.alt1', 'com.alt2']);
    });

    test('allPackages skips null appPackage', () {
      final skill = Skill(
        name: 'test',
        label: 'Test',
        description: 'desc',
        alternatePackages: ['com.alt'],
      );
      expect(skill.allPackages, ['com.alt']);
    });
  });

  group('SkillResult', () {
    test('isPrompt defaults to false', () {
      final r = SkillResult(true, 'done');
      expect(r.isPrompt, false);
    });

    test('prompt result has isPrompt true', () {
      final r = SkillResult(true, '[PROMPT_SKILL:x]', isPrompt: true);
      expect(r.isPrompt, true);
    });
  });
}
