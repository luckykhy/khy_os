<!-- 文档分类: OPS-MAN-037 | 阶段: 运维 | 主题: pip 安装后完整还原与全功能开启 -->
# [OPS-MAN-037] pip 安装后：完整还原项目 · 开启全部功能

> 适用对象：通过 `pip install khy-os` 安装的用户（Windows / macOS / Linux）。
>
> 本指南把「pip 装完之后要做哪些事、有哪些方法把完整项目还原、最终能用上项目的全部能力」
> 一条线讲清楚。与 [OPS-MAN-023] 互补：023 是功能清单速查，本文是**端到端的还原与启用流程**，
> 并已纳入 Windows 内核构建的最新行为（见 [OPS-MAN-036]）。

> 📦 **pip 安装后，先读哪篇？**
>
> | 你的目的 | 看这篇 |
> | --- | --- |
> | 第一次装完，想最快跑起来 | [OPS-MAN-027] 快速开始 |
> | 想按成长阶梯一步步进阶 | [OPS-MAN-043] 从 0 到高手 |
> | 想知道装完到底能干什么 | [OPS-MAN-023] 完整功能清单 |
> | 想按需开启某个具体功能 | [OPS-MAN-024] 按需配置体验 |
> | 安装与运行的软硬件门槛 | [OPS-MAN-028] 环境要求 |
> | **本文** | 还原源码树 / 自研内核 ISO 全功能 |

---

## 0. 先理解一件事：pip 只装了「启动器」

`pip install khy-os` 装下来的是**三层结构**：

```
pip wheel
├── khy_platform/      Python 启动器（PATH 上的 khy / khy.exe 指向它）
└── khy_os/bundled/    完整项目本体（随 wheel 携带，按设计不带运行时产物）
    ├── services/backend/     Node.js 后端（核心，需 npm install）
    ├── apps/ai-frontend/      Vue 管理前端（Web 对话 / 网关管理页）
    ├── kernel/               自研 C 内核【源码】（不带 ISO，需本地构建还原）
    ├── moonbit/ userland/    多语言工作坊（MoonBit / WASM）
    └── khyos-manifest.json   内核 ISO 下载清单（当前为空 = 按需下载不可用）
```

所以「完整还原项目」= 在启动器之上,把**三类运行时依赖**补齐:

1. **Node 运行时 + 后端依赖**（`node_modules`）—— 让 AI 网关 / Web / CLI 全功能跑起来；
2. **模型来源配置**（Provider / Key / 适配器）—— 让 AI 真正能对话、能编码；
3. **自研内核 ISO**（本地构建）—— 让 `khy os` 能启动自研 C 内核。

下面按这个顺序逐层还原。

---

## 1. 一句话速通（先跑这三条）

```bash
khy preflight     # 体检：缺什么、怎么修，一屏看完（先看它）
khy where         # 确认真实安装位置（不是 PATH 垫片）
khy               # 首次启动：自动装依赖 / 建库 / 写 .env，然后进入 REPL
```

`khy preflight` 全绿 → 基本可直接用，跳到 §4 配置模型即可。
有红项 → 按它打印的、**可直接粘贴**的修复命令处理,再回到这里。

---

## 2. 第一层还原：运行时依赖（必须）

KHY OS 运行时分四层,`khy preflight` 会一次性体检:

> 📌 这张四层依赖表与 [OPS-MAN-023] §1 **同源**——若两处措辞有出入，以 [OPS-MAN-023] 为准。

| 层 | 检查项 | 缺失后果 | 修复 |
| --- | --- | --- | --- |
| 1 | `khy` 在 PATH 上 | shell 报 `'khy' 不是命令` | 按 preflight 打印的 PATH 追加命令；兜底 `python -m khy_platform <cmd>` |
| 2 | Node.js ≥ 20 | 后端无法启动 | Windows：`winget install OpenJS.NodeJS.LTS`；macOS：`brew install node`；Linux：发行版包管理器 |
| 3 | `backend/node_modules` | 首次启动失败 | 跑一次 `khy`（自动 `npm install`），或手动 `cd <backend> && npm install` |
| 4 | 全局 `claude` CLI（可选） | `khy claude` 不可用 | `npm install -g @anthropic-ai/claude-code` |

**确认真实位置**（Windows 的 `where khy` 只看得到垫片,看不到 bundled 本体）：

```bash
khy where     # 打印 version / mode / bundle root / backend dir / dependencies 状态
```

- `mode`：`pip-bundled` 即 pip 安装；`dependencies: installed` 表示 `node_modules` 已就绪。
- 别名：`khy which` / `khy location`。

