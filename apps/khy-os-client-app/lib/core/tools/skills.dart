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
  // ---- Communication ----
  Skill(
    name: 'open-wechat',
    label: '打开微信',
    description: '打开微信应用',
    keywords: ['微信', 'wechat', 'weixin', '朋友圈', '扫码'],
    type: SkillType.delegation,
    appPackage: 'com.tencent.mm',
  ),
  Skill(
    name: 'open-qq',
    label: '打开QQ',
    description: '打开QQ应用',
    keywords: ['qq', '腾讯qq', '扣扣'],
    type: SkillType.delegation,
    appPackage: 'com.tencent.mobileqq',
  ),
  Skill(
    name: 'open-dingtalk',
    label: '打开钉钉',
    description: '打开钉钉办公应用',
    keywords: ['钉钉', 'dingtalk', '钉'],
    type: SkillType.delegation,
    appPackage: 'com.alibaba.android.rimet',
  ),
  Skill(
    name: 'open-feishu',
    label: '打开飞书',
    description: '打开飞书办公应用',
    keywords: ['飞书', 'feishu', 'lark'],
    type: SkillType.delegation,
    appPackage: 'com.ss.android.lark',
  ),
  Skill(
    name: 'open-telegram',
    label: '打开Telegram',
    description: '打开Telegram应用',
    keywords: ['telegram', '电报', 'tg'],
    type: SkillType.delegation,
    appPackage: 'org.telegram.messenger',
  ),
  Skill(
    name: 'open-whatsapp',
    label: '打开WhatsApp',
    description: '打开WhatsApp应用',
    keywords: ['whatsapp', 'wa'],
    type: SkillType.delegation,
    appPackage: 'com.whatsapp',
  ),

  // ---- Browser / Web ----
  Skill(
    name: 'open-browser',
    label: '打开浏览器',
    description: '打开系统默认浏览器',
    keywords: ['浏览器', '上网', '浏览', 'browser', 'chrome', '谷歌'],
    type: SkillType.delegation,
    appPackage: 'com.android.chrome',
    alternatePackages: ['com.UCMobile', 'org.mozilla.firefox', 'com.quark.browser'],
  ),
  Skill(
    name: 'open-baidu',
    label: '打开百度',
    description: '打开百度搜索',
    keywords: ['百度', 'baidu', '搜索一下'],
    type: SkillType.delegation,
    appPackage: 'com.baidu.searchbox',
  ),

  // ---- Media / Social ----
  Skill(
    name: 'open-douyin',
    label: '打开抖音',
    description: '打开抖音短视频',
    keywords: ['抖音', 'douyin', 'tiktok', '短视频'],
    type: SkillType.delegation,
    appPackage: 'com.ss.android.ugc.aweme',
  ),
  Skill(
    name: 'open-bilibili',
    label: '打开B站',
    description: '打开哔哩哔哩',
    keywords: ['b站', 'bilibili', '哔哩哔哩', 'bili'],
    type: SkillType.delegation,
    appPackage: 'tv.danmaku.bili',
    alternatePackages: ['com.bilibili.app.in'],
  ),
  Skill(
    name: 'open-weibo',
    label: '打开微博',
    description: '打开新浪微博',
    keywords: ['微博', 'weibo', '新浪微博'],
    type: SkillType.delegation,
    appPackage: 'com.sina.weibo',
  ),
  Skill(
    name: 'open-xiaohongshu',
    label: '打开小红书',
    description: '打开小红书',
    keywords: ['小红书', 'xiaohongshu', 'red'],
    type: SkillType.delegation,
    appPackage: 'com.xingin.xhs',
  ),
  Skill(
    name: 'open-zhihu',
    label: '打开知乎',
    description: '打开知乎',
    keywords: ['知乎', 'zhihu'],
    type: SkillType.delegation,
    appPackage: 'com.zhihu.android',
  ),

  // ---- Shopping ----
  Skill(
    name: 'open-taobao',
    label: '打开淘宝',
    description: '打开淘宝购物',
    keywords: ['淘宝', 'taobao', '天猫', 'tmall'],
    type: SkillType.delegation,
    appPackage: 'com.taobao.taobao',
  ),
  Skill(
    name: 'open-jd',
    label: '打开京东',
    description: '打开京东购物',
    keywords: ['京东', 'jd', 'jd.com'],
    type: SkillType.delegation,
    appPackage: 'com.jingdong.app.mall',
  ),
  Skill(
    name: 'open-pinduoduo',
    label: '打开拼多多',
    description: '打开拼多多购物',
    keywords: ['拼多多', 'pinduoduo', 'pdd'],
    type: SkillType.delegation,
    appPackage: 'com.xunmeng.pinduoduo',
  ),
  Skill(
    name: 'open-meituan',
    label: '打开美团',
    description: '打开美团外卖',
    keywords: ['美团', 'meituan', '外卖', '饿了么'],
    type: SkillType.delegation,
    appPackage: 'com.sankuai.meituan',
  ),

  // ---- System ----
  Skill(
    name: 'open-settings',
    label: '打开设置',
    description: '打开系统设置',
    keywords: ['设置', 'settings', '系统设置', '偏好'],
    type: SkillType.delegation,
    appPackage: 'com.android.settings',
  ),
  Skill(
    name: 'open-camera',
    label: '打开相机',
    description: '打开系统相机',
    keywords: ['相机', '拍照', 'camera', '照相'],
    type: SkillType.delegation,
    appPackage: 'com.android.camera',
    alternatePackages: ['com.android.camera2'],
  ),
  Skill(
    name: 'open-gallery',
    label: '打开相册',
    description: '打开系统相册',
    keywords: ['相册', '图库', '照片', 'gallery', 'photos'],
    type: SkillType.delegation,
    appPackage: 'com.android.gallery3d',
    alternatePackages: ['com.google.android.apps.photos'],
  ),
  Skill(
    name: 'open-phone',
    label: '打开电话',
    description: '打开拨号盘',
    keywords: ['电话', '拨号', '打电话', 'phone', 'dialer'],
    type: SkillType.delegation,
    appPackage: 'com.android.dialer',
    alternatePackages: ['com.google.android.dialer'],
  ),
  Skill(
    name: 'open-music',
    label: '打开音乐',
    description: '打开音乐应用',
    keywords: ['音乐', 'music', '听歌', '网易云', '酷狗'],
    type: SkillType.delegation,
    appPackage: 'com.netease.cloudmusic',
    alternatePackages: ['com.kugou.android'],
  ),
  Skill(
    name: 'open-maps',
    label: '打开地图',
    description: '打开高德地图',
    keywords: ['地图', '导航', '高德', 'amap', 'maps', '路线'],
    type: SkillType.delegation,
    appPackage: 'com.autonavi.minimap',
  ),
  Skill(
    name: 'open-weather',
    label: '打开天气',
    description: '查看天气',
    keywords: ['天气', 'weather', '气温', '下雨'],
    type: SkillType.delegation,
    appPackage: 'com.miui.weather2',
    alternatePackages: ['cn.wildroid.weather'],
  ),

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
