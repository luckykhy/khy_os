import 'package:go_router/go_router.dart';
import '../ui/screens/chat_screen.dart';
import '../ui/screens/agent_screen.dart';
import '../ui/screens/skills_screen.dart';
import '../ui/screens/settings_screen.dart';
import '../ui/screens/independent_screen.dart';
import '../ui/screens/home_shell.dart';

/// 应用路由
class AppRouter {
  static final router = GoRouter(
    initialLocation: '/chat',
    routes: [
      ShellRoute(
        builder: (context, state, child) => HomeShell(child: child),
        routes: [
          GoRoute(
            path: '/chat',
            name: 'chat',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: ChatScreen(),
            ),
          ),
          GoRoute(
            path: '/agent',
            name: 'agent',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: AgentScreen(),
            ),
          ),
          GoRoute(
            path: '/skills',
            name: 'skills',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: SkillsScreen(),
            ),
          ),
          GoRoute(
            path: '/independent',
            name: 'independent',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: IndependentScreen(),
            ),
          ),
          GoRoute(
            path: '/settings',
            name: 'settings',
            pageBuilder: (context, state) => const NoTransitionPage(
              child: SettingsScreen(),
            ),
          ),
        ],
      ),
    ],
  );
}
