# [DEPLOY-MAN-018] khyos Android 构建避坑指南

> 目标：pip 装好 khyos 后，在 **Windows / Linux** 上一条命令出 Android APK，
> 除自行装 JDK 外**零手动配置**。本指南给出正确的技术路线、用法、以及踩坑对照表。

---

## 0. 一分钟上手

```bash
pip install khy-os            # 已包含 requests（下载器）与 Node 后端
# 自行安装 JDK 17（唯一需手动的前置，见 §3）
khy build android             # 调试包：自动下 SDK → vite build → cap sync → gradlew
khy build android --release   # 签名发布包
khy build android -o dist/apk # 指定输出目录
```

产物默认落到 `./dist/android/app-debug.apk`（或 `--output` 指定目录）。

---

## 1. 选型纠偏：为什么是 Capacitor，不是 BeeWare/Briefcase

很多人（包括初版需求）会想当然地用 **BeeWare/Briefcase** 把「Python 应用」打成 APK。
**对 khyos 这是错的**，会产出一个跑不起来的废包。原因是 khyos 的真实架构：

| 层 | 实际技术 | 能否进 BeeWare 的 APK |
|---|---|---|
| 核心后端 | **Node.js**（Express AI 网关） | ❌ Briefcase 只打包纯 Python |
| 用户界面 | **Vue3 + Vite** Web 前端 | ❌ 非 Python，Briefcase 不识别 |
| pip 包 `khy_platform` | 薄启动器（仅 `requests`+`cffi`） | 不是 App 主体，只是 launcher |

结论：khyos 的核心**不是纯 Python**，Briefcase 无从下手。正确的桥接是
**Capacitor**——用原生 WebView 装载已构建的 Vue 前端，前端通过网络（本地/局域网/云端）
连接后端网关。项目里 `software/khyquant/frontend/android` **本就是一个完整的
Capacitor Android 工程**（含 `gradlew`、release keystore、`variables.gradle`）。
`khy build android` 做的就是把它的构建流程**自动化、跨平台化、零配置化**。

### 1.1 推论：没有「Python C 扩展交叉编译」这回事
因为 APK 里**不运行 Python**（运行的是 WebView + JS），所以**不存在**需要为
ARM64/ARMv7 交叉编译的 Python C 扩展，**NDK 默认不安装**（`pyproject` 的
`[tool.khyos.android] ndk = ""`）。只有将来引入需 NDK 的原生 Capacitor 插件时，
才在版本锁里填 NDK 版本。

---

## 2. 命令做了什么（确定性串行步骤）

`khy build android` 在 `khy_platform/android_build.py` 里按序执行：

1. **定位** Capacitor 前端工程（源码树或 bundled 安装均可）。
2. **JDK 预检**：`java` 不在 PATH → 抛 `[Action Required]` 指引（见 §3），不跑 gradle。
3. **Windows 长路径**：尽力开启系统长路径开关；拿不到管理员权限就降级——
   因为 SDK 缓存根是很短的 `~/.khyos/android_sdk`，本身已规避 260 字符限制。
4. **SDK 自管理**：`~/.khyos/android_sdk` 缺 `sdkmanager` 时，按 `pyproject` 版本锁
   下载 commandlinetools（**断点续传 + 多镜像轮换 + 重试**），解压成规范布局，
   接受许可，安装 `platform-tools`、`platforms;android-36`、`build-tools;35.0.0`。
5. **改写 `local.properties`**：把 `sdk.dir` 指向托管 SDK，**覆盖仓库里残留的
   旧机器绝对路径**——这是「零手动配置」的关键一步。
6. **前端构建**：`npm install`（按需）→ `vite build` → `npx cap sync android`。
7. **Gradle 出包**：`./gradlew assembleDebug`（或 `assembleRelease`）`--no-daemon`。
8. **拷贝 APK** 到输出目录。

所有路径用 `pathlib.Path`，无硬编码分隔符；Linux 自动给 `gradlew` 加可执行位。

