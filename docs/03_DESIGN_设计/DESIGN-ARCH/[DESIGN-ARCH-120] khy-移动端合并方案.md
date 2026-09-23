# [DESIGN-ARCH-120] khy 移动端合并方案

> **定位**：回答一个问题——**「`apps/khy-mobile` 和 `apps/khy-os-client-app` 要不要合并、怎么合、合到哪一步算完？」**
> 本文件是该问题的方案真源；它**不新增规则**，因此不携带 `<!-- RULES-REGISTRY -->` 标记。
> 它收口的是 `[DESIGN-ARCH-117]` 遗留的**一条未收口项**（幽灵端 `apps/khy-mobile`）。
>
> **与 `[DESIGN-ARCH-117]` 的分工**：ARCH-117 登记「有哪些端、声明状态如何」；
> 本文件决定「`mobile` 与 `mobile-legacy` 这两个端之间怎么并、谁是幸存者、死的那一半怎么清理」。
> 改端矩阵仍回 ARCH-117 与仓库根 `entries/entries.json`；改合并动作先改本文件。
>
> **依据**：产物落盘与「只隔离不删除」依据 `[DESIGN-LAY-003]`（`LAYOUT-004`）；
> 构建产物坐标依据 `[DESIGN-LAY-004]`（`LAYOUT-005`）；端点禁止字面量依据工程规则 1
> （`RUNTIME-001`）；面向用户文案依据工程规则 2（`RUNTIME-002` 及其 2.2 子规则）；
> 层级落点依据 `[DESIGN-LAY-005]`。

---

## 一、结论先行：这不是源码合并，是能力收编

用户提出的诉求是「把两个 app 合并在一起」。实测之后这个诉求需要修正——**两者之间没有可合并的源码**：

| 项目 | `apps/khy-mobile` | `apps/khy-os-client-app` |
|---|---|---|
| 形态 | Capacitor 壳（Vue/Vite `@khy-os/mobile-companion`） | Flutter 原生 App（`sdk: ^3.13.2`） |
| git 跟踪文件数 | **0** | 完整工程 |
| 源码 | **已丢失**（仅剩 `dist/` 编译产物） | 在库 |
| `dist/` 内容 | `software/khyquant/frontend` 的**编译副本**，不是 companion 自己的代码 | 不适用 |
| `entries.json` 声明 | `mobile-legacy`，`declaredStatus: broken`，标记命中 **0/4** | `mobile`，`declaredStatus: ready` |
| 构建入口 | `platform/khy_platform/android_build.py`（Capacitor 管线，找不到工程） | `npm run android:release` → `scripts/release/build-android.ps1`（可产出签名 APK+AAB） |

`[DESIGN-ARCH-117]` §七.1 已经给出裁决方向：**改指 `apps/khy-os-client-app`，或补齐工程**。
本方案取前者，因为补齐一条 0 源码的 Capacitor 管线等价于重写一个已经被 Flutter 端替代的应用，
且会重新引入「两套移动壳」的维护成本。

**合并的正确形式是收编，分三步**：

1. **契约收编**——把 `apps/khy-mobile` 唯一还有效的能力价值（扫码配对）搬到幸存者身上；
2. **引用收口**——把仓库里所有「mobile = 那条 Capacitor 壳」的假设改指幸存者；
3. **目录隔离**——`apps/khy-mobile` 物理移除（本方案**不执行**，见 §七）。

---

## 二、能力对等矩阵（唯一决策依据）

收编不是「把壳换个壳」，而是要逐条确认幸存者是否真的覆盖了旧壳的能力。
下表以旧壳的 `capacitor.plugins.json` 逐条对照：

