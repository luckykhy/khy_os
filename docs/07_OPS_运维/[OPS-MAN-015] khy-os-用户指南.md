<!-- 文档分类: OPS-MAN-015 | 阶段: 运维 | 原路径: docs/指南/khy-os-用户指南.md -->
# KHY OS 使用说明（完整版）

本文档面向安装与使用 `khy-os` 的用户，覆盖安装、升级、首次启动、管理页、常见故障排查。

版本说明：

- 本文为完整版（含管理页与网关相关运维说明）。
- 对外精简版（仅 CLI/安装/使用）见 `docs/07_OPS_运维/[OPS-MAN-014] khy-os-用户指南-仅cli.md`。

## 1. 命令入口

- 主命令：`khy`
- 兼容命令：`khyquant`、`khy-quant`、`khy-os`
- 推荐始终使用：`khy`

## 2. 安装与升级

### 2.1 新安装

```bash
python -m pip install -U khy-os
khy --version
```

Windows PowerShell 示例：

```powershell
python.exe -m pip install -U khy-os
khy --version
```

### 2.2 升级到最新版本

```bash
python -m pip install --upgrade khy-os
khy --version
```

### 2.3 可选依赖安装

```bash
python -m pip install -U "khy-os[data]"
python -m pip install -U "khy-os[ml]"
python -m pip install -U "khy-os[doc]"
python -m pip install -U "khy-os[full]"
```

说明：大模型权重/推理二进制（如 `.gguf`、`ollama` 运行时）不会打进 pip 包，需要按需另行安装。

## 3. 首次启动流程说明

第一次执行 `khy` 会自动触发初始化流程（first-run setup）：

1. 检查/安装 Node.js 依赖
2. 生成或复用 `.env`
3. 初始化数据库并执行 `seed`
4. 注册默认应用
5. 可选创建默认 `khy.md` 项目指令文件

初始化标记文件位于 backend 根目录：

- `.khy_quant_bootstrapped`
- `.khy_quant_seeded`

两者都存在时，后续启动会跳过初始化。

## 4. 常用命令速查

### 4.1 健康与环境

```bash
khy doctor
khy gateway status
khy db status
```

### 4.2 网关与模型

```bash
khy gateway status
khy gateway model
khy models list
khy models pull qwen2.5:7b
```

### 4.3 管理页

```bash
khy guanli
khy gateway manage open
khy gateway manage status
khy gateway manage stop
```

### 4.4 数据库

```bash
khy db init
khy db seed
khy db status
```

## 4.5 指令文件优先级

如果项目中同时存在多种 AI 协作指令文件，KHY 按以下优先级处理冲突：

1. `khy.md` / `KHY.md`
2. `CLAUDE.md` / `.claude/CLAUDE.md`
3. `AGENTS.md`

含义：

1. 当规则互相矛盾时，`khy` 指令优先级最高
2. `CLAUDE.md` 只在不与 `khy` 冲突时生效
3. `AGENTS.md` 作为兼容层，优先级最低

查看当前目录生效的 `khy` 指令文件：

```bash
khy /memory
```

## 5. Windows 管理页（`khyguanli`）正确打开方式

在 `khy` 交互终端内，以下输入等价：

- `khyguanli`
- `guanli`
- `aiguanli`

在系统 Shell 中推荐：

```bash
khy guanli
# 或
khy gateway manage open
```

打开逻辑：

1. 先探测主站管理页 `/admin/ai-gateway`
2. 主站不可用时自动回退到独立守护会话（daemon）
3. 输出 `http://127.0.0.1:9090/admin/ai-gateway` 及保活直链

如果你在 Windows 上输入网址后看到“不完整页面”或旧页面样式，优先执行：

```bash
khy gateway manage stop
khy gateway manage start --daemon
khy gateway manage open --daemon
```

若仍不稳定，显式指定静态前端目录（推荐）：

```bash
khy gateway manage open --daemon --frontend-dist-dir <apps/ai-frontend/dist 绝对路径>
```

登录默认账号：`admin / admin123`（历史安装兼容 `admin123.`）。

## 6. 首次启动出现 seed 警告怎么处理

常见提示：

- `Database seed did not confirm success`
- `Database seed not confirmed; will retry on next startup`

含义：启动未被中断，但 seed 没有被确认成功，系统会在下次启动自动重试。

建议做一次严格检查：

1. 定位 pip 安装的 backend 目录
2. 手动执行 strict seed

定位命令：