> Windows 提示：若 `npm install` 因长路径失败,管理员执行
> `git config --system core.longpaths true` 或在组策略启用 Win32 长路径。
> 安装目录只读时改用 `pip install --user khy-os`。

---

## 3. 首次启动：自动初始化

第一次执行 `khy`（任何非 `--help`/`--version` 命令）时,启动器自动完成:

1. **跨语言运行时自愈**（postinstall）：体检 Node/Python 工具链,按需修复,**永不中断启动**；
2. **`npm install`**：后端目录装 Node 依赖；
3. **写 `.env`** + **建本地 SQLite 库**。

首次可能耗时一两分钟。中途失败可手动重跑:

```bash
khy postinstall   # 重跑跨语言运行时自愈（安装期）
khy dev-setup     # 重建前的开发工具链自愈（编译期）
```

---

## 4. 第二层还原：模型来源（让 AI 能用）

进入 REPL（输入 `khy`）后配置模型来源:

```text
gateway config         # 交互式配置 Provider / API Key
模型发现                # 自动发现各适配器可用模型（别名 modelscan）
gateway                # 进入网关管理
```

KHY 支持多来源:KHY ExpandModel(本地+订阅)、Kiro/AWS Q、Trae、Cursor、Codex、Relay API、
VS Code Copilot、Ollama、本地模型等。配置后 `khy claude --list` 或管理页查看完整列表。

> 国内网络:直连 Anthropic/AWS 受阻时,先设 `HTTPS_PROXY`/`HTTP_PROXY`（支持 Clash 等本地代理）再启动。

---

## 5. 第三层还原：自研内核 ISO（`khy os` 能跑）

### 5.1 为什么会报 “No KHY OS ISO available”

pip 包**按设计从不内含内核 ISO**——只带内核**源码** + 一个**空的**下载清单
（`url`/`sha256` 未填,因为尚未发布 release ISO）。所以这是**正常状态,不是包损坏**。
「还原内核」= 你需要本地产出一个 ISO。

ISO 解析顺序（命中即用）:

```text
1. KHY_KERNEL_ISO 环境变量（绝对路径）         ← 最高优先
2. kernel/build/khy-os-kernel.iso（make 产物） ← 自动发现
3. ~/.khyquant/khyos/ 缓存
4. 清单里 pin 的 url+sha256                     ← 当前为空,不可用
```

### 5.2 一键还原：`khy os build`（推荐,全平台）

```bash
khy os build      # 定位 bundled 源码 → 体检工具链 → make iso → 落在自动发现位置
```

产物落在 `<bundled>/kernel/build/khy-os-kernel.iso`,**该位置自动发现,无需设任何环境变量**,
构建完直接 `khy os` 即可。工具链缺失时它**精确告诉你装哪个包**,绝不半途卡死。

**各平台行为:**

| 平台 / 环境 | `khy os build` 做什么 | 要不要自己装编译器 |
| --- | --- | --- |
| **Linux / macOS** | 直接用宿主工具链 `make iso`（行为不变） | 是（见 §5.4 装一次） |
| **Windows（无 WSL/Docker）** | **原生 LLVM+Limine 后端**：自动下载钉死工具链就地 `make iso-limine` | **否（首次联网自动拉取,见 §5.2.1）** |
| **Windows + WSL2** | 自动经 WSL 跑**未改动的 Makefile** | 否（WSL 内装一次,见 §5.3） |
| **Windows + Docker（无 WSL）** | 自动经 Docker 容器内 Linux 工具链构建 | **否（全封在镜像里）** |
| **Windows + QEMU appliance** | 经 QEMU 构建器虚拟机内 `make iso` | 否（虚拟机内已封装） |
| **Windows 都没有且离线** | 打印安装指南,返回 false（不假构建） | —— |
| **Windows 强制宿主原生** `KHY_FORCE_KERNEL_BUILD=1` | 宿主已装 MSYS2/LLVM `make iso`（进阶） | 是（要求宿主预装工具链） |

> **纯 Windows 现在能（近乎）零依赖构建。** 内核 ISO 原走 multiboot2/GRUB,最后一步的
> `grub-mkrescue` 确无原生 Windows 版——但**原生 LLVM+Limine 后端**用有原生 Windows 二进制的
> **Limine + xorriso** 取代它,并按 sha256 钉死自动下载整套工具链到 `~/.khyos/cache`,**无需 WSL、
> 无需 Docker、无需 VM**(仅首次需联网拉取约数十 MB)。auto 级联优先用它;不可用(离线/校验失败)时
> 才回退 WSL2 → Docker → QEMU。详见 [OPS-MAN-036] §8。