| 旧壳能力（Capacitor 插件） | Flutter 端现状 | 差距 |
|---|---|---|
| `@capacitor/app`（应用信息/生命周期） | `main.dart` 五页 `IndexedStack` + RiverPod 生命周期管理 | 无 |
| `@capacitor/barcode-scanner`（**扫码**） | **缺失** | **唯一真实差距** → 本次补齐（`mobile_scanner`） |
| `@capacitor/filesystem` | `path_provider` + drift | 无 |
| `@capacitor/network` | `network_diagnostic_screen.dart` / `network_autofix` | 无 |
| `@capacitor/preferences` | `flutter_secure_storage` + drift | 无 |
| `@capacitor/secure-storage` | `flutter_secure_storage`（同类） | 无 |
| Web 渲染（Vue companion UI） | 原生页面，`trading_panel_screen.dart` 已写明「无需再装 Capacitor 壳」 | 无 |

结论：除扫码外，幸存者已全覆盖。扫码是唯一必须搬的活，因此**本次实现范围收敛为扫码 + 配对契约**。

---

## 三、阶段一：契约收编（已完成）

### 3.1 配对契约：两侧必须逐字节对齐

`khy mobile app` 打印的二维码编码的**不是 URL**，而是一个 JSON 信封：

```
buildPairingPayload(lanIp, port)  →  { payload: JSON.stringify({ apiBaseUrl }), apiBaseUrl }
```

刻意用 JSON 而非裸 URL 的原因写在 `handlers/mobile.js` 头注里：裸 URL 会被手机系统相机抢走
直接打开浏览器标签，而不会被交给 App。

**终端里有两种二维码，不可混用**：

| 命令 | 载荷 | 受众 |
|---|---|---|
| `khy mobile` | `http://<lan-ip>:<mgmt-port>/admin/ai-gateway` | 浏览器标签 |
| `khy mobile app` | `{"apiBaseUrl":"http://<lan-ip>:<api-port>"}` | 本 App |

扫错时 App 会把管理页路径当成 API 根地址，**所有请求 404**。这个约定此前只写在注释里，
App 侧没有任何执行，错扫会以一条不透明的 dio 网络错误暴露。

### 3.2 已修复的真实缺陷

旧 `connection_screen.dart` 的解析：

```dart
String apiUrl = payload;
if (payload.startsWith('{')) {
  final data = Map<String, dynamic>.from(Uri.splitQueryString(payload).map(...));
  apiUrl = data['url'] ?? data['apiUrl'] ?? data['apiBaseUrl'] ?? payload;
}
```

`Uri.splitQueryString` 按 `&` 与 `=` 切分，而 `{"apiBaseUrl":"http://192.168.1.9:3000"}`
里根本没有 `&` 或 `=`——整串被当成单个 key，`apiUrl` 永远是 `null`，最终把**原始 JSON 串**
当地址传给 `verifyAndSave`。**每一次配对尝试都必然失败**，且失败信息是 malformed-URL 级别的不透明错误。

### 3.3 落地件

| 文件 | 作用 |
|---|---|
| `apps/khy-os-client-app/lib/core/gateway/pairing.dart` | 纯 Dart（仅 `dart:convert`）消费端：`PairingPayloadParser` + `PairingParseException` + `PairingPayload` |
| `apps/khy-os-client-app/lib/ui/screens/qr_scan_screen.dart` | 全屏扫码页，`Navigator.pop<String>` 回传原始文本 |
| `apps/khy-os-client-app/lib/ui/screens/connection_screen.dart` | 接入解析器；新增 `Scan QR` 按钮与 `_scanQr()` |
| `apps/khy-os-client-app/pubspec.yaml` | `mobile_scanner: 7.4.2`（精确锁定） |
| `apps/khy-os-client-app/test/pairing_test.dart` | 27 条消费端单测 |
| `services/backend/tests/cli/handlers/mobilePairingContract.test.js` | 11 条**跨语言契约**测试 |

### 3.4 解析器必须守住的不变量

`PairingPayloadParser.parse` 的验收标准不是「能解析就过」，而是下面四条：

1. **信封优先**：`{` 开头必走 JSON 路径，绝不喂给 URL 解析器（§3.2 的缺陷）。
2. **降级可用**：裸 `http(s)://host:port`、裸 `host:port` 都接受——用户会手工粘贴，
   粘贴时只有地址、没有信封。
3. **拒绝要 actionable**：任何失败都必须给出「问题 + 原因 + 修复建议」
   （`RUNTIME-002` 2.2），并指明该跑哪条命令重新生成。
