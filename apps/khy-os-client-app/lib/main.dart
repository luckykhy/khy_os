import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'ui/theme/app_theme.dart';
import 'ui/screens/chat_screen_new.dart';
import 'ui/screens/agent_screen_new.dart';
import 'ui/screens/skills_screen_new.dart';
import 'ui/screens/device_screen_new.dart';
import 'ui/screens/settings_screen_new.dart';
import 'core/gateway/khyos_api.dart';
import 'core/services/app_logger.dart';

final khyOsApiProvider = Provider<KhyOsApi>((ref) => KhyOsApi());

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppLogger().init();
  runApp(const ProviderScope(child: KhyOsApp()));
}

class KhyOsApp extends ConsumerWidget {
  const KhyOsApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'khy-os',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      home: const KhyOsHome(),
    );
  }
}

/// Main home screen with bottom navigation
class KhyOsHome extends ConsumerStatefulWidget {
  const KhyOsHome({super.key});

  @override
  ConsumerState<KhyOsHome> createState() => _KhyOsHomeState();
}

class _KhyOsHomeState extends ConsumerState<KhyOsHome> {
  int _tabIndex = 0;
  final KhyOsApi _api = KhyOsApi();
  bool _isLoading = true;

  static const _tabTitles = ['聊天', 'Agent', '技能', '设备', '设置'];
  static const _tabIcons = [
    Icons.chat_bubble_outline,
    Icons.smart_toy_outlined,
    Icons.bolt_outlined,
    Icons.devices_outlined,
    Icons.settings_outlined,
  ];
  static const _tabSelectedIcons = [
    Icons.chat_bubble,
    Icons.smart_toy,
    Icons.bolt,
    Icons.devices,
    Icons.settings,
  ];

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await _api.loadConnection();
    setState(() => _isLoading = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      Theme.of(context).colorScheme.primary,
                      Theme.of(context).colorScheme.tertiary,
                    ],
                  ),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: const Center(
                  child: Text('K', style: TextStyle(
                    fontSize: 32,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                  )),
                ),
              ),
              const SizedBox(height: 24),
              const CircularProgressIndicator(),
            ],
          ),
        ),
      );
    }

    final screens = [
      ChatScreenNew(api: _api),
      AgentScreenNew(api: _api),
      SkillsScreenNew(),
      DeviceScreenNew(),
      SettingsScreenNew(),
    ];

    return Scaffold(
      body: IndexedStack(
        index: _tabIndex,
        children: screens,
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (i) => setState(() => _tabIndex = i),
        destinations: [
          for (var i = 0; i < 5; i++)
            NavigationDestination(
              icon: Icon(_tabIcons[i]),
              selectedIcon: Icon(_tabSelectedIcons[i]),
              label: _tabTitles[i],
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }
}
