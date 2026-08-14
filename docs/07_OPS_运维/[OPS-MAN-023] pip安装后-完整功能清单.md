<!-- 文档分类: OPS-MAN-023 | 阶段: 运维 | 原路径: docs/指南/pip安装后-完整功能清单.md -->
# pip 安装后：开启完整功能清单

> 适用对象：通过 `pip install khy-os` 安装的用户（Windows / macOS / Linux）。
>
> pip 只装好「Python 启动器」这一层。KHY OS 的核心是 Node.js 后端 + Vue 管理前端 + 多语言工作坊（C 内核 / MoonBit / WASM），完整功能需要再满足几层运行时依赖。本清单按「先验证 → 再配置 → 后使用」的顺序，把所有要做的事一次列清。

> 📦 **pip 安装后，先读哪篇？**
>
> | 你的目的 | 看这篇 |
> | --- | --- |
> | 第一次装完，想最快跑起来 | [OPS-MAN-027] 快速开始 |
> | 想按成长阶梯一步步进阶 | [OPS-MAN-043] 从 0 到高手 |
> | **本文** | 装完到底能干什么（功能清单速查） |
> | 想按需开启某个具体功能 | [OPS-MAN-024] 按需配置体验 |
> | 安装与运行的软硬件门槛 | [OPS-MAN-028] 环境要求 |
> | 还原源码树 / 自研内核全功能 | [OPS-MAN-037] 完整还原与全功能开启 |

---

## 0. 一句话速通

```bash
khy preflight     # 1) 体检：缺什么、怎么修，一屏看完
khy where         # 2) 确认真实安装位置（不是 PATH 垫片）
khy               # 3) 首次启动会自动装依赖、建库、写 .env，然后进入 REPL
```

进入 REPL 后：

```text
khychat           # 打开 AI 对话 / 管理页（Web，默认 /admin/ai-gateway）
khyos             # 启动 KHY OS 内核
gateway config    # 配置模型 / Provider / 密钥
```

如果 `khy preflight` 全绿，基本可以直接用。下面是逐项详解。

---

## 1. 前提依赖（必须）

KHY OS 的运行时分四层，缺一不可。`khy preflight` 会一次性体检并给出**可直接粘贴执行**的修复命令：

| 层 | 检查项 | 缺失后果 | 修复 |
| --- | --- | --- | --- |
| 1 | `khy` 在 PATH 上 | shell 报 `'khy' 不是命令` | 见 preflight 输出的 PATH 追加命令；或 `python -m khy_platform <cmd>` 兜底 |
| 2 | Node.js >= 20 | 后端无法启动 | Windows: `winget install OpenJS.NodeJS.LTS`；macOS: `brew install node`；国内镜像见 preflight |
| 3 | `backend/node_modules` 已安装 | 首次启动失败 | 跑一次 `khy`（自动 `npm install`），或手动 `cd <backend> && npm install` |
| 4 | 全局 `claude` CLI（可选） | `khy claude` 不可用 | `npm install -g @anthropic-ai/claude-code` |

> Windows 提示：若 `npm install` 因长路径失败，用管理员权限执行
> `git config --system core.longpaths true`，或在组策略中启用 Win32 长路径。
> 若安装目录只读（系统级 site-packages），改用 `pip install --user khy-os`。

---

## 2. 确认真实安装位置：`khy where`

Windows 的内建 `where khy` **只会显示 Scripts 目录里的 `khy.exe` 垫片**，看不到后端核心代码（bundled 后端）的真实位置。用 KHY 自带的子命令查看全部真实路径：

```bash
khy where
```

输出示例：

```text
khy install location
============================================================
  version        : 0.1.x
  mode           : pip-bundled
  executable     : C:\...\Scripts\khy.exe
  python launcher: C:\...\site-packages\khy_platform\cli.py
  bundle root    : C:\...\site-packages\khy_os\bundled
  install root   : C:\...\site-packages\khy_os\bundled
  backend dir    : C:\...\site-packages\khy_os\bundled\services\backend
  dependencies   : installed
============================================================
```

