import 'package:flutter/material.dart';
import '../../core/tools/skills.dart';
import '../../core/tools/builtin_tools.dart';
import '../../core/tools/tool_engine.dart';
import '../../ui/theme/app_colors.dart';

/// Skills grid view
class SkillsScreenNew extends StatefulWidget {
  const SkillsScreenNew({super.key});

  @override
  State<SkillsScreenNew> createState() => _SkillsScreenNewState();
}

class _SkillsScreenNewState extends State<SkillsScreenNew> {
  late final ToolEngine _engine;

  @override
  void initState() {
    super.initState();
    _engine = ToolEngine();
    _engine.registerAll(createBuiltinTools());
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            // Header
            SliverToBoxAdapter(
              child: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: cs.surface,
                  boxShadow: [
                    BoxShadow(
                        color: Colors.black.withValues(alpha: 0.04),
                        blurRadius: 4,
                        offset: const Offset(0, 2)),
                  ],
                ),
                child: Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                            colors: [
                              AppColors.primary,
                              AppColors.tertiary
                            ]),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(Icons.bolt, size: 18, color: Colors.white),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('技能',
                              style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.bold)),
                          Text('${builtinSkills.length} 个可用技能',
                              style: TextStyle(
                                  fontSize: 11,
                                  color: cs.onSurface
                                      .withValues(alpha: 0.5))),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            // Grid of skills
            SliverPadding(
              padding: const EdgeInsets.all(12),
              sliver: SliverGrid(
                gridDelegate:
                    const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 2,
                        crossAxisSpacing: 10,
                        mainAxisSpacing: 10,
                        childAspectRatio: 1.2),
                delegate: SliverChildBuilderDelegate(
                  (_, i) {
                    final skill = builtinSkills[i];
                    return _skillCard(skill, cs, _executeSkill);
                  },
                  childCount: builtinSkills.length,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _skillCard(Skill skill, ColorScheme cs,
      void Function(Skill) onExecute) {
    final IconData icon = _iconForSkill(skill);
    final Color color = _colorForSkill(skill);

    return GestureDetector(
      onTap: () => onExecute(skill),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: cs.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            // Icon + name
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(icon, size: 20, color: color),
                ),
                const SizedBox(height: 8),
                Text(
                  skill.label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
            // Description
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                skill.description,
                style: TextStyle(
                  fontSize: 11,
                  color: cs.onSurface.withValues(alpha: 0.45),
                  height: 1.3,
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _executeSkill(Skill skill) {
    SkillExecutor.execute(skill).then((result) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            result.success ? result.message : '失败：${result.message}',
            style: const TextStyle(fontSize: 13),
          ),
          backgroundColor: result.success ? AppColors.success : AppColors.error,
          duration: const Duration(seconds: 2),
        ),
      );
    });
  }

  IconData _iconForSkill(Skill s) {
    if (s.name.contains('wechat') || s.name.contains('weixin')) {
      return Icons.chat;
    }
    if (s.name.contains('browser') || s.name.contains('baidu')) {
      return Icons.language;
    }
    if (s.name.contains('douyin') || s.name.contains('bilibili')) {
      return Icons.videocam;
    }
    if (s.name.contains('taobao') || s.name.contains('jd') || s.name.contains('pinduoduo')) {
      return Icons.shopping_cart;
    }
    if (s.name.contains('meituan')) {
      return Icons.restaurant;
    }
    if (s.name.contains('camera')) {
      return Icons.photo_camera;
    }
    if (s.name.contains('gallery') || s.name.contains('photos')) {
      return Icons.photo_library;
    }
    if (s.name.contains('phone') || s.name.contains('dialer')) {
      return Icons.phone;
    }
    if (s.name.contains('music')) {
      return Icons.music_note;
    }
    if (s.name.contains('maps') || s.name.contains('amap')) {
      return Icons.map;
    }
    if (s.name.contains('weather')) {
      return Icons.wb_sunny;
    }
    if (s.name.contains('settings')) {
      return Icons.settings;
    }
    if (s.name.contains('calculate') || s.name.contains('math')) {
      return Icons.calculate;
    }
    if (s.name.contains('screenshot') || s.name.contains('copy')) {
      return Icons.content_copy;
    }
    if (s.name.contains('home') || s.name.contains('back')) {
      return Icons.navigation;
    }
    if (s.name.contains('qq')) {
      return Icons.qr_code;
    }
    if (s.name.contains('dingtalk') || s.name.contains('feishu')) {
      return Icons.work;
    }
    if (s.name.contains('telegram') || s.name.contains('whatsapp')) {
      return Icons.message;
    }
    if (s.name.contains('weibo') || s.name.contains('xiaohongshu') || s.name.contains('zhihu')) {
      return Icons.public;
    }
    return Icons.star;
  }

  Color _colorForSkill(Skill s) {
    switch (s.name) {
      case 'open-wechat':
        return const Color(0xFF07C160);
      case 'open-browser':
      case 'open-baidu':
        return AppColors.primary;
      case 'open-douyin':
        return const Color(0xFFFE2C56);
      case 'open-bilibili':
        return const Color(0xFFFB7299);
      case 'open-taobao':
        case 'open-jd':
        case 'open-pinduoduo':
        case 'open-meituan':
        return AppColors.warning;
      case 'open-camera':
        return const Color(0xFF4FC3F7);
      case 'open-maps':
        return const Color(0xFF4285F4);
      case 'open-settings':
        return Colors.grey;
      default:
        return AppColors.accent;
    }
  }
}