4. **不崩溃**：`Uri.port` 对非数字端口抛 `ArgumentError`，会让整个配对页崩掉而非报错。
   解析器用 `_rawPort` 先读原始端口文本再判定，把崩溃降级成一条消息。

第 4 条是测试逼出来的：契约测试移植了 Dart 侧逻辑，第一次跑就发现 JS 侧漏了端口范围检查
（`70000` 被放行），说明**这一类漂移是常态而非例外**——这正是 §3.5 存在的理由。

### 3.5 为什么契约测试放在 Node 侧而不是 Dart 侧

Dart 与 Node 从不在同一进程里运行，所以「信封形状对不对」这件事没有任何运行时能发现。
`mobilePairingContract.test.js` 的做法是**在 JS 里逐行移植 Dart 解析管线**（`parseLikeDart`），
然后断言真实发射器 `buildPairingPayload` 仍然满足它。

代价是这份移植会漂移（§3.4 第 4 条已实证一次）。可接受的取舍：
漂移的方向是**测试失败**，而不是静默放坏一个线上契约；
且文件头注已写明「改 `buildPairingPayload` 就要同时改 `parseLikeDart` 和 Dart 解析器」。

---

## 四、阶段二：引用收口（已完成）

仓库里有三处「mobile 等于那条 Capacitor 壳」的假设，全部改指幸存者。

### 4.1 `crossLauncher.js`：不再假称一个不存在的端口

改前：

```js
mobile: {
  cmd: 'cmd.exe',
  args: ['/c', 'cd', '/d', '...apps/khy-mobile', '&&', 'npm', 'run', 'dev'],
  description: `Mobile dev server (port ${MOBILE_FRONTEND_PORT})`,
},
```

两个问题：`apps/khy-mobile` 无源码，`npm run dev` 必然失败；`description` 与
`getPlatformStatus().mobile` 声称 mobile 监听 `MOBILE_FRONTEND_PORT`（5173），
而 Flutter 端是**原生进程，没有 dev server 端口**。后者更危险——它会让 `khy cross status`
报告一个永远不会有进程监听的端口，或误报端口被占用。

改后：`cmd` 指向 `apps/khy-os-client-app` 的 `flutter run`，描述改为
`Mobile app (Flutter — apps/khy-os-client-app, needs a connected device)`；
`getPlatformStatus().mobile` 改成 `desktop` 同款的 `{ running: false, note }` 形态，
note 指向 `flutter devices` 与 `npm run android:release`。

### 4.2 `crossPlatform.js`：`khy cross stop mobile` 不再杀错进程

`_handleStop` 的 `portMap` 原本含 `mobile: MOBILE_FRONTEND_PORT`，
于是 `khy cross stop mobile` 会去 `netstat` 找 5173 上的进程并 `taskkill /F`——
杀掉的是一个与手机端无关的、恰好占着 5173 的任意进程。
现改为：`mobile` 从端口映射中移除，单独给出「原生进程不按端口停止」的指引。

### 4.3 `serviceDefaults.js`：`MOBILE_FRONTEND_PORT` 降级为遗留常量

不再有任何消费者读它（`crossLauncher.js` 已不再 import）。
保留而非删除，因为它是 `KHY_MOBILE_PORT` env 的单一真源，将来若真的重建 Capacitor 壳
有一个明确的位置可读；同时在注释里写明**不得**把它接回「mobile」状态检查。

### 4.4 `android_build.py`：删除幽灵默认候选

`_project_candidates()` 原本把 `<仓库根>/apps/khy-mobile` 列为第一优先候选。
因为该目录**存在**且带 `capacitor.config.json`，`_is_capacitor_project()` 会判它合格，
于是 `khy build android` 会**静默构建一个空壳**并产出一个无法使用的 APK。

改后：删除两条仓库相对候选（`apps/khy-mobile` 与 `cwd/apps/khy-mobile`），
保留 `KHY_ANDROID_PROJECT` 覆盖与 wheel `bundled/` 布局（后者是发布载荷路径，不是仓库幽灵）。
失败提示改为指向 `npm run android:release`，并明确写出
「`apps/khy-mobile` 已无源码检出（0 个 git 跟踪文件），不是可用工程」。

