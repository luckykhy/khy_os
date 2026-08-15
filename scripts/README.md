# scripts/ — 项目管理与自动化脚本

本目录集中存放 khy OS 仓库的**维护、构建、发布与工程化脚本**。
业务运行时代码不在此处（它们在 `services/`、`kernel/`、`software/`、`apps/` 各自的模块目录内）。

## 目录分类

| 子目录 | 用途 |
|--------|------|
| `admin/` | 管理员辅助：账号/凭据创建、重置、修复 |
| `alpine/` | Alpine Linux ISO 构建（Docker / Windows） |
| `bench/` | 性能基准与 A/B 对比实验 |
| `ci/` | CI 与工程规则检查：agent 规则、版本同步、模式契约、模式注册表 |
| `diagnostics/` | 诊断与模糊测试工具 |
| `docs/` | 文档站构建、校验、PDF 导出 |
| `install/` | 安装/部署：CLI 安装、git hooks、链接 shared 包、环境校验 |
| `khytogo/` | khytogo 便携发行构建 |
| `lib/` | 脚本共享库（restore/check 等公共模块） |
| `maintenance/` | 日常维护：体积精简（slim-down.bat/.sh）等 |
| `moonbit/` | MoonBit/WASM 指标测试 |
| `portable/` | 便携化：USB 构建、数据迁移、路径包装、自修复 |
| `qoder-bridge/` | Qoder 桥接（自启脚本 + 日志） |
| `release/` | 发布：pip/npm 构建、双通道发布、门禁与版本工具 |
| `restore/` | 恢复子系统各阶段脚本 |
| `setup/` | 一次性上手脚本：注册全局命令、起后端/前端、建默认管理员、网关诊断（原散落在根目录） |
| `sync/` | 两台电脑间离线代码同步：git bundle 导出/导入（`export-sync` / `import-sync`） |
| `tests/` | 上述脚本的单元测试（对应 `lib/` 模块） |

## 使用约定

- **入口脚本**：CLI 启动器 `khy.bat` / `khy.sh` 放根目录（供 PATH 全局调用）；便携化启动
  `run.ps1` / `run-portable.bat` / `run-portable.sh` 归入 `portable/`；
  **只跑一次的装机/救急脚本**归入 `setup/`（见 `setup/README.md` 的「何时跑哪个」表）。
- **新增脚本**按上述主题放入对应子目录；不建一次性散落目录。
- **跨平台**：新增批处理类脚本应同时提供 `.bat` 与 `.sh` 配对（参照 `install-path-wrappers`、`slim-down`）。
- **共享逻辑**写入 `lib/`，脚本主体保持薄壳。
- **运行时产物**（`__pycache__`、`logs/`、`ab-traces/` 等）不入库，随运行产生。

## 常用入口

```bash
# 体积精简（Win）
scripts/maintenance/slim-down.bat
# 体积精简（Linux/macOS）
bash scripts/maintenance/slim-down.sh
# 版本同步校验
node scripts/ci/check-version-sync.js
# agent 规则检查
node scripts/ci/check-agent-rules.js --changed
# 导出本机代码为离线 bundle（本机 AI 数据 .khy/、.env 等被 gitignore，不会混入）
scripts/sync/export-sync.bat            # 或 bash scripts/sync/export-sync.sh
# 在另一台电脑导入对方 bundle
scripts/sync/import-sync.bat --bundle <导出的.bundle>
```

## 两台电脑同步（scripts/sync/）

场景：两台电脑各装不同 AI，代码需保持一致，但**各自的 AI 数据必须隔离**。
方案：git bundle 离线包（无需网络/账号）。本机数据（`.khy/`、`.env`、
`config.json` 等）已被 `.gitignore` 排除，永远不会进入 bundle。

```bash
# 电脑 A：提交本机变更并导出 bundle（输出到 <项目根>\..\khy-sync\）
scripts/sync/export-sync.bat
# 将 .bundle 文件通过 U 盘/网盘等离线方式传给电脑 B

# 电脑 B：导入（默认切到对方分支；--merge 则合并到当前分支）
scripts/sync/import-sync.bat --bundle <路径>\khy-sync-xxx.bundle
# 反向同步同理：B 导出 → A 导入
```

注意事项：
- `export-sync.bat` 默认会 `git add -A` + 提交本机变更后再导出；
  `--no-commit` 可跳过提交。
- 若导入机存在与 bundle 冲突的 untracked 文件，git 会拒绝切换（保护本地文件）。
  按提示备份/移走冲突文件，或 `git clean -fd` 后重试。
- 若本机已存在同名分支，导入会切到该分支并合并 bundle 变更（等效于 pull）。
