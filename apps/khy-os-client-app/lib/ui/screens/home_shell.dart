import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// 应用 Shell - 包含底部导航栏
class HomeShell extends StatelessWidget {
  final Widget child;

  const HomeShell({super.key, required this.child});

  static int _indexFromLocation(String location) {
    if (location.startsWith('/chat')) return 0;
    if (location.startsWith('/agent')) return 1;
    if (location.startsWith('/skills')) return 2;
    if (location.startsWith('/independent')) return 3;
    if (location.startsWith('/settings')) return 4;
    return 0;
  }

  static const _destinations = [
    NavigationDestination(
      icon: Icon(Icons.chat_bubble_outline),
      selectedIcon: Icon(Icons.chat_bubble),
      label: '聊天',
    ),
    NavigationDestination(
      icon: Icon(Icons.smart_toy_outlined),
      selectedIcon: Icon(Icons.smart_toy),
      label: 'Agent',
    ),
    NavigationDestination(
      icon: Icon(Icons.extension_outlined),
      selectedIcon: Icon(Icons.extension),
      label: '技能',
    ),
    NavigationDestination(
      icon: Icon(Icons.cloud_off_outlined),
      selectedIcon: Icon(Icons.cloud_off),
      label: '独立',
    ),
    NavigationDestination(
      icon: Icon(Icons.settings_outlined),
      selectedIcon: Icon(Icons.settings),
      label: '设置',
    ),
  ];

  static const _routes = ['/chat', '/agent', '/skills', '/independent', '/settings'];

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).uri.toString();
    final currentIndex = _indexFromLocation(location);

    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: currentIndex,
        onDestinationSelected: (index) {
          context.go(_routes[index]);
        },
        destinations: _destinations,
      ),
    );
  }
}