该模块**保留**为「构建外部 Capacitor 工程」的入口——它是一条完整可用的工具链，
只是不该再把仓库里那个空目录当默认输入。

---

## 五、阶段三：目录隔离（已执行，2026-09-17）

`apps/khy-mobile` 的物理隔离**已按 `LAYOUT-004`（HK-3 只隔离不删除）执行**。
目录移至 `.khyos/housekeeping/2026-09-17/apps-khy-mobile/khy-mobile/`，并在同级
`manifest.json` 留下源路径、内容清单、引用收口清单与撤回指令。`.khyos/` 在根
`.gitignore` 内，不污染 git 状态。

引用收口清单（实测定位 + 已改）：

| 类别 | 位置 | 处理 |
|---|---|---|
| 脚本硬引用 | `scripts/ci/check-dependency-size.js` | 删 `apps/khy-mobile/package.json` 条目 |
| | `scripts/ci/check-f2e-wiring.js` | 删 MOBILE checkRestDirection 块，方向数 4→3 |
| | `scripts/frontend/fix-var-declarations.js` | 删 `apps/khy-mobile/src` 目录项 |
| | `scripts/frontend/cleanup-console.js` | 同上 |
| | `scripts/frontend/fix-hardcoded-colors.js` | 同上 |
| | `scripts/lib/buildArtifactGuard.js` | android-build 规则 scope 改指 `apps/khy-os-client-app/android/`（规则泛化，不丢覆盖） |
| | `scripts/maintenance/clean.js` | 删 `apps/khy-mobile/android/app/build` 条目 |
| | `scripts/tests/buildArtifactGuard.test.js` | 测试路径改指 `apps/khy-os-client-app/android/`，删 `.npmkeep` 专测 |
| 产物登记 | `docs/10_规范/registry/BUILD-OUTPUTS.json` | 删 4 条 `khy-mobile-*` |
| 端登记表 | `entries/entries.json` | 删 `mobile-legacy` 条目 |
| 文档 | `[DESIGN-ARCH-117]` §一/§七 | 标注收口，保留历史现状记录 |
| | `README.md` / `.ai/MAP.md` | 删 khy-mobile 引用 |
| | `[DEPLOY-MAN-018]` | 顶部加 repurpose banner（见下） |

**未改的历史记录**（刻意不动，属时间快照）：`CHANGELOG.md`、`[IMPL-RPT-*]`、
`[DESIGN-SIZE-001]`、`.workbuddy*/memory/*`。改这些等于重写历史，违反文档诚实原则。

**buildArtifactGuard 规则泛化的理由**：原规则 scope 是 `apps/khy-mobile/android/`，
整条删掉会让 guard 变成空操作、`buildArtifactGuard.test.js` 全垮。幸存者
`apps/khy-os-client-app/android/` 同样是 Gradle 工程、同样产 APK/AAB，规则对它
完全适用。改指而非删除，保留了守卫覆盖。

**撤回**：`mv .khyos/housekeeping/2026-09-17/apps-khy-mobile/khy-mobile apps/khy-mobile`
即可还原目录；但引用收口的 8 个脚本 + BUILD-OUTPUTS + entries.json 须同步还原，
否则引用悬空——manifest.json 已记录全部 sibling 改动。

---

## 六、测试证据（2026-09-17 本机实测）

环境：Node v22.18.0、Flutter 3.47.2 / Dart 3.13.2（`D:\Portable\Tools\flutter`）、Python 3.11.9。

