# scripts/setup/ — 一次性上手脚本

本目录收容**只在装机/首次配置/救急时跑一次**的 Windows 脚本。
它们原先散落在仓库根目录，2026-08-15 按
`docs/08_MGMT_项目管理/[MGMT-STD-001] 项目文档结构与索引铁律规范.md` 第一章
（根目录零散落）搬入此处。

**真正的日常入口不在这里**，仍在根目录：`khy.bat` / `khy.sh`（CLI 启动器）、
`khy-cli.bat`、`portable-setup.bat` / `portable-setup.sh`（注册全局 `khy` 命令）、
`install-khy.ps1`。本目录的脚本都是它们的补充或救急手段。

## 何时跑哪个

| 脚本 | 什么时候跑 | 它做什么 |
| --- | --- | --- |
| `setup-khy.bat` | 想注册全局 `khy` 命令，但记不住根目录脚本名 | 薄壳，直接转发到根目录 `portable-setup.bat`（参数原样传递） |
| `setup-khy-command.ps1` | 只想在 **PowerShell** 里有 `khy`，不改 PATH | 往 `$PROFILE` 追加一个 `khy` 函数 + `khyos` 别名；入口路径从脚本自身位置解析 |
| `start-backend.bat` | 需要后端 API / Web 登录 / 数据库，但不需要前端界面 | 在 `services/backend` 跑 `npm run dev`（当前窗口，Ctrl+C 停止） |
| `start-all.bat` | 需要完整 Web 管理界面 | 另开两个窗口分别起后端（:5000）与前端（:3000） |
| `first-time-setup.bat` | Web 端登录不上、想显式建一次默认管理员 | 在 `services/backend` 跑 `node scripts/quick-setup.js` |
| `diagnose-gateway.bat` | `/model` 里没有模型、或 `gateway status` 结果不符预期 | 逐项打印 `claude` 命令、Node 版本、Claude 适配器探测结果、Anthropic 环境变量、全部适配器的 enabled/available |
| `fix-model-menu.bat` | `/model` 菜单卡很久才出来 | 备份 `services/backend/.env`，追加 `KHY_MODEL_QUICK_FAIL` 等 5 个激进超时开关 |

## 前提与注意

- **只用 CLI 时，这些脚本一个都不需要跑。** CLI 的自动登录不依赖后端，凭据在本机现场生成，
  见 `docs/07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md`。
  需要 Web 界面登录、注册新用户或访问数据库时才必须起后端。
- 起后端前先装依赖：`npm install`（仓库根，npm workspaces 会一并装 `services/backend`）。
- **路径解析**：每个脚本都从自身位置（`%~dp0..\..` / `$PSScriptRoot\..\..`）解析仓库根，
  可从任意工作目录调用，也支持仓库整体移动到其他盘符。新增脚本请沿用这一写法，
  不要硬编码绝对路径（工程规则 1：零硬编码，见 `AGENTS.md`）。
- `fix-model-menu.bat` 会**写入** `.env`（先备份为 `.env.backup.<日期>`）。
  `.env` 已 gitignore，不会入库；红线 R2 要求真实 key/token 永不进提交。
- 诊断脚本只读不写，可随时重复运行。

## 相关文档

- 便携启动的三种档位对比：`docs/06_DEPLOY_部署/PORTABLE.md`
- 模型可用性与适配器探测（`enabled` ≠ `available`）：`docs/06_DEPLOY_部署/[DEPLOY-MAN-019] 模型可用性与适配器探测.md`
- API Key 与供应商配置：`docs/06_DEPLOY_部署/[DEPLOY-MAN-020] AI供应商与APIKey配置.md`
- IDE 桥接：`docs/06_DEPLOY_部署/[DEPLOY-MAN-021] IDE桥接模式.md`
- 首次运行自动登录与凭据：`docs/07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md`
