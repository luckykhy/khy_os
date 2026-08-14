# KHY-Quant pip 打包说明

## 安装方式

```bash
# 独立安装
pip install khy-quant

# 作为 khy-os 插件安装
pip install khy-os[quant]

# 带数据分析依赖
pip install khy-quant[data]

# 带机器学习依赖
pip install khy-quant[ml]

# 全部可选依赖
pip install khy-quant[full]
```

## pip 包中包含的文件

安装后源码齐全，用户可直接阅读和学习。

| 目录 | 内容 | 说明 |
|------|------|------|
| `services/` | 43 个 JS 服务 + 5 个 Python 数据源脚本 | 数据源、行情、策略、交易、回测引擎 |
| `routes/` | 20 个 Express 路由 | REST API 端点 |
| `models/` | 11 个 Sequelize 模型 | 数据库表定义 |
| `controllers/` | 3 个控制器 | 行情、综合数据、合约管理 |
| `indicators/` | 技术指标计算 | benchmark、fastIndicators |
| `handlers/` | CLI 数据处理 | data.js 命令处理器 |
| `middleware/` | 认证中间件 shim | 转发到 @khy/shared |
| `config/` | 配置 shim | 数据库、参考价格 |
| `utils/` | 工具 shim | 日志、Python 路径 |
| `tools/` | 平台工具 | platformUtils |
| `ml/` | ML 训练脚本 | *.py、*.yaml 训练管道 |
| `frontend/dist/` | 前端构建产物 | Vue.js 交易界面（可选） |
| `frontend/src/` | 前端源码 | Vue 组件源码（供学习） |
| `backend/` | 平台后端 | Express 服务器、CLI、AI 网关 |
| `packages/shared/` | @khy/shared | 共享模型、中间件、工具 |

## pip 打包时排除的文件

以下文件/目录**不会**进入 pip 包，需要在运行时自动生成或按需下载：

| 排除项 | 原因 |
|--------|------|
| `node_modules/` | npm 依赖，首次运行时 `npm install` 自动安装 |
| `frontend/android/` | Android 构建产物（Capacitor），仅移动端开发需要 |
| `frontend/android-sdk/` | Android SDK，仅移动端开发需要 |
| `ml/models/` | 训练好的模型文件（*.joblib），体积大，按需训练 |
| `ml/data/` | ML 训练数据集，体积大，按需下载 |
| `backend/data/` | 运行时数据目录，启动后自动创建 |
| `backend/logs/` | 日志文件，运行时生成 |
| `backend/temp/` | 临时文件目录 |
| `*.db` / `*.sqlite*` | 数据库文件，首次运行 seed 脚本自动创建 |
| `*.log` | 日志文件 |
| `*.joblib` | 序列化模型文件 |
| `.env` / `.env.local` | 环境配置，首次运行自动生成（含随机 JWT 密钥） |
| `*.iso` / `*.img` | 系统镜像文件 |
| `*.gguf` / `*.safetensors` | LLM 模型权重文件 |
| `*.so` / `*.dylib` | 原生共享库，按平台编译 |
| `llama-cpp/` / `ollama-runner/` | 本地推理引擎二进制，按需下载 |
| `__pycache__/` | Python 字节码缓存 |
| `.git/` | 版本控制目录 |

## 首次运行自动初始化

`pip install` 后首次运行 `khyquant`，bootstrap 会自动完成：

1. **npm install** — 安装 Node.js 依赖（约 2-5 分钟）
2. **生成 .env** — 自动生成随机 JWT 密钥和默认配置
3. **初始化数据库** — 运行 seed 脚本创建表和基础数据（SQLite 零配置）
4. **注册应用** — 写入 `~/.khyquant/apps/khyquant.json`

后续启动会跳过已完成的步骤。

## 源码可读性保证

本包固定为**非混淆模式**打包：
- 全部 JS 源码保持原始可读格式
- 全部 Python 源码保留（.pyc 仅为加速，不删除 .py）
- 前端 Vue 组件源码包含（frontend/src/）
- 注释和文档字符串完整保留

## 与 khy-os 的关系

```
pip install khy-os          # 平台（已内置 khyquant）
pip install khy-os[quant]   # 平台 + 独立量化包（可升级）
pip install khy-quant       # 仅量化应用（自带精简后端）
```

当 khy-os 和 khy-quant 同时安装时，khy-quant 的 CLI 优先使用 khy-os 的后端，
避免重复。
