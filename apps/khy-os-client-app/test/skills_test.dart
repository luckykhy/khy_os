import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/skills.dart';

void main() {
  group('SkillMatcher', () {
    test('exact name match gets highest score', () {
      final matches = SkillMatcher.matchAll('screenshot');
      expect(matches, isNotEmpty);
      expect(matches.first.skill.name, 'screenshot');
      expect(matches.first.score, greaterThan(0));
    });

    test('keyword in input matches', () {
      final matches = SkillMatcher.matchAll('take a screenshot please');
      final names = matches.map((m) => m.skill.name).toList();
      expect(names, contains('screenshot'));
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
      final best = SkillMatcher.match('screenshot');
      expect(best, isNotNull);
      expect(best!.name, 'screenshot');

      final none = SkillMatcher.match('xyzcompletelyrandom');
      expect(none, isNull);
    });
  });

  group('Skill structure', () {
    test('builtinSkills has exactly 5 prompt-type skills', () {
      expect(builtinSkills.length, 5);
      for (final s in builtinSkills) {
        expect(s.type, SkillType.prompt);
      }
    });

    test('no delegation skills remain', () {
      final delegations = builtinSkills.where((s) => s.type == SkillType.delegation).toList();
      expect(delegations, isEmpty);
    });

    test('allPackages empty for prompt skills (no appPackage)', () {
      for (final s in builtinSkills) {
        expect(s.appPackage, isNull);
      }
    });

    test('allPackages includes alternates when set', () {
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
