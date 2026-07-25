# Khy-OS 便携化使用指南

## 快速开始

3 步启动：
1. 将整个 khy-os 文件夹复制到目标机器
2. 确保系统已安装 Python 3.8+ 和 Node.js 20+
3. 启动：
   - Windows: 双击 `khy.bat`
   - Linux/macOS: 运行 `./khy.sh`

## 前置条件

- Python 3.8 或更高版本
- Node.js 20 或更高版本
- 首次启动需要网络连接（自动运行 `npm install` 安装 Node.js 依赖）

下载链接：
- Python: https://www.python.org/downloads/
- Node.js: https://nodejs.org/

## 构建便携副本

使用项目根目录的便携构建脚本，可将 Khy-OS 复制到任意目录（U盘、移动硬盘等），生成可独立运行的便携版本：

Windows:
```
run-portable.bat --target D:\Portable
```

Linux/macOS:
```
bash run-portable.sh --target /mnt/usb/khy-os
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--target`, `-t <dir>` | 目标目录（必填） |
| `--with-node-modules` | 包含 `services/backend/node_modules`，实现复制即用（无需首次 npm install） |
| `--mirror` | 镜像模式：删除目标中源不存在的多余文件 |
| `--dry-run` | 仅预览，不实际复制 |

### 使用示例

```
# 基本复制（首次启动自动安装 node 依赖）
run-portable.bat --target D:\Portable

# 包含 node_modules，复制后立即可用
run-portable.bat --target E:\khy-os --with-node-modules

# 镜像同步（源目录有删除时，目标也同步删除）
run-portable.bat --target D:\Portable --mirror --with-node-modules

# 预览模式（只看不做）
run-portable.bat --target D:\Portable --dry-run
```

### 排除规则

以下目录默认排除（不影响运行）：
- `.git` — 版本控制历史
- `node_modules` — 可通过 npm install 重新生成（`--with-node-modules` 时保留 `services/backend/node_modules`）
- `__pycache__` — Python 缓存
- `.tmp` — 临时文件
- `dist` — 构建产物

### 便携副本目录结构

```
D:\Portable\
├── khy.bat              ← 双击启动
├── khy.sh               ← Linux/macOS 启动
├── portable.md           ← 本文件
├── software/khyquant/    ← Python CLI
├── services/backend/     ← Node.js 后端
└── .khyquant-data/       ← 运行时自动生成
```

复制完成后，便携副本与原项目完全独立——修改任一方不会影响另一方。

## 保持便携版最新

便携版构建完成后，后续无需重新构建：在开发版里用一键同步命令，把最新代码增量同步过去。

```
# REPL 内（或别名：便携同步 / portable-sync / 同步便携版）
khy portable sync

# 先预览（零副作用）
khy portable sync --dry-run

# 不进 REPL 的快捷方式
node scripts/portable-sync.js --dry-run

# 查看上次同步记录与依赖新旧（别名：便携状态）
khy portable status
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--target <dir>` | 目标便携版根目录（默认见下方 KHY_PORTABLE_ROOT） |
| `--dry-run` | 只打印同步计划，不做任何修改 |
| `--mirror` | 镜像模式：删除目标多余文件（保护目录除外，执行前列清单并确认） |
| `--with-node-modules` | 强制镜像 `services/backend/node_modules` |
| `--skip-node-modules` | 跳过依赖检查与镜像 |
| `--skip-check` | 跳过源码入口 `node --check` 健康检查（不推荐） |
| `--yes` | 跳过 `--mirror` 的删除确认 |

工作方式：按 size+mtime（2 秒容差）增量比对，只复制有变化的文件；`services/backend/package-lock.json` 两侧 SHA256 一致时自动跳过 node_modules（不一致时 Windows 用 robocopy 镜像提速）。

### 默认目标与环境变量

默认目标目录由环境变量 `KHY_PORTABLE_ROOT` 覆盖；未设置时 Windows 使用内置默认（见 `services/backend/src/constants/serviceDefaults.js` 的 `PORTABLE_ROOT_DEFAULT`），非 Windows 无默认，必须显式 `--target`。

