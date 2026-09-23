# [OPS-MAN-071] 卸载第三方应用怎么保证卸干净(原生自带卸载器 T2 层)

> 场景:让 khy 去卸载**当前设备上的某个应用**(exe 或 CLI),而不是卸载 khy 自己。
> 与 [OPS-MAN-069]/[install-ledger] 是**镜像问题**:卸自己有台账(创建时记了),
> 卸别人**没有台账**,只能委托给「知道文件清单的东西」。

## 一句话结论

「卸干净」= **先找清单/卸载器再动手,绝不猜删安装目录**。按可靠度分三档,路由由
`decideUninstallRoute` 确定性判定:

| 档 | 场景 | 靠什么卸干净 | 代码 |
|----|------|------------|------|
| **T1 pm** | 包管理器装的(winget/choco/scoop/brew/apt/dnf/pacman) | 包管理器自带文件清单,精确回收 | `deviceAppsPolicy` + `deviceAppManager`(已有) |
| **T2 native** | 原生安装器的裸 exe(MSI/Inno/NSIS),不被任何包管理器跟踪 | 跑 **app 自己在注册表登记的卸载器**(它知道全部文件) | `nativeUninstallPolicy` + `nativeUninstaller`(本手册) |
| **T3 refuse** | 既无清单也无自带卸载器(如 `curl\|sh` 丢的裸二进制) | **诚实拒绝**——没有清单谁都只能猜,宁可不删 | `uninstallRoute` 返回 `tier:'refuse'` |

## T2 是本次填补的真实缺口

Windows 上大量 exe 由 **MSI / Inno Setup / NSIS** 之类原生安装器落盘,不被包管理器跟踪——
但它们**自己在注册表里登记了一个卸载器**:
`HKLM/HKCU\SOFTWARE\...\Microsoft\Windows\CurrentVersion\Uninstall\<key>` 下的
`UninstallString` / `QuietUninstallString` / (MSI 的)`ProductCode`。

`nativeUninstaller`(IO 壳,仅 win32)用 `reg query <root> /s` 读这三个根(64 位 / WOW6432Node /
HKCU),`nativeUninstallPolicy`(纯叶子)把每条记录归一 + 分类,再构造**卸载 argv**:

- **MSI** → `msiexec /x {ProductCode} /qn /norestart`(最稳、天然静默、系统级回收)。
- **Inno**(`unins000.exe`)→ 优先用作者给的 `QuietUninstallString`,否则补 `/VERYSILENT /NORESTART`。
- **NSIS**(`uninstall.exe`)→ 补 `/S`。
- **generic**(卸载串在但形态不认识)→ 原样执行,不猜静默参数。

## 红线(与 install-ledger 同口径)

1. **命令一律是 argv 数组**(execFile 直传,绝不拼 shell 字符串)。
2. **`UninstallString` 为空 → 拒绝**,绝不退化成 `rmdir`/`rm` 猜删安装目录。猜删 = 不干净 = 红线。
3. MSI ProductCode 必过 GUID 白名单;卸载器路径必是绝对 `.exe`,否则拒绝。
4. 破坏性:`uninstall(record, {confirmed:true})` 才真执行;未确认只回计划(argv)。

## 平台边界(诚实降级)

- **仅 Windows** 有注册表 Uninstall 键。Linux/macOS 的原生安装不走注册表,由 **T1 包管理器**覆盖;
  非 win32 时 `getNativeUninstaller` 返回 `available:false` 并说明原因。
- T3 拒绝**不是 bug 而是正确姿态**:没有清单的东西,任何工具都只能猜;khy 拒绝假装卸干净。

## 门控

- `KHY_DEVICE_APPS_NATIVE_UNINSTALL`(默认开,父 `KHY_DEVICE_APPS`)。
  关 → `nativeUninstaller` 报 `available:false`,路由回退到「仅 T1 + T3 拒绝」,逐字节回退。

## 入口

```
khy device uninstall <包ID或应用名>      # 自动分档:T1 包管理器 → T2 自带卸载器 → T3 拒绝
```

- 传**包管理器标识**(如 `Microsoft.VisualStudioCode`)→ 走 T1。
- 传**应用显示名**(如 `My Editor`,含空格)→ 注册表匹配自带卸载器,走 T2。
- 多个同名条目 → 列出让用户选更精确的名称(`ambiguous`)。
- 都没有 → T3 诚实拒绝,提示「khy 只在能找到清单或自带卸载器时才卸载」。

LLM 工具 `DeviceApps`(action `uninstall`)走同一路由;`confirm:true` 才执行,否则只回计划。

## 验证

```
npm run test:maintainer:native-uninstall
```

覆盖:policy 归一/分类/argv 构造/无卸载器即拒绝、uninstaller 注册表解析/过滤/去重/确认门、
路由三档判定、CLI+tool 接线源级断言。
