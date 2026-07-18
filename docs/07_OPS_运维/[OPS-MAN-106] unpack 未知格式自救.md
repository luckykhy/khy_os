# [OPS-MAN-106] unpack 未知格式自救（通用解包器兜底 + 受控安装）

## 直击需求

用户在 Windows 上让 khy 解包 `app.asar`，旧构建报
`Unsupported archive format: .asar` 直接退出，PowerShell 兜底也失败。用户定调：

> 遇到未知格式时，需要 khy 自己想办法解决，比如安装某个插件，或者依赖等。

排查发现 `.asar` 在 HEAD 已由原生解析器支持（`_extractAsar`），Windows 那次失败是**旧构建**。
真正的缺口是 unpack 内建只认 `zip 族 / tar* / gz / asar`，撞到
`.7z / .rar / .bz2 / .xz / .lzma / .zst / .lz4 / .cab / .iso / .deb / .rpm`
仍旧一句 `Unsupported archive format` 退出——khy 不自救。

## 做法：两层自救

1. **探测并使用已装的通用解包器**（默认开）。撞到内建不认的格式时，回退到机器上已装的
   `7z / bsdtar / unar / unrar` 就地解包。
2. **一个都没装时——先指路，受控才代装**（默认只指路）。给出**按平台的精确安装命令**，
   交调用方/用户决定；只有在 `KHY_UNPACK_AUTO_INSTALL=1` **且**本次调用显式 `install:true`
   （模型须先在对话里征询用户点头）时，才代为执行安装命令并重试一次。对齐红线
   「禁止 AI 擅自动手」——装软件是改用户系统的动作，默认不擅自做。

## 架构

- **SSOT 叶子** `services/backend/src/services/reverseEngineer/genericExtractor.js`
  （确定性只读解析器 + 解包驱动，**非零 IO 纯叶**：做 `which/where` 探测并驱动子进程）：
  - `GENERIC_FORMATS`：扩展名 → 候选解包器优先序（7z 覆盖面最广优先）+ 推荐安装包。
  - `PKG_INSTALL` / `PM_CMD` / `_PM_ORDER`：逻辑包名 → 各包管理器真实包名 → 装包命令构造。
  - `detectGenericFormat` / `pickExtractor` / `detectPackageManager` / `buildInstallCommand`：
    纯映射/选择逻辑，平台与可执行探测都可**注入**（`opts.platform` / `opts.has`）以确定性单测。
  - `extractWith` / `listWith`：数组式 argv 驱动子进程，fail-closed（任何失败 → `{ok:false}`）。
- **接线** `services/backend/src/tools/unpackTool.js`：
  - `_detectFormat` 末尾：门开且 `detectGenericFormat` 命中 → 返回 `'generic'`；门关 → 逐字节回退 `null`（旧 Unsupported 行为）。
  - `_extractGeneric`：探测器 → 解包 / 列举 / 指路 / 受控安装重试。
  - **安全护栏**（外部解包器绕过了逐条 entry 检查，故解包后补做）：
    `_verifyNoEscape`（逃逸拒绝 + 符号链接剥除）、`_sumTreeSize`（超 `MAX_UNPACK_BYTES` 则删目录）。

## 门 / 开关

| 环境变量 | 默认 | 语义 |
| --- | --- | --- |
| `KHY_UNPACK_GENERIC` | on | 通用解包器兜底层。off（`0/false/off/no`）→ 逐字节回退旧 Unsupported。 |
| `KHY_UNPACK_AUTO_INSTALL` | off | 代装层。仅 `1/true/on/yes` 开；还需本次调用显式 `install:true`。 |

二门均**未登记进 flagRegistry**（未注册 → 守卫保守放行，对齐 memoryOpsNotice / portableCli 先例）。

## 安全边界

- 输出目录仍受 `validateNoPathTraversal` 限域（工程树 / 用户 home 子目录）。
- 解包后逐树复核逃逸 + 剥符号链接 + 体积上限（超限即删）。
- 代装命令只经受控门 + 显式 `install:true` 才可达；**绝不写 key**。

## 验证

```
node --check services/backend/src/services/reverseEngineer/genericExtractor.js
node --check services/backend/src/tools/unpackTool.js
npm run test:unpack-generic   # 纯函数确定性 + 门关回退 + 真实 7z 端到端往返（无 7z 则跳过，不假绿）
```

真实 `7z` 往返测试：`7z a` 造真 `.7z`，经 unpack 公开 API 解包并逐字节校验内容；本机无 7z
则 `test.skip`（不伪造绿）。