#### 5.2.1 Windows 首选：原生 LLVM + Limine（无 WSL/Docker/VM）

裸 Windows 上**什么都不用先装**,直接:

```powershell
pip install khy-os
khy os build          # auto 级联首选原生后端:首次按 sha256 自动下载
                      #   clang/ld.lld/nasm/Limine/xorriso/BusyBox 到 %USERPROFILE%\.khyos\cache\toolchain\,
                      #   就地 make iso-limine,产物落 kernel\build\khy-os-kernel.iso
khy os doctor         # 体检 QEMU（运行内核仍需 QEMU,见 §5.5）
khy os                # 启动内核终端
```

- 仅**首次**需联网下载约数十 MB 工具链;之后命中缓存可离线复用。
- 强制本后端:`set KHY_KERNEL_BUILD_BACKEND=native-llvm`。
- 离线 / 下载校验失败时自动回退 WSL2 → Docker → QEMU(下列路线)。
- 原理与防呆见 [OPS-MAN-036] §8。

### 5.3 Windows 路线 A：WSL2（跑未改动的 Makefile）

```powershell
wsl --install -d Ubuntu          # 装 WSL2 + Ubuntu（首次需重启）
wsl sudo apt update
wsl sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso
wsl bash -c "curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash"
khy os build                     # 回到 Windows,自动检测 WSL2 并经其构建
khy os                           # ISO 落在 kernel\build\,直接运行（需 QEMU）
```

### 5.4 Windows 路线 B：Docker Desktop（无 WSL 也能用）

```powershell
# 装并启动 Docker Desktop,对内核源码所在盘启用文件共享
set KHY_KERNEL_BUILD_BACKEND=docker
khy os build                     # 首次构镜像较慢（封装全工具链）,之后走缓存
# 可选:用预构镜像跳过本地构镜像
set KHY_KERNEL_BUILD_IMAGE=<your-registry>/khyos-kernel-build:latest
```

用户本地**只需 Docker**,不必自己装 nasm/gcc/grub——都在 `kernel/Dockerfile.kernel-build` 镜像里。

### 5.5 Linux / macOS / WSL2 内装工具链（一次）

```bash
sudo apt update
sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso qemu-system-x86
curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash   # MoonBit
export PATH="$HOME/.moon/bin:$PATH"
khy os build && khy os
```

### 5.6 已有现成 ISO：直接指过去（最快）

```bash
export KHY_KERNEL_ISO="/path/to/khy-os-kernel.iso"   # Windows: $env:KHY_KERNEL_ISO=...
khy os
```

也可把 ISO 放进 `~/.khyquant/khyos/`（解析顺序第 3 步）自动发现。

### 5.7 环境开关一览

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_KERNEL_BUILD_BACKEND` | `auto` | `wsl`/`docker`/`native` 强制后端 |
| `KHY_FORCE_KERNEL_BUILD` | 未设 | `=1` Windows 走宿主原生（=`backend=native`） |
| `KHY_KERNEL_BUILD_IMAGE` | 未设 | Docker 预构镜像名,跳过本地构镜像 |
| `KHY_KERNEL_ISO` | 未设 | 直接指向现成 ISO（最高优先） |
| `KHY_KERNEL_SRC_DIR` | bundle | 覆盖内核源码目录 |
| `KHY_CC`/`KHY_NASM`/`KHY_LD`/`KHY_GRUB_MKRESCUE`/`KHY_GCC_INCLUDE` | 未设 | 转发为 `make VAR=val` 覆盖工具链 |

> 运行内核需 QEMU（与构建分开）：`khy os doctor` 体检；Windows QEMU: https://qemu.weilnetz.de/w64/ 。

---

## 6. ⚠️ 两条 OS 路径别混淆

| 命令 | 产物 | 构建方式 | 适合 |
| --- | --- | --- | --- |
| **`khy os` / `khyos`** | `khy-os-kernel.iso`（**自研 C 内核**） | `make -C kernel iso` / `khy os build` | 体验自研内核 |
| **`khy iso build`** | `dist/khy-os.iso`（**Alpine 发行版**） | Docker（`Dockerfile.iso-builder`,FROM alpine） | 跑「真实 OS」 |

两者是不同产物,互不替代。想要「真实 OS」用后者:

```powershell
khy iso build --output dist\khy-os.iso     # 需 Docker Desktop,会先自愈工具链
qemu-system-x86_64 -cdrom dist\khy-os.iso -m 512M -serial stdio
```

---

## 7. 开启各项功能（还原后逐个点亮）

### 7.1 AI 对话 / 管理页（Web）

REPL 内 `khychat`（或 `chat`/`ai对话`）启动管理后端 + Vue 前端,打开 `/admin/ai-gateway`:

```text
khychat                 # 启动 + 打开管理/对话页
gateway manage status   # 运行状态
gateway manage stop     # 停止
```

默认端口:API `9090`、前端 `8090`（`--api-port`/`--frontend-port` 覆盖）。

### 7.2 手机访问（同局域网）

```bash
khy mobile                    # 生成二维码,手机扫码访问管理页
khy mobile 9090               # 指定端口
```

二维码指向 `http://<本机内网IP>:<端口>/admin/ai-gateway`,手机与电脑需同一局域网。