| 项 | 结果 |
|---|---|
| `flutter pub get` | 通过，`mobile_scanner 7.4.2` 正常解析 |
| `flutter test`（全量） | **229 全过** |
| `flutter test test/pairing_test.dart` | **27 全过** |
| `flutter analyze` | 67 条存量 issue，**本次改动的 3 个文件 0 条** |
| Jest `mobilePairingContract.test.js` | **11 全过** |
| Jest `crossLauncher.unit` + `crossPlatform.auth` + 契约 | **52 全过（3 suite）** |
| `node services/backend/bin/khy.js entry probe --json` | `mobile` ready；`mobile-legacy` 仍 `broken`（如实） |
| `node scripts/ci/check-repo-layout.js` | `docs-index-complete: 0`，0 error |
| `node scripts/ci/check-build-root.js` | 2 条 error 属存量 advisory，不阻断 |
| `node scripts/ci/check-version-sync.js` | 三轨道全过 |
| `node scripts/ci/check-agent-rules.js`（本次 5 个 JS 文件） | 0 违规 |

**跨语言端到端**（最强证据，非移植近似）：用真实 CLI 模块产出载荷，喂给真实 Dart 解析器：

```
PRODUCER payload={"apiBaseUrl":"http://192.168.1.193:3000"}
PRODUCER mgmt  =http://192.168.1.193:9090/admin/ai-gateway
CONSUMER ACCEPTED -> http://192.168.1.193:3000     ← 配对二维码
CONSUMER REJECTED -> n/a                            ← 管理页二维码
```

**未能验证的项（诚实声明）**：

- **真机扫码路径未验证**。`mobile_scanner` 的 `MobileScannerException` 错误分支
  （相机权限被拒、设备不支持）与 `onDetect` 的真实回调时序，只能在有相机权限的设备上确认。
  本方案已通过类型核对（`flutter analyze` 0 issue）与 API 逐字段核对
  （对照 `mobile_scanner` v7.4.2 源码：`onDetect: void Function(BarcodeCapture)`、
  `errorBuilder: Widget Function(BuildContext, MobileScannerException)`）降低风险，
  但这不等同于真机验证。
- **APK 未构建**。构建需要 Android SDK + 签名凭据；本次只验证了 Dart 源码可编译、
  单测全过，未产出 APK。

---

## 七、三条不可回退的不变量

合并做完之后，下面三条必须长期成立。任何后续改动若破坏它们，属于回归：

1. **配对信封永远是 JSON 对象，且只有 `apiBaseUrl` 一个必填键**。
   它不是 URL，因为裸 URL 会被系统相机抢走。改形状必须同时改
   `handlers/mobile.js`、`pairing.dart`、`mobilePairingContract.test.js` 三处。
2. **两种二维码的不可混用性必须由 App 侧显式执行**，不能依赖「用户自己别扫错」。
   执行点是 `PairingPayloadParser` 的 `managementEntryPath` 判定。
   注意判定必须是**精确匹配或带斜杠前缀**（`/admin/ai-gateway` 或 `/admin/ai-gateway/…`），
   用 `contains` 会把合法的 `/admin/ai-gateway-api` 误杀——这条已被单测锁死。
3. **没有任何代码把 `apps/khy-mobile` 当成可用端**。
   验收手段是 `khy entry probe`：`mobile-legacy` 保持 `broken` 是正确状态，
   不是待修 bug；把它改成 `ready` 才是回归。

---

## 八、验证命令速查

```bash
# 消费端单测
cd apps/khy-os-client-app && flutter test test/pairing_test.dart

# 消费端全量
cd apps/khy-os-client-app && flutter test && flutter analyze

# 跨语言契约（Node 侧）
cd services/backend && node node_modules/jest/bin/jest.js \
  tests/cli/handlers/mobilePairingContract.test.js --runInBand

# 端矩阵真实状态
node services/backend/bin/khy.js entry probe --json

# 本次改到的仓库门
node scripts/ci/check-repo-layout.js
node scripts/ci/check-build-root.js
node scripts/ci/check-version-sync.js
node scripts/ci/check-agent-rules.js \
  services/backend/src/services/crossPlatform/crossLauncher.js \
  services/backend/src/cli/handlers/crossPlatform.js \
  services/backend/src/constants/serviceDefaults.js
```

> 工具链是本机级事实，不影响仓库级状态（`[DESIGN-ARCH-117]` §五 同一约定）：
> 上述 `flutter` 命令需要本机装有 Flutter；Node/Python 侧的门在任何机器上都可跑。
