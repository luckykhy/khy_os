/// A Skill maps user intent to a sequence of actions
class Skill {
  final String name;
  final String label;
  final String description;
  final List<String> keywords;
  final SkillType type;
  final String? deepLink;
  final String? appPackage;
  final List<SkillStep>? steps;

  const Skill({
    required this.name,
    required this.label,
    required this.description,
    this.keywords = const [],
    this.type = SkillType.delegation,
    this.deepLink,
    this.appPackage,
    this.steps,
  });
}

enum SkillType { delegation, guiAutomation, prompt }

class SkillStep {
  final String action;
  final Map<String, dynamic> args;
  const SkillStep({required this.action, this.args = const {}});
}

/// Built-in skills for common tasks
const builtinSkills = [
  Skill(
    name: 'open-browser',
    label: '打开浏览器',
    description: '打开系统默认浏览器',
    keywords: ['浏览器', '上网', '浏览', 'browser', 'chrome'],
    type: SkillType.delegation,
    appPackage: 'com.android.chrome',
  ),
  Skill(
    name: 'open-wechat',
    label: '打开微信',
    description: '打开微信应用',
    keywords: ['微信', 'wechat', 'weixin'],
    type: SkillType.delegation,
    appPackage: 'com.tencent.mm',
  ),
  Skill(
    name: 'open-settings',
    label: '打开设置',
    description: '打开系统设置',
    keywords: ['设置', 'settings', '系统设置'],
    type: SkillType.delegation,
    appPackage: 'com.android.settings',
  ),
  Skill(
    name: 'open-maps',
    label: '打开地图',
    description: '打开高德地图',
    keywords: ['地图', '导航', '高德', 'amap', 'maps'],
    type: SkillType.delegation,
    appPackage: 'com.autonavi.minimap',
  ),
  Skill(
    name: 'open-camera',
    label: '打开相机',
    description: '打开系统相机',
    keywords: ['相机', '拍照', 'camera'],
    type: SkillType.delegation,
    appPackage: 'com.android.camera',
  ),
  Skill(
    name: 'copy-text',
    label: '复制文本',
    description: '将文本复制到剪贴板',
    keywords: ['复制', '拷贝', 'copy'],
    type: SkillType.prompt,
  ),
  Skill(
    name: 'calculate',
    label: '计算器',
    description: '计算数学表达式',
    keywords: ['计算', '算', '多少', 'calculate', 'math'],
    type: SkillType.prompt,
  ),
];

/// Match user input to a skill
class SkillMatcher {
  static Skill? match(String userInput) {
    final text = userInput.toLowerCase();
    Skill? bestMatch;
    int bestScore = 0;

    for (final skill in builtinSkills) {
      int score = 0;

      // Check keywords
      for (final kw in skill.keywords) {
        if (text.contains(kw.toLowerCase())) {
          score += 5;
        }
      }

      // Check label
      if (text.contains(skill.label.toLowerCase())) {
        score += 3;
      }

      if (score > bestScore && score >= 3) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }
}
