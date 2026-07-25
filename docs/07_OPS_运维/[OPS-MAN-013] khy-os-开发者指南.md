<!-- 文档分类: OPS-MAN-013 | 阶段: 运维 | 原路径: docs/指南/khy-os-开发者指南.md -->
# KHY OS 开发文档（中文）

本文档面向参与 KHY OS 代码维护、功能开发、打包发布的开发者。

## 1. 项目结构与职责

```text
Khy-OS/
├─ platform/                    # 平台层
│  ├─ khy_platform/             # Python 入口层（CLI 启动器）
│  └─ packages/shared/          # 共享模块
├─ services/                    # 后端服务（Node.js）
│  ├─ backend/                  # 核心运行时（CLI/服务/网关）
│  └─ ai-backend/               # AI 管理后端
├─ apps/ai-frontend/            # AI 管理前端（Vue）
├─ quant/khyquant/              # 默认内置应用（交易前端在 quant/khyquant/frontend/）
├─ kernel/                      # 操作系统构建树（alpine/boot/iso/moonbit/src）
├─ docs/                        # 文档
└─ scripts/                     # 构建、检查、发布脚本
```

核心调用链：

`khy` -> `platform/khy_platform/cli.py` -> `services/backend/bin/khy.js` -> `services/backend/src/cli/router.js`

## 2. 本地开发环境要求

- Python `>=3.8`
- Node.js `>=18`
- npm 可用

建议先执行：

```bash
python3 --version
node --version
npm --version
```

## 3. 开发环境初始化

### 3.1 安装 Python 依赖

```bash
python3 -m pip install -e ".[dev]" --config-settings editable_mode=compat
```

`--config-settings editable_mode=compat` 让 editable 安装以“扫描 `platform/` 目录”的方式解析 Python 包，而不是把每个包的绝对路径冻结进查找器。这样目录重构后通常无需重装，原因见 3.3。

### 3.2 安装 Node 依赖

```bash
npm install
npm --prefix quant/khyquant/frontend install
npm --prefix apps/ai-frontend install
```

说明：根目录 `npm install` 会安装 workspace（含 `services/backend`、`services/ai-backend`、`platform/packages/shared`），`quant/khyquant/frontend` 与 `apps/ai-frontend` 需单独安装。

### 3.3 editable 安装与重构韧性（重要）

`pip install -e .` 会记录 Python 包的物理位置。setuptools 默认的 “lenient” 模式把 `khy_platform`、`khy_os` 的**绝对路径冻结**进 `site-packages` 里的 `__editable__..._finder.py`。一旦目录重构移动了这两个目录，冻结的路径就失效，`khy` 会以 `ModuleNotFoundError: No module named 'khy_platform'` 启动失败。

本项目改用 **compat 模式**：安装时只写一行 `.pth` 指向 `platform/`，由 Python 在导入时扫描该目录。带来的韧性：

- 移动 `services/`、`apps/`、`quant/`、`kernel/`、`docs/` 等——只要不把两个 Python 包根目录移出 `platform/`——**无需重跑 editable 安装**。
- 在 `platform/` 下**新增**一个 Python 包，直接可导入，也无需重装。

唯一仍需重装的情况：把 `khy_platform` / `khy_os` 移出 `platform/`，或整体移动 `platform/`。此时执行：

```bash
npm run dev:install
# 等价于：python3 scripts/dev-install.py
```

`scripts/dev-install.py` 会自动定位 `khy` 命令背后的解释器（可用环境变量 `KHY_DEV_PYTHON` 覆盖），并以 compat 模式 `--force-reinstall` 重新生成安装。手动等价命令：

```bash
python3 -m pip install -e . --config-settings editable_mode=compat \
  --no-build-isolation --force-reinstall --no-deps
```

重构约束：**保持 `khy_platform` 与 `khy_os` 直接位于 `platform/` 下**，即可让绝大多数重构对 editable 安装零影响。

## 4. 常见开发启动方式

### 4.1 CLI 联调

