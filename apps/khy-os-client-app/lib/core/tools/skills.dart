import '../services/device_control.dart';

/// Skill types:
/// - delegation: directly open an app
/// - compound: multi-step workflow
/// - prompt: AI-driven task (no native action needed)
enum SkillType { delegation, compound, prompt }

/// A Skill maps user intent to a sequence of actions
class Skill {
  final String name;
  final String label;
  final String description;
  final List<String> keywords;
  final SkillType type;
  final String? appPackage;
  final List<String>? alternatePackages; // fallback packages
  final String? deepLink;
  final List<SkillStep>? steps;

  const Skill({
    required this.name,
    required this.label,
    required this.description,
    this.keywords = const [],
    this.type = SkillType.delegation,
    this.appPackage,
    this.alternatePackages,
    this.deepLink,
    this.steps,
  });

  /// All possible packages to try (primary + alternates)
  List<String> get allPackages {
    final list = <String>[];
    if (appPackage != null) list.add(appPackage!);
    if (alternatePackages != null) list.addAll(alternatePackages!);
    return list;
  }
}

class SkillStep {
  final String action; // open_app, open_url, a11y_tap, exec_shell, etc.
  final Map<String, dynamic> args;
  const SkillStep({required this.action, this.args = const {}});
}

/// Skill match result with confidence score
class SkillMatch {
  final Skill skill;
  final int score;
  const SkillMatch(this.skill, this.score);
}

// ============================================================
// Built-in skills
// ============================================================

const builtinSkills = <Skill>[
  // App-opening is unified under the single `open_app` tool
  // (DeviceControl.findApp + semantic map handles all apps generically).
  // These are non-app-opening utility skills only.

  // ---- Utility (prompt type) ----
  Skill(
    name: 'copy-text',
    label: '复制文本',
    description: '将文本复制到剪贴板',
    keywords: ['复制', '拷贝', 'copy', '剪贴板'],
    type: SkillType.prompt,
  ),
  Skill(
    name: 'calculate',
    label: '计算器',
    description: '计算数学表达式',
    keywords: ['计算', '算', '多少', 'calculate', 'math', '等于'],
    type: SkillType.prompt,
  ),
  Skill(
    name: 'screenshot',
    label: '截屏',
    description: '截取当前屏幕',
    keywords: ['截屏', '截图', 'screenshot', '屏幕截图'],
    type: SkillType.prompt,
  ),
  Skill(
    name: 'go-home',
    label: '回到主页',
    description: '按Home键回到手机主页',
    keywords: ['回主页', 'home', '主屏幕', '桌面'],
    type: SkillType.prompt,
  ),
  Skill(
    name: 'go-back',
    label: '返回',
    description: '按返回键',
    keywords: ['返回', 'back', '后退', '退出'],
    type: SkillType.prompt,
  ),
];

// ============================================================
// Skill Matcher
// ============================================================

class SkillMatcher {
  /// Match user input to skills, returns sorted by score descending
  static List<SkillMatch> matchAll(String userInput, {int limit = 3}) {
    final text = userInput.toLowerCase();
    final matches = <SkillMatch>[];

    for (final skill in builtinSkills) {
      int score = 0;

      // Exact label match = highest score
      if (text == skill.label.toLowerCase()) {
        score += 20;
      }

      // Label contains in input
      if (text.contains(skill.label.toLowerCase())) {
        score += 10;
      }

      // Input contains in label (partial match)
      for (final kw in skill.keywords) {
        if (text.contains(kw.toLowerCase())) {
          score += 5;
        }
      }

      // Keyword in label match
      for (final kw in skill.keywords) {
        if (skill.label.toLowerCase().contains(kw.toLowerCase())) {
          score += 2;
        }
      }

      if (score >= 5) {
        matches.add(SkillMatch(skill, score));
      }
    }

    matches.sort((a, b) => b.score.compareTo(a.score));
    return matches.take(limit).toList();
  }

  /// Best single match
  static Skill? match(String userInput) {
    final matches = matchAll(userInput, limit: 1);
    return matches.isNotEmpty ? matches.first.skill : null;
  }
}

// ============================================================
// Skill Executor
// ============================================================

class SkillExecutor {
  /// Execute a skill, returns success message or error
  static Future<SkillResult> execute(Skill skill) async {
    switch (skill.type) {
      case SkillType.delegation:
        return _executeDelegation(skill);
      case SkillType.compound:
        return _executeCompound(skill);
      case SkillType.prompt:
        return _executePrompt(skill);
    }
  }

  static Future<SkillResult> _executeDelegation(Skill skill) async {
    if (skill.deepLink != null) {
      final ok = await DeviceControl.openUrl(skill.deepLink!);
      return SkillResult(ok, ok ? '已打开 ${skill.label}' : '打开失败: ${skill.label}');
    }

    // Try each package in order
    for (final pkg in skill.allPackages) {
      final ok = await DeviceControl.openApp(pkg);
      if (ok) {
        return SkillResult(true, '已打开 ${skill.label}');
      }
    }

    // Fallback: search for the app
    final app = await DeviceControl.findApp(skill.label);
    if (app != null) {
      final ok = await DeviceControl.openApp(app.packageName);
      return SkillResult(ok, ok ? '已打开 ${app.label}' : '启动失败: ${app.label}');
    }

    return SkillResult(false, '未找到应用: ${skill.label}');
  }

  static Future<SkillResult> _executeCompound(Skill skill) async {
    if (skill.steps == null || skill.steps!.isEmpty) {
      return SkillResult(false, '技能 "${skill.label}" 无步骤定义');
    }

    final results = <String>[];
    for (final step in skill.steps!) {
      final r = await _executeStep(step);
      results.add(r.message);
      if (!r.success) {
        return SkillResult(false, '步骤失败: ${r.message}');
      }
    }

    return SkillResult(true, results.join('\n'));
  }

  static Future<SkillResult> _executePrompt(Skill skill) async {
    // Prompt skills are handled by the AI, not executed directly
    // Return a hint for the AI to handle
    return SkillResult(true, '[PROMPT_SKILL:${skill.name}]', isPrompt: true);
  }

  static Future<SkillResult> _executeStep(SkillStep step) async {
    switch (step.action) {
      case 'open_app':
        final pkg = step.args['package'] ?? '';
        final ok = await DeviceControl.openApp(pkg);
        return SkillResult(ok, ok ? '已打开 $pkg' : '打开失败: $pkg');
      case 'open_url':
        final url = step.args['url'] ?? '';
        final ok = await DeviceControl.openUrl(url);
        return SkillResult(ok, ok ? '已打开 $url' : '打开失败: $url');
      case 'a11y_tap':
        final x = step.args['x'] ?? 0;
        final y = step.args['y'] ?? 0;
        final ok = await DeviceControl.a11yTap(x, y);
        return SkillResult(ok, ok ? '已点击 ($x, $y)' : '点击失败');
      case 'exec_shell':
        final cmd = step.args['command'] ?? '';
        final r = await DeviceControl.execShell(cmd);
        return SkillResult(r.success, r.stdout);
      default:
        return SkillResult(false, '未知操作: ${step.action}');
    }
  }
}

class SkillResult {
  final bool success;
  final String message;
  final bool isPrompt;

  const SkillResult(this.success, this.message, {this.isPrompt = false});
}
