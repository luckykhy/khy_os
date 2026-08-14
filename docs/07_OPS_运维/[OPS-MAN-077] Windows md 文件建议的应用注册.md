# [OPS-MAN-077] Windows：让 khy 进 .md 的「建议的应用」

> 送别礼「右键打开 .md 时 khy 加入建议的应用」角度。用户截图：Windows 右键 .md →
> 「选择一个应用以打开此 .md 文件」，**建议的应用**里有 Quark / Trae / Windsurf / 记事本，
> **唯独没有 khy**。本子系统补上让 khy 出现在该列表的注册机制。

## 真实原因

`tools/khyos-markdown/register-windows.ps1` 原本写了两类项：

1. 右键动词 `SystemFileAssociations\.md\shell\khyosMarkdown`（「使用 khyosMarkdown 打开」）。
2. `.md\OpenWithProgids\KhyOS.Markdown` —— 把 ProgID 挂进「打开方式」列表。

但 Windows 11「选择应用打开.md」对话框顶部的**建议的应用 / Recommended Programs**
并非由 `OpenWithProgids` 填充（那多落到「更多选项」），而是由

```
HKCU:\Software\Classes\Applications\<app>\SupportedTypes\.md
```

填充。依据 Microsoft Win32 shell 文档
[How to Include an Application on the Open With Dialog Box](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box)：
`SupportedTypes` 子键「**causes the application to appear in the Recommended Programs list**」。
khy 从未写这段，故不在建议的应用里。

## 解决方法（本子系统所做）

`register-windows.ps1` 追加一段（仅 HKCU，红线：不写 HKLM、免 UAC）：

```
HKCU:\Software\Classes\Applications\khyos-md-launch.vbs
  FriendlyAppName = KhyOS Markdown              # 建议的应用里显示名
  DefaultIcon                                   # 图标
  \shell\open\command  = wscript.exe "<launcher>" "%1"
  \SupportedTypes
      .md        = ""                           # 值名即扩展名 → 进建议的应用
      .markdown  = ""
```

`unregister-windows.ps1` 对称递归删除 `Applications\khyos-md-launch.vbs`，零残留。

## 分层与 SSOT

- **纯核心 SSOT** `services/backend/src/services/mdSuggestedAppsPlan.js`：零 IO、绝不抛，
  `buildSuggestedAppsPlan()` 枚举「该写哪些注册项」，`suggestedAppsUninstallKeys()` 给卸载
  要移除的顶层键。
- **IO** 在 `register-windows.ps1` / `unregister-windows.ps1`（真正 `reg` 写入，仅 HKCU）。
- **契约测** `mdSuggestedAppsPlan.test.js` 既单测 plan，又静态断言两个 PS1 与 plan 不漂移、
  且注册/卸载对称。**诚实边界**：本 dev 机无 Windows/PowerShell，PS1 以静态契约测验证
  （断言必需写入存在 + 卸载对称），非实机执行。

## 触发路径

首启幂等自动注册 `services/backend/src/services/mdEditorRegister.js`
（门控 `KHY_MD_EDITOR ∧ KHY_MD_AUTO_REGISTER`，均 default-on）在 win32 上 detached spawn
`register-windows.ps1`；用户亦可 `khy md register` / `khy md unregister` 手动增删。
卸载经安装台账 `unregister-md-editor` → `khy md unregister` 覆盖，故本段随之清干净。

## HOW-TO-EXTEND

1. 新增一个想让 khy 建议打开的扩展名 → 改 `mdSuggestedAppsPlan.DEFAULT_EXTS`（或传 `exts`），
   并让 `register-windows.ps1` 的 `$exts` 跟上（契约测会红提醒）。
2. 改完跑：`npm run test:md-suggested-apps`（node:test，须全绿）。

## 验证

```bash
npm run test:md-suggested-apps
# 或
node --test services/backend/tests/services/mdSuggestedAppsPlan.test.js
```

## 相关

- `services/backend/src/services/mdEditorRegister.js`（首启幂等注册，spawn 本 PS1）
- [OPS-MAN-047] 代理服务器深度指南 / `khy md` 桥接器
- Microsoft：How to Include an Application on the Open With Dialog Box