- `mode`：`source`（源码仓库）/ `pip-bundled`（pip 安装）/ `runtime`。
- `dependencies`：`installed` 表示 `node_modules` 已就绪；`MISSING` 则先跑一次 `khy` 或 `khy preflight`。
- 别名：`khy which` / `khy location` 等价。

---

## 3. 首次启动：自动初始化

第一次执行 `khy`（任何非 `--help` / `--version` 命令）时，启动器会自动完成：

1. **跨语言运行时自愈**（postinstall）：检查 Node / Python 工具链，按需修复，永不中断启动。
2. **`npm install`**：在后端目录安装 Node 依赖。
3. **写 `.env`**：生成默认配置。
4. **建数据库**：初始化本地 SQLite。

这一步可能耗时一两分钟（首次装依赖）。若中途失败，可手动重跑：

```bash
khy postinstall   # 重跑跨语言运行时自愈
khy dev-setup     # 重建前检查/修复开发工具链（编译期）
```

---

## 4. 配置模型 / Provider / 密钥

进入 REPL 后用网关命令配置可用模型来源：

```text
gateway config         # 交互式配置 Provider / API Key
gateway                # 进入网关管理
模型发现                # 自动发现各适配器可用模型（别名 modelscan）
```

KHY 支持多种模型来源（KHY ExpandModel 本地+订阅、Kiro/AWS Q、Trae、Cursor、Codex、Relay API、VS Code Copilot、Ollama、本地模型等）。配置后用 `khy claude --list` 或管理页查看完整模型列表。

> 国内网络：若直连 Anthropic / AWS 受阻，设置 `HTTPS_PROXY` / `HTTP_PROXY`（支持 Clash 等本地代理）后再启动。

---

## 5. 打开 AI 对话 / 管理页（Web）

REPL 内输入 `khychat`（或 `chat` / `ai对话`），会启动管理后端 + Vue 前端并打开浏览器到 `/admin/ai-gateway`：

```text
khychat                       # 启动 + 打开管理/对话页
gateway manage open           # 等价的完整写法
gateway manage status         # 查看运行状态
gateway manage stop           # 停止
```

默认端口：API `9090`、前端 `8090`（可用 `--api-port` / `--frontend-port` 覆盖）。

> 这正是早期版本「`khychat` 打不开 AI 对话页」的根因所在：Windows 上守护进程用 `npm.cmd` 拉起前端会触发 `spawn EINVAL`（CVE-2024-27980）。已在 0.1.95 修复（`shell` 模式启动 + 失败优雅降级）。若仍遇到，先 `khy preflight` 体检，并确认已升级到 >= 0.1.95。

---

## 6. 启动 KHY OS 内核

```text
khyos                         # REPL 内启动 KHY OS（自研 C 内核）
```

或从 shell：

```bash
khy os                        # 同上
khy os build                  # ★ 从 bundled 源码构建自研内核 ISO（pip 安装后还原）
khy os doctor                 # 体检（检查 QEMU + 列出 ISO 来源，不下载/不构建）
```

> `khy os doctor` 仅体检不下载。`khy os build` 是 pip 安装后**还原内核的一键命令**（见 §6.4）。

### 6.1 为什么会报 “No KHY OS ISO available”

pip 包**按设计从不内含内核 ISO**——wheel 只携带内核**源码**（`kernel/src`、`kernel/boot`、`kernel/Makefile`，位于 `khy_os/bundled/kernel/`）加一个**下载清单** `khyos-manifest.json`。当前清单的 `url`/`sha256` 为空（尚未发布过 release ISO），所以「按需下载」这条路不可用，于是直接落到这条**可操作**的提示：