### 目标侧保护目录

以下便携版本地数据在任何模式下（含 `--mirror`）都不会被写入或删除：

- `.khyquant-data/`、`.khy/`、`.khy-Trajectory/` — 运行时数据
- `logs/`、`*_history/` — 日志与历史
- `.env`、`.env.local` — 本地环境配置
- `node_modules/` — 仅由 package-lock 哈希门控独立镜像

同步完成后目标根目录会写入 `.sync-manifest.json`（时间戳、来源、计数、lock 哈希），供 `khy portable status` 读取。

注：pip 打包分发形态下 `scripts/portable-sync.js` 不随包分发、不可用，此形态请直接使用 `khy portable sync`。

注：旧的 `khy sync` 文件监听（watcher）模式已被本一键同步命令取代，仅保留兼容入口：`khy sync start / stop` 只打印取代提示不再启动监听；`khy sync once` 仍可用且与本命令共用同一引擎。

## 两种使用方式

### 方式一：双击启动

直接双击项目根目录的启动脚本，适合临时使用：
- Windows: `khy.bat`
- Linux/macOS: `./khy.sh`

### 方式二：加入 PATH（推荐）

安装 PATH 包装器后，可在任意目录使用 `khy` 命令：

Windows:
```
scripts\portable\install-path-wrappers.bat
```

Linux/macOS:
```
bash scripts/portable/install-path-wrappers.sh
```

安装后直接输入 `khy` 即可使用。

## 数据存储

便携模式下，所有应用数据存储在项目根目录的 `.khyquant-data/` 文件夹中：
- `.khyquant-data/data/` — 数据文件
- `.khyquant-data/cache/` — 缓存
- `.khyquant-data/models/` — 模型文件
- `.khyquant-data/logs/` — 日志
- `.khyquant-data/apps/` — 应用注册信息

如需自定义数据目录位置，在启动前设置环境变量 `KHYQUANT_DATA_HOME`。

## 与 pip install 的区别

| 特性 | pip install | 便携模式 |
|------|-------------|----------|
| 安装方式 | `pip install khy-os` | 复制文件夹 |
| 数据位置 | `~/.khyquant/` | 项目内 `.khyquant-data/` |
| 全局命令 | 自动注册 | 需手动安装 PATH 包装器 |
| 多版本共存 | 困难 | 可多文件夹并存 |
| 适用场景 | 固定开发环境 | U盘/移动办公/多机器 |

## 故障排除

### Python 未找到

错误：`检测 Python 3.8+ 失败`

解决方案：
1. 确认 Python 已安装：`python --version`
2. 确认 Python 已加入系统 PATH
3. Windows 用户可从 Microsoft Store 安装 Python

### Node.js 未找到

错误：`检测 Node.js 20+ 失败`

解决方案：
1. 确认 Node.js 已安装：`node --version`
2. 确认主版本号 >= 20
3. 下载最新 LTS 版本：https://nodejs.org/

### npm install 失败

首次启动时会自动运行 `npm install`，如果失败：
1. 检查网络连接
2. 中国大陆用户可能需要配置镜像源
3. 手动运行：`cd services/backend && npm install`

### native 模块错误

错误：`ERR_DLOPEN_FAILED`

解决方案：
1. 运行 `cd services/backend && npm rebuild`
2. 确保安装了 C++ 编译工具（Windows: Visual Studio Build Tools）

## 环境变量参考

| 变量名 | 用途 | 默认值 |
|--------|------|--------|
| `KHYQUANT_PORTABLE_ROOT` | 项目根目录（由启动脚本自动设置） | 脚本所在目录 |
| `KHYQUANT_DATA_HOME` | 数据存储目录 | `<项目根>/.khyquant-data` |

## 开发模式

便携模式完全保留开发能力：
- 可正常修改源码，改动即时生效
- 可运行 `npm install` 添加新依赖
- 可使用 `khy doctor` 诊断环境
- 与 `pip install -e`（editable mode）效果等价
