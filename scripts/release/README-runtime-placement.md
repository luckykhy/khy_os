# 内网 / 离线主机:本地放置推理 runner(方案 A)

适用场景:目标主机**不能联外网**,按需下载的 provisioner 拿不到 GitHub releases。
此时不走下载,改为**人工把对应平台的 ollama runner 放到位**,provisioner 的 fast-path
检测到 sentinel 文件即直接使用——零下载、零 sha256、零镜像。

> 在线 / 内网镜像的自动化方案见 `pin-runtime-binaries.js`(配合 `KHY_RUNTIME_MIRROR_BASE`)。
> 本文件只讲离线手工放置。

## 一、取得归档

通过你们的合规通道(U盘 / 内部制品库)取得**支持 qwen3-next/qwen35 的** ollama 发布归档。
注意:必须是新到能注册 `qwen35` 架构的版本(校验:`strings <ollama-bin> | grep qwen35` 应有命中)。
各平台官方归档文件名:

| 平台 (platform key) | 归档文件名 |
|---------------------|-----------|
| linux-x64           | `ollama-linux-amd64.tgz`   |
| linux-arm64         | `ollama-linux-arm64.tgz`   |
| darwin-arm64 / x64  | `ollama-darwin.tgz`(通用包)|
| win32-x64           | `ollama-windows-amd64.zip` |

## 二、解压并放置

目标根目录(相对仓库):`services/backend/bin/ollama-runner/`
**关键是让 sentinel 文件存在**——provisioner 的 present-check 精确匹配它。

### Linux / macOS(POSIX)

sentinel = `bin/ollama`。解压后保持归档自带的 `bin/` + `lib/` 结构:

```
services/backend/bin/ollama-runner/
├── bin/ollama            ← sentinel(必须可执行:chmod +x)
└── lib/ollama/*.so|*.dylib
```

```bash
tar -xzf ollama-linux-amd64.tgz -C services/backend/bin/ollama-runner/
chmod +x services/backend/bin/ollama-runner/bin/ollama
```

> macOS 通用包若解出的是根级 `ollama`(无 `bin/`),把 `runtime-binaries.json` 里对应
> darwin 平台的 `sentinel` 改成 `"ollama"`,或干脆放成 `bin/ollama` 也行——
> 二选一,只要 sentinel 路径与文件实际位置一致。

### Windows

sentinel = `ollama.exe`(在 runner **根目录**,无 `bin/` 前缀——zip 本来就这么打的):

```
services\backend\bin\ollama-runner\
├── ollama.exe            ← sentinel
└── lib\ollama\*.dll
```

```powershell
Expand-Archive -LiteralPath ollama-windows-amd64.zip `
  -DestinationPath services\backend\bin\ollama-runner\ -Force
```

> 或者完全跳过放置:`set OLLAMA_BIN=C:\已有\ollama.exe`,launcher 第一优先级读它。

## 三、自检(不联网)

放完跑一遍,确认 sentinel / 可执行位齐全:

```bash
node scripts/release/verify-runtime-placement.js ollama-runner
```

退码 `0` = 就绪可用(provisioner 直接用,不会尝试下载);`1` = 缺文件(按提示补)。
可把它当部署门禁。

## 四、原理

- provisioner 先算 `plat.sentinel || runtime.sentinel`,**在判断"是否已存在"之前**完成,
  所以 Windows 的 `ollama.exe`(根目录)和 POSIX 的 `bin/ollama` 都能被正确识别。
- sentinel 命中 → 状态 `present`,**零网络**直接返回。
- sha256 留空 → 即使没命中也只会回退系统二进制(`no-source`),**绝不误下载**。

因此离线主机只要把文件放对、sentinel 在位,就能零 ollama 跑 qwen3.5。