```bash
python3 -m khy_platform.cli
# 或
khy
```

### 4.2 后端服务

```bash
npm --prefix services/backend run dev
# 或
npm --prefix services/backend start
```

### 4.3 交易前端

```bash
npm --prefix quant/khyquant/frontend run dev
```

### 4.4 AI 管理页（推荐走 CLI 管理会话）

```bash
khy gateway manage open --daemon
khy gateway manage status
```

如果本地前端 dev 服务不稳定，建议直接使用静态构建目录：

```bash
khy gateway manage open --daemon --frontend-dist-dir <apps/ai-frontend/dist 绝对路径>
```

## 5. CLI 命令开发规范（4 步）

新增命令时按以下顺序：

1. `services/backend/src/cli/commandSchema.js`：补充命令与子命令
2. `services/backend/src/cli/aliases.js`：补充中文/拼音/英文别名
3. `services/backend/src/cli/handlers/`：新增 handler
4. `services/backend/src/cli/router.js`：在 `route()` 中接入分发

新增命令后至少执行：

```bash
npm --prefix services/backend test
```

## 6. AI 适配器开发规范（2 步）

1. 在 `services/backend/src/services/gateway/adapters/` 新增 `yourAdapter.js`，实现统一 `generate(prompt, options)` 接口
2. 在 `services/backend/src/services/gateway/aiGateway.js` 注册适配器

## 7. 质量检查与测试

### 7.1 推荐最小检查集

```bash
npm run check:version-sync
npm run check:node-syntax
npm run check:python-syntax
npm run check:agent-rules
npm --prefix services/backend test
```

### 7.2 全量检查（仓库定义）

```bash
npm run check:quality-gates
./run_tests.sh
```

### 7.3 低级模型改动保护闸门（变更回归门禁）

为了避免低级模型在修 bug 或新增功能时引入新问题，`services/backend/src/services/changeRegressionGate.js`
实现了统一的变更回归门禁（Change Regression Gate，兼容旧文件 `bugfixRegressionGate.js`）。

优先配置键（新命名空间）：

- `KHY_CHANGE_REGRESSION_GATE`
- `KHY_CHANGE_LOW_TIER_ONLY`
- `KHY_CHANGE_GATE_INCLUDE_FEATURE`
- `KHY_CHANGE_MIN_REQUIRED_STEPS`
- `KHY_CHANGE_GATE_BASELINE`
- `KHY_CHANGE_GATE_FAIL_OPEN`
- `KHY_CHANGE_FAIL_ON_MISSING_REQUIRED_STEPS`

兼容配置键（旧命名空间）：

- `KHY_BUGFIX_*`（仅作回退，建议逐步迁移到 `KHY_CHANGE_*`）

建议最小验证：

```bash
npm --prefix services/backend test -- services/backend/tests/services/bugfixRegressionGate.test.js services/backend/tests/services/agenticHarnessService.test.js
```

## 8. 版本与发布流程

版本号必须三处一致：

1. `platform/khy_platform/__init__.py`
2. `pyproject.toml`
3. `services/backend/package.json`

发布前先校验：

```bash
npm run check:version-sync
```

构建与上传（标准 Python 流程）：

```bash
python3 -m build
python3 -m twine upload dist/*
```

也可使用内置发布命令：

```bash
khy publish check
khy publish build
khy publish self-pypi --version <x.y.z>
```

## 9. pip 打包边界与目录约束

为控制体积与保证 Windows 可安装性，pip 包遵循以下边界：

- 不打包大模型与重型产物：`*.gguf`、`*.safetensors`、`*.iso` 等
- 不打包依赖大目录：`services/backend/node_modules`、`quant/khyquant/frontend/node_modules`、`apps/ai-frontend/node_modules` 等

同时必须保留以下目录结构（目录存在即可，文件可为空）：

- `services/backend/models`
- `services/backend/ml/models`
- `apps/ai-frontend/node_modules`
- `platform/packages/shared/logs`

