<!-- 文档分类: MGMT-OTHER-001 | 阶段: 项目管理 | 原路径: docs/RESTORE_WINDOWS.md -->
# 还原后重建指南（Windows / Linux 通用）

> 本文件随**加密源码快照**一起分发。`khy restore` 会把它解出，并在还原完成后打印摘要。

`khy restore` 还原的是发布那一刻的 **完整工作树**——即这个项目**全部已跟踪源码的当前内容
（含尚未提交的改动）**，外加**未被 `.gitignore` 忽略的未跟踪新文件**（包含 `kernel/` 裸机内核
源码、文档、配置、训练数据等），并**保持原始目录结构**。

> **关键保证（针对「云电脑到期、文件无法拷贝下载、只能 pip/npm 发布」场景）：** 快照默认捕获
> **工作树**而非最后一次 commit，所以**未提交的工作不会丢**。`snapshot.json` 的
> `captureMode: "working-tree"` 与 `dirty: true` 即表示本次快照含未提交改动。
> （需要「只要已提交内容」时，发布前设 `KHY_SNAPSHOT_FROM=head`。）

它**不包含**「能在本机自己重新构建出来」的产物、以及被 `.gitignore` 忽略的内容，这些只需按
下面说明重建即可：

| 不在快照里 | 为什么 | 如何重建 |
|------------|--------|----------|
| `node_modules/` | 体积大、平台相关 | `npm install`（见下） |
| 内核 ISO `build/khy-os-kernel.iso` | 可由源码构建 | `kernel/` 下 `make`（见 `kernel/README.md`） |
| 前端 `dist/` | 构建产物 | 各前端目录 `npm run build` |
| `.git/` 历史 | 821M，超 PyPI/npm 限制 | 在还原目录 `git init`（见下） |
| `.env` / 密钥 | 不入包（安全） | 自行从 `~/.khyquant/config.json` 或团队渠道补齐 |

---

## 1. 重起 git 历史

快照不携带提交历史。进入还原目录后：

```bash
git init
git add -A
git commit -m "restore from khy source snapshot"
```

## 2. 安装依赖（各 npm workspace）

本仓库是 npm workspaces 单仓。`@khy/shared` 等内部包通过 workspace 解析，
在仓库根执行一次即可：

```bash
# 仓库根目录
npm install
```

> 若只想跑后端：`cd services/backend && npm install`。后端对 `@khy/shared` 的依赖在源码里写作
> `file:./vendor/shared`；从 npm 包还原时 `vendor/shared` 已随包带上，从 pip 快照还原时
> 由根 workspace（`platform/packages/shared`）解析，二者都无需手动处理。

## 3. 构建内核 ISO（可选，需要时再做）

推荐用一键命令（自动选后端、跨平台）：

```bash
khy os build    # 定位源码 → 体检工具链 → 构建，产出 build/khy-os-kernel.iso
```

或手动直跑 Makefile：

```bash
cd kernel
make            # 产出 build/khy-os-kernel.iso（Linux/macOS/WSL2）
```

工具链与依赖见 `kernel/README.md`（默认需 `nasm`/`gcc`/`ld`/`grub-mkrescue`/`qemu`，还需 MoonBit `moon`）。
**Windows 上** `khy os build` 已能 auto 级联：**首选原生 LLVM+Limine 后端**（无需 WSL/Docker/VM，
首次按 sha256 钉死自动下载工具链到 `~/.khyos/cache`，用 Limine 取代无 Windows 版的 `grub-mkrescue`），
不可用时回退 WSL2 → Docker → QEMU 构建器虚拟机。完整说明见 [OPS-MAN-036] §8。

## 4. 构建前端（可选）

```bash
# 主前端
cd frontend && npm install && npm run build
# AI 管理前端
cd apps/ai-frontend && npm install && npm run build
# 量化前端
cd software/khyquant/frontend && npm install && npm run build
```

## 5. 运行时前置依赖

- **Node.js**（运行后端/CLI）。
- **Python 3.10+**（pip 入口 `khy` / 量化部分）。
- **QEMU**（`qemu-system-x86_64` + `qemu-img`，仅在用 `khy os` 跑裸机内核时需要）。
  - Windows：从 https://qemu.weilnetz.de/ 安装并加入 PATH，或设 `KHY_QEMU` 指向可执行文件。

---

## 完整性

快照内 `snapshot.json` 记录了明文 `sha256`、文件数、源 commit。`khy restore` 解密后会**校验
sha256**，不匹配即报错并中止，确保「一字不差」。
