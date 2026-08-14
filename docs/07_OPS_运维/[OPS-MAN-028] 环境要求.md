<!-- 文档分类: OPS-MAN-028 | 阶段: 运维 | 原路径: docs/指南/环境要求.md -->
# 环境要求

> 📦 **pip 安装后，先读哪篇？**
>
> | 你的目的 | 看这篇 |
> | --- | --- |
> | 第一次装完，想最快跑起来 | [OPS-MAN-027] 快速开始 |
> | 想按成长阶梯一步步进阶 | [OPS-MAN-043] 从 0 到高手 |
> | 想知道装完到底能干什么 | [OPS-MAN-023] 完整功能清单 |
> | 想按需开启某个具体功能 | [OPS-MAN-024] 按需配置体验 |
> | 还原源码树 / 自研内核全功能 | [OPS-MAN-037] 完整还原与全功能开启 |
> | **本文** | 安装与运行的软硬件门槛 |

本文分两层：**用户最低运行要求**（纯 `pip install khy-os` 用户都要看）与
**维护 / 构建要求**（只在你要打包、构建内核镜像时才需要，普通用户可跳过）。

---

## 一、用户最低运行要求

纯 `pip install khy-os` 的用户，只需满足下面这些就能启动。

### 1.1 软件门槛

| 项目 | 要求 | 说明 / 权威源 |
| --- | --- | --- |
| Python | `>= 3.8` | pip 安装门槛，权威源 `pyproject.toml` 的 `requires-python` |
| Node.js | `>= 20` | 后端运行时硬性 engines 约束，权威源 `services/backend/package.json`。**缺失时会自动下载便携版**（见下） |
| npm | PATH 中可用 | 首次启动用它安装后端依赖 |

> **Node 缺失会自动补齐**：如果系统没有 Node ≥ 20，启动器会自动下载便携版
> **Node 22.12.0** 到 `~/.khyquant/node`（Windows 为 `%LOCALAPPDATA%\khy\node`，回退
> `~/.khyquant/node`），不污染系统全局环境。
> - 想换版本：设置 `KHY_NODE_VERSION=22.12.0`（取你需要的版本号）。
> - 想禁用自动下载（例如离线、受控环境）：设置 `KHY_AUTO_INSTALL_NODE=0`，
>   此时你需要自己事先装好 Node ≥ 20。

### 1.2 硬件与网络

| 项目 | 建议 | 说明 |
| --- | --- | --- |
| 磁盘空间 | 预留 ≥ 2 GB | 后端 `node_modules` 依赖 + 便携 Node + 缓存。仅核心运行约数百 MB，留余量更稳 |
| 内存 | ≥ 2 GB 可用 | 仅运行 KHY 后端 / 网关足够；**本地大模型推理另算**（见下） |
| 网络 | **首次启动需联网** | 首启会 `npm install` 拉取后端依赖、并可能自动下载便携 Node。装好后日常使用可离线（云端 AI 除外） |

> **本地模型推理的额外要求**（可选，仅当你用 Ollama / llama.cpp 跑本地模型时）：
> 内存 / 显存随模型大小而定，`>= 8B` 的模型建议用 GPU（NVIDIA CUDA 或 Apple M 系列）。
> 仅用云端 AI（如配置 API Key 走在线服务商）则无此要求。详见 [OPS-MAN-024] 本地模型一节。

### 1.3 系统软件包

按平台准备以下基础工具（多数系统已自带）：

**Linux**

```bash
# Debian / Ubuntu
sudo apt-get install -y git curl ca-certificates
```

- `git`、`curl`、`ca-certificates`

**macOS**

```bash
# 需要先装 Homebrew：https://brew.sh
brew install node python git
```

- 系统通常已自带 `git` / `curl`；用 Homebrew 一并补齐 Node 与 Python 更省心。

**Windows**

- 推荐用官方安装包或包管理器装好 Python（≥ 3.8）与 Node（≥ 20）；
  `git` / `curl` 可选（Node 缺失时启动器仍会自动下载便携版）。

### 1.4 启动检查

```bash
khy doctor
khy gateway status
```

**通过的样子（成功判据）**：

- `khy doctor` 末尾给出汇总，关键项显示 `[ OK ]`（Node ≥ 20、依赖已装、端口可用）；
  若有 `[FAIL]` 会附可直接粘贴的修复命令。
- `khy gateway status` 列出已配置的服务商及其在线状态；**装完默认还没配 key 属正常**，
  配置见 [OPS-MAN-023] / [OPS-MAN-024]。

> 想要一条更早、不触发 Node 后端的体检：`khy preflight`（别名 `khy precheck`）。
> 区别见 [OPS-MAN-043] 阶段 0：`preflight` 只体检并给你粘贴命令，`doctor` 会尝试替你动手修。

### 1.5 npm 引导模式（可选）

- 默认 npm 引导使用精简模式（`--omit=optional`）。
- 如需包含可选的重量级依赖，请设置：
  - `KHY_NPM_INCLUDE_OPTIONAL=true`

---

## 二、维护 / 构建要求（面向维护者，普通用户可跳过）

只有在你要**自己打 wheel 发布**或**构建自研内核镜像**时才需要本节。

### 2.1 打包约束

- pip 分发硬性上限：`<= 1000000000 bytes`（即 ≤ 1 GB）。

### 2.2 VMware 镜像构建要求（可选）

- root 权限（`sudo`）
- `parted`、`losetup`、`rsync`、`grub-install`、`mkfs.vfat`、`mkfs.ext4`
- 可选的 VMDK 导出：`qemu-img`

快速检查：

```bash
bash scripts/khytogo/make-khytogo.sh --mode vmware-plan
```

> 注意：`scripts/khytogo/` 属**源码树**脚本。纯 `pip install` 的用户安装目录里没有它——
> 先 `khy restore`（还原可读源码树）或 `git clone` 仓库后，再在源码树根目录执行。