```text
[内核] No KHY OS ISO available: not found in kernel/build or the cache, and no
download is pinned in the manifest. Build it locally with `make -C kernel iso`
(then it is auto-discovered), or set KHY_KERNEL_ISO to an existing ISO path.
```

这是**正常状态、不是包损坏**。「还原内核」= 你需要自己产出一个 ISO。

### 6.2 ISO 解析顺序（自研 C 内核）

内核启动时按以下顺序查找 ISO，命中即用：

```text
1. KHY_KERNEL_ISO 环境变量（指向现成 ISO 的绝对路径）   ← 最高优先
2. kernel/build/khy-os-kernel.iso（make 产物）          ← 自动发现
3. ~/.khyquant/khyos/ 缓存（曾经下载/拷入过）
4. 清单 khyos-manifest.json 里 pin 的 url + sha256       ← 当前为空，不可用
```

### 6.3 ⚠️ 两条 OS 路径别混淆

| 命令 | 产物 | 构建方式 | 适合 |
|---|---|---|---|
| **`khyos` / `khy os`**（本节报错的这个） | `khy-os-kernel.iso`（自研 C 内核） | `make -C kernel iso` | 体验自研内核 |
| **`khy iso build`** | `dist/khy-os.iso`（**Alpine** 发行版 ISO） | Docker（`Dockerfile.iso-builder`，FROM alpine） | 跑「真实 OS」 |

`khy iso build` 产出的 `khy-os.iso` **不是** `khyos` 要找的 `khy-os-kernel.iso`，两者互不替代。

### 6.4 还原自研内核（按省事排序）

自研 C 内核的 Makefile 默认走 Unix 工具链（`nasm` + `gcc` + `ld` + `grub-mkrescue` + `xorriso` + MoonBit(`moon`)），运行还需 `qemu`。Windows 上 `khy os build` 已能**自动级联**，省心程度从高到低：①**原生 LLVM + Limine 后端**——无需 WSL/Docker/VM，首次按 sha256 钉死自动下载 clang/ld.lld/nasm/Limine/xorriso/BusyBox 工具链到 `~/.khyos/cache`，就地构建（Limine 取代无 Windows 版的 `grub-mkrescue`，详见 [OPS-MAN-036] §8）；②检测到 **WSL2** 就经 WSL 跑未改动的 Makefile；③没有 WSL 但有 **Docker** 就经容器内 Linux 工具链构建；④有 **QEMU 构建器虚拟机** appliance 时经 VM 构建；都不可用才打印安装指南（详见 [OPS-MAN-036] 与本节选项 B）。

**选项 A — 一键构建（推荐，Linux / macOS / WSL2）**

```bash
khy os build
```

它会自动：① 定位 bundled 内核源码目录；② 体检工具链，缺什么就**精确告诉你**装哪个包（`apt` 包名 / MoonBit 安装命令），绝不半途卡死；③ 跑 `make iso`，产物落在 `<bundled>/kernel/build/khy-os-kernel.iso`——**该位置会被自动发现**，构建完直接 `khy os` 即可，**无需设置任何环境变量**。

工具链没装齐时它只是把恢复命令打出来。手动一次装好：

```bash
# Debian / Ubuntu / WSL2
sudo apt update
sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso qemu-system-x86
# MoonBit 工具链（kernel Makefile 的 moonbit-build 步骤需要；khy os build 会自动把 ~/.moon/bin 接入 PATH）
curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash
export PATH="$HOME/.moon/bin:$PATH"

khy os build      # 装齐后重试
khy os            # 运行（自动发现刚构建的 ISO）
```

**选项 B — Windows 用户：`khy os build` 自动委派（WSL2 或 Docker）**

Windows 上**直接 `khy os build` 即可**，它按 `KHY_KERNEL_BUILD_BACKEND`（默认 `auto`）自动选后端：