### 7.3 集成 Claude Code（可选）

```bash
khy claude                    # 交互选模型,经 KHY 代理启动 Claude Code
khy claude --list             # 仅列模型
khy claude --hybrid           # 外部 token 主模型 + KHY 适配器子代理
khy claude --hybrid-sub       # KHY 适配器主模型 + 外部 token 子代理
```

需先全局装 `claude` CLI（§2 第 4 层）。KHY 经子进程环境变量注入代理,**不写 `settings.json`,退出零残留**。

### 7.4 一次性 AI 输出 / 学习模式 / 工作流等

```bash
khy -p "问题"                 # 一次性 AI 输出（非交互）
# REPL 内:
/learn                        # 学习模式（本地/有网/有模型 三档）
help                          # 完整命令帮助
```

---

## 8. 全功能开启自检清单

逐条勾掉即「完整项目已还原、全功能可用」:

- [ ] `khy preflight` 全绿（Node≥20 + node_modules + PATH）
- [ ] `khy where` 显示 `mode: pip-bundled` / `dependencies: installed`
- [ ] `gateway config` 配好至少一个 Provider,`khy claude --list` 能列出模型
- [ ] `khychat` 能打开管理页并对话
- [ ] `khy os build` 成功,`khy os doctor` 显示 ISO 就绪 + QEMU 可用
- [ ] `khy os` 能进入自研内核终端
- [ ] （可选）`khy claude` 能经代理启动；`khy mobile` 能扫码；`khy iso build` 能出 Alpine ISO

---

## 9. 排障速查

| 现象 | 处理 |
| --- | --- |
| `'khy' 不是命令` | 不在 PATH；`python -m khy_platform preflight` 看追加命令 |
| `Cannot find module` | `node_modules` 未装好,跑一次 `khy` 或手动 `npm install` |
| `khychat` 打不开页面 | 升级 ≥0.1.95；`khy preflight`；确认 9090/8090 未被占用 |
| `spawn EINVAL`（Windows） | 0.1.95 已修,升级即可 |
| `No KHY OS ISO available` | 正常状态;`khy os build` 还原（见 §5） |
| Windows 无 WSL 也无 Docker | 装其一（§5.3 / §5.4）;二者必须一个 |
| Docker 构建拿不到源码 | 对内核源码所在盘启用 Docker 文件共享 |
| 不知道装在哪 / 从头体检 | `khy where` / `khy preflight` |

---

## 10. 命令总览

```text
# shell 直接调用
khy                  进入 REPL（首次自动初始化）
khy preflight        体检启动依赖
khy where            真实安装位置
khy postinstall      跨语言运行时自愈（安装期）
khy dev-setup        开发工具链自愈（编译期）
khy claude           启动 Claude Code（经 KHY 代理）
khy os               启动自研 C 内核
khy os build         从源码还原自研内核 ISO（全平台,Windows 自动委派 WSL/Docker）
khy os doctor        体检 QEMU + 列 ISO 来源
khy iso build        构建 Alpine 发行版 ISO（Docker）
khy mobile           手机扫码访问
khy -p "问题"        一次性 AI 输出

# REPL 内（输入 khy 进入后）
khychat              AI 对话 / 管理页
khyos                自研 C 内核
gateway config       配置 Provider / 密钥
模型发现              发现可用模型
/learn               学习模式
help                 完整命令帮助
```

> 完整命令以 `khy help` / REPL 内 `help` 为准。相关文档:
> [OPS-MAN-023]（功能清单）、[OPS-MAN-036]（Windows 内核构建方案）、[OPS-MAN-022]（pip 安装布局）、
> [OPS-MAN-059]（把 `docs/` 还原后生成 PDF/HTML 离线阅读）。
