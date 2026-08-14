<!-- 文档分类: OPS-MAN-007 | 阶段: 运维 | 原路径: docs/指南/cli-万能接入-集成指南.md -->
# KHY OS × CLI-Anything 集成指南

## 概述

CLI-Anything 是一个生态系统，可将任意专业软件转化为 AI agent 可控制的 CLI 工具，并输出结构化 JSON。KHY OS 原生集成了该能力，使用户可以：

- **搜索** CLI-Anything 注册表中的可用工具
- 通过单条命令**安装** CLI 工具
- 借助 7 阶段 AI 流水线为任意软件**生成**新的 CLI 封装
- 在 AI 对话中无缝**使用**已安装的工具

## 快速开始

### 搜索可用工具

```bash
khy app cli-search blender
khy app cli-search gimp
khy app cli-search ffmpeg
```

### 安装工具

```bash
khy app cli-install blender
```

安装完成后，该工具会自动注册为 KHY app、tool 和 skill。

### 列出已安装的工具

```bash
khy app cli-list
```

### 直接调用工具

```bash
khy app cli-invoke blender render --scene myscene.blend --json
khy app cli-invoke gimp export --file image.xcf --format png --json
```

### 同步注册表

```bash
khy app cli-sync
```

强制刷新注册表缓存，重新发现已安装的 CLI，并更新 KHY 注册信息。

## 生成新的 CLI 工具

对于任何尚无 CLI-Anything 封装的软件，KHY 都可以为其生成一个：

### Python CLI（默认）

```bash
khy app cli-gen https://github.com/user/my-software
khy app cli-gen /path/to/local/software
```

### Node.js CLI

```bash
khy app cli-gen https://github.com/user/my-software --runtime node
```

### 7 阶段流水线

生成过程遵循 7 个阶段：

| 阶段 | 名称 | 描述 |
|-------|------|-------------|
| 0 | Source Acquisition | 克隆仓库或校验本地路径 |
| 1 | Codebase Analysis | AI 分析软件能力 → SOP.md |
| 2 | Architecture Design | 设计命令分组、状态模型、输出格式 |
| 3 | Implementation | 生成 CLI 代码（Click/Commander） |
| 4 | Test Planning | 编写带场景的 TEST.md |
| 5 | Test Implementation | 生成测试代码 |
| 6 | Documentation | 运行测试 + 生成 SKILL.md |
| 7 | Packaging | setup.py/package.json + 安装 + KHY 注册 |

该流水线支持检查点——若中断，会从最后一个已完成的阶段恢复。

## 架构

```
┌────────────────────────────────────────────────┐
│  KHY OS CLI                                    │
│  khy app cli-gen/search/install/list/sync      │
├────────────────────────────────────────────────┤
│  cliAnythingService.js  (bridge)               │
│  ┌───────────┐ ┌──────────┐ ┌───────────────┐ │
│  │ Registry   │ │ Discovery│ │ Registration  │ │
│  │ CDN+cache  │ │ PATH     │ │ tool+skill+app│ │
│  └───────────┘ └──────────┘ └───────────────┘ │
├────────────────────────────────────────────────┤
│  cliAnythingGenerator.js  (7-stage pipeline)   │
├────────────────────────────────────────────────┤
│  CLIAnythingTool.js       SKILL.md → manifest  │
│  (BaseTool wrapper)       (auto-convert)       │
└────────────────────────────────────────────────┘
         ↕ subprocess --json
┌────────────────────────────────────────────────┐
│  cli-anything-* CLIs on PATH                   │
│  cli-anything-blender, cli-anything-gimp, ...  │
└────────────────────────────────────────────────┘
```

### 自动注册

当某个 `cli-anything-*` 工具被安装时，KHY OS 会自动：

1. **注册为 App** —— 使用 `appRegistry.register()`，并设置 `runtime: 'external'`
2. **注册为 Tool** —— 通过 `defineTool()` 创建供 AI 使用的 `cli_anything__<name>` 工具
3. **转换 SKILL.md** —— 在 `~/.khy/skills/cli-anything-<name>/` 生成 `manifest.json` + `prompt.md`

### 在 AI 对话中使用

注册完成后，AI 可以自动发现并使用 CLI 工具：

> 用户："用 Blender 渲染这个场景"
> AI：[以 `render` 命令调用 `cli_anything__blender` 工具]

### 注册表来源

| 来源 | URL | 描述 |
|--------|-----|-------------|
| Harness | `hkuds.github.io/CLI-Anything/registry.json` | 官方 CLI-Anything 注册表 |
| Public | `hkuds.github.io/CLI-Anything/public_registry.json` | 社区贡献的工具 |
| Local | PATH scan for `cli-anything-*` | 本地已安装但不在注册表中 |

## 中文别名

| 别名 | 命令 |
|-------|---------|
| `cli生成` | `khy app cli-gen` |
| `cli搜索` | `khy app cli-search` |
| `cli安装` | `khy app cli-install` |
| `cli列表` | `khy app cli-list` |
| `cli卸载` | `khy app cli-uninstall` |
| `cli调用` | `khy app cli-invoke` |
| `cli同步` | `khy app cli-sync` |
| `软件接入` | `khy app cli-gen` |
| `工具生成` | `khy app cli-gen` |
| `agent工具` | `khy app cli-list` |

## 文件位置

| 路径 | 描述 |
|------|-------------|
| `~/.khy/cli-anything/registry.json` | 缓存的 harness 注册表 |
| `~/.khy/cli-anything/public_registry.json` | 缓存的 public 注册表 |
| `~/.khy/cli-anything/installed.json` | 已发现的已安装 CLI |
| `~/.khy/cli-anything/generated/<SOFTWARE>/` | AI 生成的 CLI 输出 |
| `~/.khy/skills/cli-anything-<name>/` | 转换后的 KHY skills |

## 为注册表做贡献

要将你生成的 CLI 添加到 public 注册表：

1. 在本地生成并测试你的 CLI
2. 发布到 PyPI 或 npm
3. 向 `github.com/HKUDS/CLI-Anything` 提交 PR，在 `public_registry.json` 中加入你工具的条目