```text
khy os build  →  auto  ┬─ 有 WSL2 ─────────▶ 经 WSL 跑未改动的 Makefile（推荐）
                       ├─ 无 WSL,有 Docker ─▶ 经容器内 Linux 工具链构建（用户不必自装编译器）
                       └─ 都没有 ───────────▶ 打印安装指南,返回 false（不假构建）
```

ISO 经路径映射写回 Windows 侧的 `kernel\build\khy-os-kernel.iso`,自动发现,构建完直接 `khy os`。

*B-1 路线 WSL2（推荐）：*

```powershell
wsl --install -d Ubuntu          # 装 WSL2 + Ubuntu（首次需重启）
wsl sudo apt update
wsl sudo apt install -y build-essential nasm grub-pc-bin grub-common xorriso
wsl bash -c "curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash"
khy os build                     # 回到 Windows,自动经 WSL 构建
khy os                           # 运行（需 QEMU）
```

*B-2 路线 Docker（无 WSL 也能用,全工具链封在镜像里）：*

```powershell
# 装并启动 Docker Desktop,对内核源码所在盘启用文件共享
set KHY_KERNEL_BUILD_BACKEND=docker
khy os build                     # 首次构镜像较慢,之后走缓存
```

*B-3 手动（若 khy 装在 WSL 里,或想自己定位源码构建）：*

```bash
# 在 WSL2/Linux 内,装齐工具链（同选项 A）后:
khy os build                     # 若 khy 在 WSL 内
# —— 或手动定位 bundled 源码（零硬编码自动推导路径）——
KDIR="$(python3 -c 'import khy_os,os;print(os.path.join(os.path.dirname(khy_os.__file__),"bundled","kernel"))')"
make -C "$KDIR" iso              # 产物 $KDIR/build/khy-os-kernel.iso
```

> 为什么纯 Windows 不能零依赖构建:内核 ISO 是 multiboot2/GRUB 镜像,最后一步必须
> `grub-mkrescue`+`xorriso`,二者无原生 Windows 版本——故 Windows 必须有 WSL2 或 Docker
> 之一提供 Linux 工具链环境。完整原理见 [OPS-MAN-036]。

构建好的 `khy-os-kernel.iso` 也可拷给 Windows 上的 `khy` 用：

```powershell
$env:KHY_KERNEL_ISO = "C:\path\to\khy-os-kernel.iso"
khy        # 进 REPL 后执行 khyos
```

> 找不到 bundled 路径时用 `khy where` 打印 bundle root / backend dir，其 `kernel` 子目录即源码。

**选项 C — 已有现成 ISO，直接指过去（最快）**

```bash
export KHY_KERNEL_ISO="/path/to/khy-os-kernel.iso"   # Windows: $env:KHY_KERNEL_ISO=...
khy os
```

也可把 ISO 放进 `~/.khyquant/khyos/`（解析顺序第 3 步）同样自动发现。

**选项 D — 想要「真实 OS」而非自研内核 → 用 Docker 构建 Alpine ISO**

```powershell
# 需 Docker Desktop；会先自愈工具链(ensure_dev_environment)，在 Docker 内构建
khy iso build --output dist\khy-os.iso
qemu-system-x86_64 -cdrom dist\khy-os.iso -m 512M -serial stdio
```

> 注意：选项 D 产出的是 **Alpine 发行版 ISO**，与自研 C 内核 `khy-os-kernel.iso` 是不同产物（见 §6.3）。

**一句话**：pip 不带内核 ISO（设计如此 + 尚未发布 release ISO），「还原」= 自己构建。首选 `khy os build` 一键完成；Windows 上它自动委派 WSL2（或无 WSL 时用 Docker），无需手动切环境；已有 ISO 用 `KHY_KERNEL_ISO` 指过去。

---

## 7. 手机访问（同局域网）

```bash
khy mobile                    # 生成二维码，手机扫码访问管理页
khy mobile 9090               # 指定端口
khy mobile 192.168.1.9:9090   # 指定主机:端口
```

