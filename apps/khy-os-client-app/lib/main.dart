import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'ui/theme/app_theme.dart';
import 'ui/screens/longcat_chat_screen.dart';
import 'core/gateway/khyos_api.dart';
import 'core/services/app_logger.dart';

final khyOsApiProvider = Provider<KhyOsApi>((ref) => KhyOsApi());

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppLogger().init();
  runApp(
    const ProviderScope(
      child: KhyOsApp(),
    ),
  );
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

/// 主页面 — 直接进入独立模式，可选连接远程
class KhyOsHome extends ConsumerStatefulWidget {
  const KhyOsHome({super.key});

  @override
  ConsumerState<KhyOsHome> createState() => _KhyOsHomeState();
}

class _KhyOsHomeState extends ConsumerState<KhyOsHome> {
  final _api = KhyOsApi();
  bool _isLoading = true;

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
                width: 60,
                height: 60,
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
                  child: Text(
                    'K',
                    style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w800,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const CircularProgressIndicator(),
            ],
          ),
        ),
      );
    }

    return KhyOsChatScreen(api: _api);
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }
}