### 2.1 版本锁单一真源
`pyproject.toml` 的 `[tool.khyos.android]` 是 SDK/构建工具版本的唯一真源，
与 `frontend/android/variables.gradle` 的 `compileSdk=36` 对齐。任意项可用环境变量
`KHY_ANDROID_<KEY>` 覆盖（如 `KHY_ANDROID_BUILD_TOOLS=34.0.0`），便于 CI 与离线测试。

---

## 3. 唯一需手动：安装 JDK 17

Android/Gradle 构建硬性依赖 JDK，khyos **不会**替你装系统级 JDK。缺失时命令会打印：

```
[Action Required] 未检测到 Java JDK —— Android 构建的硬性前置依赖
  - Windows：winget install Microsoft.OpenJDK.17  （或 https://adoptium.net 下载 Temurin 17）
  - Linux  ：sudo apt install openjdk-17-jdk
  - 装好后重开终端，确认 `java -version` 可用，再重跑 `khy build android`。
```

装好后无需配 `JAVA_HOME`——编排器会从 `java` 路径反推。

---

## 4. 跨平台 / 国内网络踩坑对照表

| 症状 | 原因 | 处理 |
|---|---|---|
| `[Action Required] 未检测到 Java JDK` | PATH 无 `java` | 按 §3 装 JDK 17，重开终端 |
| SDK 下载卡死 / 超时（国内） | 直连 dl.google.com 不稳 | 已内置镜像轮换+重试+断点续传；仍失败则设 `HTTPS_PROXY` 后重跑 |
| 下载中断后重跑很慢 | — | 无需担心：已下载部分会**断点续传**，不会从头来 |
| Windows 报路径超长 / 解压失败 | 260 字符限制 | 已用短缓存根 `~/.khyos/android_sdk` 规避；管理员身份跑一次可永久开启系统长路径 |
| Linux `gradlew: Permission denied` | 缺可执行位 | 编排器已自动 `chmod +x`；若手动跑请 `chmod +x gradlew` |
| `local.properties` 指向别的机器 | 仓库残留旧绝对路径 | 编排器每次构建都会**重写**它，无需手改 |
| Gradle 退码失败、看不懂 | 默认隐藏底层堆栈 | 加 `--verbose` 重跑看完整日志；常见是 JDK 版本不符（需 17）或磁盘不足 |
| 没装 Node/npm | 前端构建缺工具 | khyos 自带 Node；若确实缺，装 Node 18+，或先手动 `npm run build` 后用 `--skip-web` |

---

## 5. 防呆红线（实现纪律）

- **绝不**把 SDK/NDK（数 GB）打进 pip 包；一律按需下载到用户缓存目录。
- 构建失败抛**人类可读** `[Action Required]`，不直接甩 gradle/npm 堆栈（`--verbose` 才透传）。
- 工具链下载**断点续传 + 重试 + 镜像轮换**，扛国内网络抖动。
- **只新增**移动端构建逻辑：`android_build.py` + `cli.py` 一个窄分支 +
  `pyproject` 一张版本锁表。**零触动**桌面/内核的 `os build` / `iso build` 路由与行为。
- 命令归一器**只**匹配明确的 `android` 子命令，绝不遮蔽 `os build`（内核）/`iso build`。

---

## 6. 参数速查

| 参数 | 作用 |
|---|---|
| `--release` / `-r` | 构建签名发布包（`assembleRelease`） |
| `--debug` | 构建调试包（默认） |
| `--output DIR` / `-o DIR` | APK 输出目录（默认 `./dist/android`） |
| `--skip-web` | 跳过前端构建，直接用已有 `dist/` |
| `--skip-sdk` | 跳过 SDK 自管理（已自备 SDK 时加速） |
| `--verbose` / `-v` | 透传底层工具完整输出与堆栈 |

---

## 7. 相关文件

- 编排器：`platform/khy_platform/android_build.py`
- CLI 接入：`platform/khy_platform/cli.py`（`_normalize_android_build_command` + `main()` 分支）
- 版本锁：`pyproject.toml` → `[tool.khyos.android]`
- Capacitor 工程：`software/khyquant/frontend/android/`
- 离线单测：`tests/unit/test_android_build.py`
