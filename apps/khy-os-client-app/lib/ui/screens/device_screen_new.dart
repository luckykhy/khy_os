import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/services/device_control.dart';
import '../../ui/theme/app_colors.dart';

/// Device control dashboard - capabilities + quick actions
class DeviceScreenNew extends StatefulWidget {
  const DeviceScreenNew({super.key});

  @override
  State<DeviceScreenNew> createState() => _DeviceScreenNewState();
}

class _DeviceScreenNewState extends State<DeviceScreenNew> {
  bool _a11yReady = false;
  bool _screenReady = false;
  String _deviceInfo = '';
  String _lastScreenshot = '';
  PermissionStatus _perms = const PermissionStatus(
      notifications: false, overlay: false, accessibility: false);

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  Future<void> _loadStatus() async {
    final a11y = await DeviceControl.isAccessibilityReady();
    final screen = await DeviceControl.isScreenCaptureReady();
    final perms = await DeviceControl.checkPermissions();
    final info = await DeviceControl.getDeviceInfo();
    if (mounted) {
      setState(() {
        _a11yReady = a11y;
        _screenReady = screen;
        _perms = perms;
        _deviceInfo = info.isNotEmpty
            ? '${info['brand']} ${info['model']}\n'
                'Android ${info['releaseVersion']} API ${info['sdkVersion']}'
            : '未知设备';
      });
    }
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
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                              AppColors.accent
                            ]),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(Icons.devices, size: 18, color: Colors.white),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('设备控制',
                              style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.bold)),
                          Text('无障碍 · 截屏 · Shell',
                              style: TextStyle(
                                  fontSize: 11,
                                  color: cs.onSurface
                                      .withValues(alpha: 0.5))),
                        ],
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.refresh, size: 20),
                      onPressed: _loadStatus,
                    ),
                  ],
                ),
              ),
            ),
            // Capability cards
            SliverPadding(
              padding: const EdgeInsets.all(16),
              sliver: SliverList(
                delegate: SliverChildListDelegate([
                  Text('功能状态',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface.withValues(alpha: 0.6))),
                  const SizedBox(height: 8),
                  _capCard(
                    context: context,
                    icon: Icons.accessibility_new,
                    title: '无障碍服务',
                    subtitle: _a11yReady ? '已启用，可模拟点击和滑动' : '未启用，需在系统设置中开启',
                    active: _a11yReady,
                    action: _a11yReady ? null : () => DeviceControl.openAccessibilitySettings(),
                    actionLabel: _a11yReady ? null : '去开启',
                  ),
                  const SizedBox(height: 8),
                  _capCard(
                    context: context,
                    icon: Icons.screenshot,
                    title: '屏幕捕获',
                    subtitle: _screenReady ? '运行中，可静默截屏' : '未运行，需授权后启动',
                    active: _screenReady,
                    action: _screenReady
                        ? () async {
                            await DeviceControl.stopScreenCapture();
                            _loadStatus();
                          }
                        : () async {
                            final ok = await DeviceControl.startScreenCapture();
                            if (ok) {
                              await Future.delayed(const Duration(seconds: 1));
                              _loadStatus();
                            }
                          },
                    actionLabel: _screenReady ? '停止' : '启动',
                  ),
                  const SizedBox(height: 8),
                  _capCard(
                    context: context,
                    icon: Icons.terminal,
                    title: 'Shell 命令',
                    subtitle: '白名单命令：am, pm, dumpsys, input...',
                     active: true,
                   ),
                   const SizedBox(height: 20),

                  // ── Permission Section ──
                  Text('权限状态',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface.withValues(alpha: 0.6))),
                  const SizedBox(height: 8),
                  _permRow(cs, '通知权限', _perms.notifications,
                      () => DeviceControl.requestNotifications()),
                  _permRow(cs, '悬浮窗权限', _perms.overlay,
                      () => DeviceControl.requestOverlay()),
                  _permRow(cs, '无障碍服务', _perms.accessibility,
                      () => DeviceControl.requestAccessibility()),

                  const SizedBox(height: 20),

                  // Quick actions
                  Text('快捷操作',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface.withValues(alpha: 0.6))),
                  const SizedBox(height: 8),

                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _quickAction(context, Icons.home, '主页', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome);
                      }),
                      _quickAction(context, Icons.arrow_back, '返回', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionBack);
                      }),
                      _quickAction(context, Icons.notifications, '通知', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionNotifications);
                      }),
                      _quickAction(context, Icons.recent_actors, '最近', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionRecents);
                      }),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _quickAction(context, Icons.screenshot, '截屏', () async {
                        final data = await DeviceControl.captureFrame();
                        if (data != null && mounted) {
                          setState(() => _lastScreenshot = data);
                          _showScreenshot(context, data);
                        }
                      }),
                      _quickAction(context, Icons.vibration, '振动', () {
                        DeviceControl.vibrate(duration: 300);
                      }),
                      _quickAction(context, Icons.view_in_ar, 'UI树', () async {
                        final dump = await DeviceControl.a11yDumpUi();
                        if (dump.isNotEmpty && mounted) {
                          _showDialog(context, 'UI 树', dump);
                        }
                      }),
                      _quickAction(context, Icons.list, '可点击', () async {
                        final items = await DeviceControl.a11yListClickable();
                        if (items.isNotEmpty && mounted) {
                          final text = items.take(20).map((e) =>
                              '${e['text']} @ (${e['x']},${e['y']})').join('\n');
                          _showDialog(context, '可点击元素', text);
                        }
                      }),
                    ],
                  ),

                  const SizedBox(height: 20),

                  // Device info
                  Text('设备信息',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface.withValues(alpha: 0.6))),
                  const SizedBox(height: 8),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: cs.surfaceVariant.withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                          color: cs.outlineVariant.withValues(alpha: 0.3)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final line in _deviceInfo.split('\n'))
                          Padding(
                            padding: const EdgeInsets.only(bottom: 2),
                            child: Text(line,
                                style: TextStyle(
                                    fontSize: 13,
                                    color: cs.onSurface.withValues(alpha: 0.7))),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _permRow(ColorScheme cs, String label, bool granted, VoidCallback onGrant) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Icon(
            granted ? Icons.check_circle : Icons.remove_circle_outline,
            size: 18,
            color: granted ? AppColors.success : Colors.grey,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(label,
                style: TextStyle(
                    fontSize: 13,
                    color:
                        granted ? cs.onSurface : cs.onSurface.withValues(alpha: 0.6))),
          ),
          if (!granted)
            GestureDetector(
              onTap: onGrant,
              child: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: cs.primaryContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text('去授权',
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onPrimaryContainer,
                        fontWeight: FontWeight.w500)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _capCard({
    required BuildContext context,
    required IconData icon,
    required String title,
    required String subtitle,
    required bool active,
    VoidCallback? action,
    String? actionLabel,
  }) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
            color: active
                ? AppColors.success.withValues(alpha: 0.3)
                : cs.outlineVariant.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: active
                  ? AppColors.success.withValues(alpha: 0.12)
                  : cs.surfaceVariant,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon,
                size: 20,
                color: active ? AppColors.success : Colors.grey),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 14,
                        color: cs.onSurface)),
                const SizedBox(height: 2),
                Text(subtitle,
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurface.withValues(alpha: 0.45))),
              ],
            ),
          ),
          if (action != null)
            GestureDetector(
              onTap: action,
              child: Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: cs.primary,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  actionLabel ?? '操作',
                  style: const TextStyle(
                      fontSize: 12,
                      color: Colors.white,
                      fontWeight: FontWeight.w500),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _quickAction(BuildContext context, IconData icon, String label, VoidCallback onTap) {
    final cs = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 72,
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: cs.surfaceVariant.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
        ),
        child: Column(
          children: [
            Icon(icon, size: 20, color: cs.primary),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: cs.onSurface.withValues(alpha: 0.7))),
          ],
        ),
      ),
    );
  }

  void _showScreenshot(BuildContext context, String dataUrl) {
    showDialog(
      context: context,
      builder: (ctx) {
        // Strip base64 prefix for display
        final base64 = dataUrl.split(',').last;
        return Dialog(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300, maxHeight: 500),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(height: 12),
                Text('截屏 (${base64.length} bytes)',
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                // Just show size info - actual image rendering would need
                // the base64 to be converted to a byte array
                Container(
                  width: 200,
                  height: 300,
                  color: const Color(0xFF1a1a2e),
                  child: const Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.screenshot, size: 40, color: Colors.white54),
                        SizedBox(height: 8),
                        Text('截图已捕获', style: TextStyle(color: Colors.white54, fontSize: 12)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('关闭'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showDialog(BuildContext context, String title, String content) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: SelectableText(
              content,
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: content));
              ScaffoldMessenger.of(context)
                  .showSnackBar(const SnackBar(content: Text('已复制')));
              Navigator.pop(ctx);
            },
            child: const Text('复制'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }
}