```bash
python -c "import pathlib,khy_platform;site=pathlib.Path(khy_platform.__file__).resolve().parent.parent;print(site/'khy_os'/'bundled'/'backend')"
```

Windows PowerShell 严格执行示例：

```powershell
cd <上一步输出路径>
$env:KHY_SEED_STRICT="true"
node .\scripts\seed.js
$LASTEXITCODE
Remove-Item Env:KHY_SEED_STRICT
```

- `0`：seed 成功
- `1`：seed 失败，按报错继续修复

## 7. 常见问题排查

### 7.1 Windows 出现 `The system cannot find the path specified.`

常见原因：某些 CLI 桥接通道（如 `claude`/`codex`）未安装或未在 PATH 中，探测阶段会报该错误。

先确认当前可用通道：

```bash
khy gateway status
```

如果你已选择可用通道（例如 `kiro`、`localLLM`）且对话正常，该提示可视为非致命探测噪音。

### 7.2 `khy gateway status` 显示通道不可用但你确认已登录

先做一次重测：

```bash
khy gateway status
```

再执行：

```bash
khy gateway manage stop
khy gateway manage start --daemon
khy gateway manage status
```

若仍异常，查看日志：

- `~/.khy/logs/ai_manage_daemon.log`
- `~/.khy/logs/ai_frontend_dev.log`

### 7.3 管理页可开但无法登录

- 先确认 CLI 是否已登录（可在 `khy` 内执行 `/login`）
- 如需重置管理员账号：

```bash
khy db seed
```

## 8. 关键配置与数据路径

常见路径（按系统不同可能有差异）：

- 新数据目录：`~/.khy/`
- 兼容数据目录：`~/.khyquant/`
- API Key 池：`~/.khyquant/api_keys.json`
- 代理配置：`~/.khyquant/proxy.json`
- 网关环境变量：`<backend>/.env`

建议先通过 `khy gateway status` 查看当前实际路径输出，再做修改。

## 9. 版本确认建议

每次升级后建议执行：

```bash
khy --version
khy doctor
khy gateway status
```

若你是 Windows 用户，建议额外验证一次：

```bash
khy guanli
```

确保管理页能正常打开再投入日常使用。

## 10. Git 发布（私有仓库）

目标：发布“完整版（内部）”文档与完整代码到私有仓库。

建议分支命名：

- `release/private-vX.Y.Z`

发布步骤：

1. 同步主线并创建私有发布分支

```bash
git fetch --all --prune
git checkout main
git pull
git checkout -b release/private-vX.Y.Z
```

2. 执行基础检查

```bash
khy --version
khy doctor
khy gateway status
```

3. 执行发布前检查

```bash
npm run check:version-sync
npm run check:node-syntax
npm run check:python-syntax
```

4. 提交改动

```bash
git add -- .
git commit -m "release: private vX.Y.Z"
```

5. 配置私有仓库远程（首次）

```bash
git remote add origin-private git@github.com:Program-master-leader/KHY-OS.git
```

如果已存在 `origin-private`，改用：

```bash
git remote set-url origin-private git@github.com:Program-master-leader/KHY-OS.git
```

6. GitHub API（PAT）填写位置（使用 HTTPS 推送时）

如果你不使用 SSH，而是使用 HTTPS 推送，则“GitHub API”指的是 GitHub Personal Access Token（PAT）。

先把远程改为 HTTPS：

```bash
git remote set-url origin-private https://github.com/Program-master-leader/KHY-OS.git
```

然后执行推送命令时，按提示填写：

- `Username for 'https://github.com'`：你的 GitHub 用户名
- `Password for 'https://<username>@github.com'`：粘贴你的 GitHub PAT

`khy publish git-push` 也是走本地 Git 凭据，不单独在 `khy` 命令参数里填写 PAT。

7. 推送到私有仓库

```bash
git push -u origin-private release/private-vX.Y.Z
```

8. 创建私有版本标签并推送

```bash
git tag -a vX.Y.Z-private -m "private release vX.Y.Z"
git push origin-private vX.Y.Z-private
```

9. 可选：使用内置发布命令（等价能力）

```bash
khy publish git-push --platform github --repo Program-master-leader/KHY-OS --remote origin-private --set-upstream
```

10. 仓库权限建议

- 仅维护组成员可读写私有仓库。
- 开启受保护分支（至少保护 `main` 和 `release/*`）。
- 对发布标签开启受限创建权限。

## 11. 相关文档

- `docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md`
- `docs/05_TEST_测试/[TEST-RPT-002] khy-os-测试指南.md`
- `docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md`