这些目录用于运行时路径兼容、日志挂载和模型占位，不代表需要打包真实大文件。

打包实现位于：`setup.py`

- 目录裁剪：`PRUNE_MODEL_DIRS`、`PRUNE_GENERATED_DIRS`
- 目录保留：`REQUIRED_EMPTY_DIRS`

## 10. 发布后验收清单（重点：Windows）

建议在干净环境执行一次：

1. `python -m pip install -U khy-os`
2. `khy --version`
3. `khy` 启动后确认 first-run setup 完成
4. `khy gateway status`
5. `khy guanli`（确认管理页可正确打开）

若出现 seed 警告，做 strict 验证：

```powershell
$env:KHY_SEED_STRICT="true"
node .\scripts\seed.js
$LASTEXITCODE
Remove-Item Env:KHY_SEED_STRICT
```

返回码 `0` 代表 seed 成功。

## 11. Windows 一键构建本地推理运行时并打包 Wheel

适用场景：希望 `khy-os` 在 Windows 上不依赖系统已安装 Ollama，也能使用本地推理（通过内置 `ollama.exe + lib/ollama`）。

### 11.1 输入来源

支持两种输入：

1. `ollama-main.zip`（Ollama 源码包，脚本会自动调用其 `build_windows.ps1` 编译）
2. 预编译运行时 zip（如 `Ollama.zip` / `ollama-windows-amd64.zip`），满足以下任一结构：
   - `<root>/ollama.exe` + `<root>/lib/ollama/*`
   - `<root>/dist/windows-amd64/ollama.exe` + `lib/ollama/*`

### 11.2 一键执行（CPU 最小可用）

在 Windows PowerShell（建议 Developer PowerShell for VS 2022）执行：

```powershell
cd <Khy-OS 根目录>
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-khy-wheel-with-ollama-runtime.ps1 `
  -OllamaSource "C:\path\ollama-main.zip" `
  -Arch amd64
```

该脚本会自动完成：

1. 若输入为源码：编译 Ollama Windows 运行时（`cpu, ollama`）
2. 若输入为预编译包：自动定位 `ollama.exe` 与 `lib/ollama`
3. 回填到 `services/backend/bin/ollama-runner/`：
   - `bin/ollama.exe`
   - `lib/ollama/*`
4. 调用 `scripts/release/build-platform-wheel.ps1` 生成平台 wheel

### 11.3 仅回填预编译包（不走源码编译）

如果你已经有 `Ollama.zip`（内含 `ollama.exe` 和 `lib/ollama`），可直接执行：

```powershell
cd <Khy-OS 根目录>
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-khy-wheel-with-ollama-runtime.ps1 `
  -OllamaSource "C:\path\Ollama.zip" `
  -Arch amd64
```

### 11.4 含依赖包（可选）

若需要同时生成运行时依赖（如 `vc_redist`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-khy-wheel-with-ollama-runtime.ps1 `
  -OllamaSource "C:\path\ollama-main.zip" `
  -Arch amd64 `
  -IncludeDeps
```

### 11.5 自定义 Ollama 构建步骤（可选）

示例：尝试包含 CUDA 构建步骤（环境不满足会在 Ollama 脚本阶段报错）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-khy-wheel-with-ollama-runtime.ps1 `
  -OllamaSource "C:\path\ollama-main.zip" `
  -Arch amd64 `
  -OllamaBuildSteps cpu,cuda12,cuda13,ollama
```

### 11.6 输出产物

- `dist/*.whl`（平台 wheel）
- `dist/*.tar.gz`（sdist）

建议检查 wheel 内是否包含：

- `khy_os/bundled/backend/bin/ollama-runner/bin/ollama.exe`
- `khy_os/bundled/backend/bin/ollama-runner/lib/ollama/*`

## 12. 本地推理运行时按需拉取（ollama / llama.cpp）

为控制仓库与 wheel 体积，两套本地推理二进制**不再提交到 git，也不随 pip 包分发**：

