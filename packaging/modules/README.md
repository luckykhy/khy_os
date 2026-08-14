# Khy OS 模块化打包

## 概述

Khy OS 支持将各功能模块独立打包为跨平台可执行文件，同时保留组合为完整系统的能力。

## 模块列表

| 模块 | 可执行文件 | 说明 |
|------|-----------|------|
| khy-ai | khy-ai.exe | AI 聊天 REPL，支持多模型对话 |
| khy-gateway | khy-gateway.exe | AI 网关服务，统一多供应商 API |
| khy-quant | khy-quant.exe | 量化交易工具（回测、数据、训练） |
| khy-server | khy-server.exe | Web 管理后台 + 前端 UI |
| khy-tools | khy-tools.exe | 开发者工具集（部署、CI、插件开发） |
| khy | khy.exe | 完整平台（所有模块组合） |

## 构建

### 快速构建（当前平台）

```bash
# 构建所有模块
node packaging/build/build-all.js

# 构建单个模块
node packaging/build/build-all.js --module khy-ai

# 生产模式（压缩）
node packaging/build/build-all.js --prod
```

### 跨平台构建

```bash
# 构建指定平台
node packaging/build/build-all.js --platform win-x64

# 构建所有平台
node packaging/build/build-all.js --all-platforms

# 仅 esbuild 捆绑（不打包为 exe）
node packaging/build/build-all.js --bundle-only
```

### 使用 khy 命令

```bash
khy modules list          # 查看所有模块
khy modules info khy-ai   # 查看模块详情
khy modules build khy-ai  # 构建模块
```

## 目录结构

```
packaging/
├── modules/
│   ├── modules.json         # 模块定义（单一真源）
│   ├── entries/             # 模块独立入口文件
│   │   ├── khy-ai-entry.js
│   │   ├── khy-gateway-entry.js
│   │   ├── khy-quant-entry.js
│   │   ├── khy-server-entry.js
│   │   ├── khy-tools-entry.js
│   │   └── khy-full-entry.js
│   ├── runtime/             # 运行时支持
│   │   ├── modeDetector.js  # 模式检测
│   │   └── moduleProxy.js   # 跨模块调用代理
│   └── README.md            # 本文件
└── build/
    ├── esbuild-modules.js   # 多目标 esbuild 构建
    ├── pack-executable.js   # pkg 打包脚本
    ├── build-all.js         # 统一构建入口
    ├── verify-executable.js # 可执行文件验证
    ├── dependency-map.json  # 依赖分组映射
    └── native-modules.json  # 原生模块配置
```

## 构建产物

```
dist/
├── modules/              # esbuild 捆绑输出
│   ├── khy-ai/
│   │   ├── bundle.cjs
│   │   └── meta.json
│   ├── khy-gateway/
│   │   └── ...
│   └── ...
└── executables/          # pkg 可执行文件输出
    ├── win-x64/
    │   ├── khy-ai.exe
    │   ├── khy-gateway.exe
    │   └── ...
    ├── linux-x64/
    │   └── ...
    ├── macos-x64/
    │   └── ...
    └── macos-arm64/
        └── ...
```

## 运行模式

### 独立模式（Standalone）
每个模块作为独立进程运行，通过环境变量标识：
- `KHY_MODULE=khy-ai` — 当前模块
- `KHY_MODE=standalone` — 独立模式

### 组合模式（Combined）
所有模块在同一进程内运行（默认行为），等同于 `khy` 完整命令：
- `KHY_MODULE=khy` 或未设置
- `KHY_MODE=combined` 或未设置

### 跨模块调用
独立模式下需要调用其他模块功能时，通过 `moduleProxy.js` 透明代理：
- 组合模式：直接 require() 进程内调用
- 独立模式：spawn 目标模块可执行文件

## 添加新模块

1. 在 `modules.json` 中定义新模块
2. 在 `entries/` 中创建入口文件
3. 运行 `node packaging/build/build-all.js --module <new-id>` 验证构建

## 技术栈

- **esbuild** — JavaScript 捆绑（tree-shaking + minification）
- **pkg** — Node.js 应用打包为独立可执行文件
- **Node.js 20+** — 运行时目标
