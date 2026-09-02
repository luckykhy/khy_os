# Release 输出目录

这里放构建产物，**不入 git**（见同目录 `.gitignore`）。

```
apps/khy-mobile/release/
├── khy-mobile-debug.apk     # 调试包，未混淆，35.9MB
└── khy-mobile-release.apk   # 发布包，R8 + 资源压缩，24.7MB
```

## 重新出包

```bash
# 1. 装依赖（首次或 lockfile 变了）
cd apps/khy-mobile
pn install

# 2. 同步 web 资产到 android 工程
pn cap sync android

# 3a. 出 debug 包（未混淆，方便排错）
cd android
build-debug.bat                # → app/build/outputs/apk/debug/app-debug.apk

# 3b. 出 release 包（R8 + 资源压缩，体积瘦 31%）
build-release.bat              # → app/build/outputs/apk/release/app-release.apk
```

构建脚本从仓库根的 `apps/khy-mobile/android/build-{debug,release}.bat` 调起，
里面设了 `JAVA_HOME=D:\Portable\Tools\jdk-21.0.12.1+1`（cap-barcode-scanner 强制 Java 21）
和 `ANDROID_HOME=C:\Users\25789\.khyos\android_sdk`。

## 签名

debug 用 Android 调试 keystore（自动）。release fallback 到 `~/.khyos/keystore/release.jks`
（密码 `khyos-dev-pwd-2026`），真发布前换生产 keystore：

```bash
export KHY_RELEASE_STORE_FILE=/path/to/prod.jks
export KHY_RELEASE_KEY_ALIAS=prod
export KHY_RELEASE_STORE_PASSWORD=...
export KHY_RELEASE_KEY_PASSWORD=...
```

详见 `apps/khy-mobile/android/app/build.gradle:23-35`。