- `services/backend/bin/ollama-runner/`：`ollama` 多功能二进制 + `lib/ollama/*.so`
- `services/backend/bin/llama-cpp/llama-b9049/`：`llama-cli`/`llama-quantize`/`llama-server` 等 + 共享库

它们改为**首次使用时按平台从上游下载 + SHA256 校验 + 落到原路径**。打包侧早已排除二者（`setup.py` 的 `EXCLUDE_PATTERNS`、`MANIFEST.in` 的 `prune`），本机已取消 git 跟踪（`git rm -r --cached`，磁盘文件保留，开发机命中快速路径，无需重新下载）。

### 12.1 清单（数据驱动，零硬编码）

URL / 文件名 / SHA256 / 解压格式 / 子目录 / chmod 列表全部存于：

```
services/backend/config/runtime-binaries.json
```

`platforms` 中某平台为 `null`，或 `sha256` 为空，表示该平台**未固定**：运行时会**无声回退到系统已安装的二进制**，绝不报错中断。

### 12.2 触发方式

- 惰性（自动）：首次启动 ollama-runner（`localLLMService.startOllamaRunner`）或导入 gguf 模型（`modelImportService.importFromPath`）前自动调用 `runtimeProvisioner.ensureRuntime(name)`。
- 显式（手动预拉取 / 查看状态）：

```bash
khy runtime status            # 查看 present/missing + 平台来源 + 是否已固定 SHA256
khy runtime install           # 拉取全部运行时
khy runtime install llama-cpp # 仅拉取指定运行时
```

中文/拼音别名：`运行时`/`yunhangshi` → status；`安装运行时`/`runtimeinstall` → install。

### 12.3 镜像与代理（国内 / 隔离网络）

- `KHY_RUNTIME_MIRROR_BASE`：设置后，最终下载地址改为 `${KHY_RUNTIME_MIRROR_BASE}/${filename}`（同名文件走镜像）。
- `HTTPS_PROXY` / `HTTP_PROXY`：下载器（axios）自动识别，无需额外配置。

### 12.4 固定 SHA256（维护者，需 GitHub 网络）

清单出厂时 `sha256` 留空（安全回退）。维护者在可访问上游的环境执行 pin 脚本，下载各平台归档、计算并写回哈希：

```bash
node scripts/release/pin-runtime-binaries.js                 # 固定全部
node scripts/release/pin-runtime-binaries.js ollama-runner   # 固定单个
node scripts/release/pin-runtime-binaries.js --check         # 仅校验现有 pin，不写入（不符 exit 1）
node scripts/release/pin-runtime-binaries.js --verify-layout # 额外解压并确认 sentinel 子目录
```

该脚本同样识别 `KHY_RUNTIME_MIRROR_BASE` 与 `HTTPS_PROXY`。固定后提交清单即生效。

### 12.5 与第 11 节 Windows 构建的关系

第 11 节的 Windows 一键脚本仍可把编译好的 `ollama.exe + lib/ollama` 回填到同一 `services/backend/bin/ollama-runner/` 路径，用于**离线 wheel**场景。两条路径互补：按需拉取面向联网首次使用，Windows 构建面向预置离线包。

### 12.6 测试钩子

`runtimeProvisioner` 暴露 `KHY_RUNTIME_ROOT`（覆盖 backend 根）、`KHY_RUNTIME_MANIFEST`（覆盖清单路径）两个环境变量，并支持注入 `downloader` 形参，便于单测在临时目录中以真实 `tar` 解压、零网络验证（见 `services/backend/tests/services/runtimeProvisioner.test.js`）。

## 13. 相关文档

- `docs/07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md`
- `docs/05_TEST_测试/[TEST-RPT-002] khy-os-测试指南.md`
- `docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md`
- `docs/07_OPS_运维/[OPS-MAN-003] ai-管理-访问与登录.md`
- `docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md`
- `docs/06_DEPLOY_部署/[DEPLOY-MAN-011] pip-docker-打包部署.md`
