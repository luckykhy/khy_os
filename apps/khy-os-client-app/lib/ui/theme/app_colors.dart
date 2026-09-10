import 'package:flutter/material.dart';

/// khy-os 鑹插僵绯荤粺 鈥?涓?Web 鍓嶇 --khy-* token 瀵归綈
class AppColors {
  // 鈹€鈹€ Primary (khy-primary: #2f7ef7) 鈹€鈹€
  static const Color primary = Color(0xFF2F7EF7);
  static const Color primaryStrong = Color(0xFF1F68DF);
  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color primaryContainer = Color(0xFFEAF2FF);
  static const Color onPrimaryContainer = Color(0xFF0D2E6E);

  // 鈹€鈹€ Secondary (khy-accent: #6d5efc) 鈹€鈹€
  static const Color secondary = Color(0xFF6D5EFC);
  static const Color onSecondary = Color(0xFFFFFFFF);
  static const Color secondaryContainer = Color(0xFFEDE9FE);
  static const Color onSecondaryContainer = Color(0xFF2E1065);

  // 鈹€鈹€ Tertiary (khy-accent-end: #d946ef) 鈹€鈹€
  static const Color tertiary = Color(0xFFD946EF);
  static const Color onTertiary = Color(0xFFFFFFFF);
  static const Color tertiaryContainer = Color(0xFFF5D0FE);
  static const Color onTertiaryContainer = Color(0xFF4A0E5C);

  // 鈹€鈹€ Error 鈹€鈹€
  static const Color error = Color(0xFFD92D20);
  static const Color onError = Color(0xFFFFFFFF);
  static const Color errorContainer = Color(0xFFFEE4E2);
  static const Color onErrorContainer = Color(0xFF7A271A);

  // 鈹€鈹€ Success (khy-success: #079455) 鈹€鈹€
  static const Color success = Color(0xFF079455);
  static const Color onSuccess = Color(0xFFFFFFFF);

  // 鈹€鈹€ Warning (khy-warning: #dc6803) 鈹€鈹€
  static const Color warning = Color(0xFFDC6803);
  static const Color onWarning = Color(0xFFFFFFFF);

  // 鈹€鈹€ Surface Light (khy-bg-main: #f4f7fc) 鈹€鈹€
  static const Color surfaceLight = Color(0xFFF4F7FC);
  static const Color onSurfaceLight = Color(0xFF1F2937);
  static const Color surfaceVariantLight = Color(0xFFEFF4FF);
  static const Color onSurfaceVariantLight = Color(0xFF475467);
  static const Color outlineLight = Color(0xFFD6E0EF);
  static const Color outlineVariantLight = Color(0xFFE5EBF5);

  // 鈹€鈹€ Surface Dark (khy-bg-main dark: #161b26) 鈹€鈹€
  static const Color surfaceDark = Color(0xFF161B26);
  static const Color onSurfaceDark = Color(0xFFD4DBE8);
  static const Color surfaceVariantDark = Color(0xFF232C3D);
  static const Color onSurfaceVariantDark = Color(0xFF9AA7BD);
  static const Color outlineDark = Color(0xFF313C4F);
  static const Color outlineVariantDark = Color(0xFF2A3445);

  // 鈹€鈹€ Brand accents 鈹€鈹€
  static const Color accent = Color(0xFF6D5EFC);
  static const Color accentMid = Color(0xFF8B5CF6);
  static const Color cyan = Color(0xFFA5F3FC);
}

/// 鍦嗚瑙勮寖 鈥?khy-radius
class AppRadius {
  static const double small = 8;
  static const double medium = 12;
  static const double large = 16;
  static const double xLarge = 28;
}

/// 鍔ㄦ晥瑙勮寖
class AppDuration {
  static const Duration micro = Duration(milliseconds: 200);
  static const Duration pageTransition = Duration(milliseconds: 300);
  static const Duration overlay = Duration(milliseconds: 150);
  static const Duration progress = Duration(milliseconds: 500);
}

/// 闃村奖瑙勮寖 鈥?khy-shadow
class AppShadows {
  static List<BoxShadow> get card => [
        const BoxShadow(
          color: Color(0x140F172A),
          blurRadius: 28,
          offset: Offset(0, 10),
        ),
      ];

  static List<BoxShadow> get floating => [
        const BoxShadow(
          color: Color(0x1A0F172A),
          blurRadius: 36,
          offset: Offset(0, 14),
        ),
      ];

  static List<BoxShadow> get dialog => [
        const BoxShadow(
          color: Color(0x6B000000),
          blurRadius: 40,
          offset: Offset(0, 14),
        ),
      ];

  static List<BoxShadow> get primaryGlow => [
        BoxShadow(
          color: AppColors.primary.withValues(alpha: 0.32),
          blurRadius: 20,
          offset: const Offset(0, 8),
        ),
      ];
}