手机与电脑需在同一局域网。二维码指向 `http://<本机内网IP>:<端口>/admin/ai-gateway`。

---

## 8. 集成 Claude Code（可选）

```bash
khy claude                    # 交互选择模型，经 KHY 代理启动 Claude Code
khy claude --list             # 仅列出可用模型
khy claude --model <model>    # 指定模型直接启动
khy claude --hybrid           # 外部 token 做主模型 + KHY 适配器做子代理
khy claude --hybrid-sub       # KHY 适配器做主模型 + 外部 token 做子代理
```

需先全局安装 `claude` CLI（见第 1 节第 4 层）。KHY 通过子进程环境变量注入代理配置，**不写 `settings.json`，退出后零残留**，不影响你直接使用 `claude`。

---

## 9. 排障速查

| 现象 | 处理 |
| --- | --- |
| `'khy' 不是命令` | `khy` 不在 PATH；用 `python -m khy_platform preflight` 看 PATH 追加命令 |
| 启动报缺模块 / `Cannot find module` | `node_modules` 未装好，跑一次 `khy` 或手动 `npm install` |
| `khychat` 打不开页面 | 升级到 >= 0.1.95；`khy preflight` 体检；确认 9090/8090 未被占用 |
| `spawn EINVAL`（Windows） | 0.1.95 已修，升级即可 |
| 不知道装在哪 | `khy where` |
| 想从头体检 | `khy preflight` |

---

## 10. 命令总览（常用）

```text
# shell 直接调用
khy                  进入 REPL（首次自动初始化）
khy preflight        体检启动依赖
khy where            真实安装位置
khy postinstall      跨语言运行时自愈
khy dev-setup        开发工具链自愈
khy claude           启动 Claude Code（经 KHY 代理）
khy os               启动 KHY OS 内核
khy os build         从源码构建自研内核 ISO（pip 安装后还原）
khy mobile           手机扫码访问
khy -p "问题"        一次性 AI 输出

# REPL 内（输入 khy 进入后）
khychat              AI 对话 / 管理页
khyos                KHY OS 内核
gateway config       配置 Provider / 密钥
模型发现              发现可用模型
help                 完整命令帮助
```

> 完整命令以 `khy help` / REPL 内 `help` 为准；本清单覆盖完整功能所需的关键路径。

---

## 11. 半实现 / 桩命令现状（诚实清单）

下列命令在帮助里可见、也能调用，但**当前是预览桩或半实现**，不要当成成品依赖：

| 命令 | 现状 | 说明 |
| --- | --- | --- |
| `khy order` | **预览桩** | 仅打印「下单功能需要连接交易接口，当前为预览模式」后返回，**不连任何交易接口、不会真实下单**（`router.js:892-895`）。 |
| `khy train cloud` | **占位** | 返回假的 job id，无真实云端训练端点；请只用本地 `khy train start`（见 [OPS-MAN-048]）。 |
| `khy train distill`（CLI 分支） | **仅信息提示** | router 层只打印说明，未接通已实现的蒸馏逻辑（见 [OPS-MAN-048]）。 |
| `khy security monitor` | **进程内计时器** | 非脱离式守护，`unref()` 后不单独保活；当前进程退出即停（见 [OPS-MAN-052]）。 |
| `khy verdict watch` | **仅信息提示** | 真正常驻靠 `khy daemon start`，本身不自起长进程（见 [OPS-MAN-054]）。 |
| `khy evolve` / `khy verdict` | **只读咨询** | 分级 / 裁决真实可信，但**不自我修改代码**；强制 / 回滚发生在自愈事务内（见 [OPS-MAN-055]）。 |

> 标注原则：上面这些**不删除、不隐藏**，只如实说明状态，避免误导。`khy deps install`（[OPS-MAN-056]）、`khy workflow run`（[OPS-MAN-057]）等是**真实执行**的命令，不在此列。
