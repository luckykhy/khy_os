<!-- 文档分类: OPS-MAN-014 | 阶段: 运维 | 原路径: docs/指南/khy-os-用户指南-仅cli.md -->
# KHY OS 使用说明（CLI 精简版）

本文档只介绍 `khy` 的安装、CLI 常用功能与基础排障。

适用范围：

- 个人使用
- 对外分发
- 培训/上手说明

不包含内容：

- 网络通道实现细节
- 网络访问限制规避相关内容

合规边界：

- 仅提供产品功能使用说明。
- 不提供任何绕过网络监管、访问受限网络资源或规避审计的操作指引。

## 1. 命令入口

- 主命令：`khy`
- 兼容命令：`khyquant`、`khy-quant`、`khy-os`

建议统一使用 `khy`。

## 2. 安装与升级

### 2.1 新安装

```bash
python -m pip install -U khy-os
khy --version
```

Windows PowerShell：

```powershell
python.exe -m pip install -U khy-os
khy --version
```

### 2.2 升级

```bash
python -m pip install --upgrade khy-os
khy --version
```

### 2.3 可选依赖

```bash
python -m pip install -U "khy-os[data]"
python -m pip install -U "khy-os[ml]"
python -m pip install -U "khy-os[doc]"
python -m pip install -U "khy-os[full]"
```

### 2.4 Docker 部署安装（详细）

适用场景：

- 你希望把 KHY OS 部署为容器服务
- 使用者不需要本地 Python/Node 运行环境，只需 Docker

前置条件：

- Docker Engine 已安装（建议 24+）
- `docker compose` 可用（Compose v2 插件）

先在“导出机器”生成部署包（导出机器可通过 `pip` 安装 `khy-os`）：

```bash
python -m pip install -U khy-os
khy publish pip-dir-bundle --out ./dist/docker-bundles --name khy-os-pip-share
```

说明：

- Linux/macOS 默认导出 `.tar.gz`
- Windows 默认导出 `.zip`

在“部署机器”执行：

1. 解压部署包  
Linux/macOS：

```bash
tar -xzf khy-os-pip-share*.tar.gz
cd khy-os-pip-share*
```

Windows PowerShell：

```powershell
Expand-Archive .\khy-os-pip-share*.zip -DestinationPath .\khy-os-pip-share -Force
cd .\khy-os-pip-share
```

2. 初始化环境文件

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

3. 启动服务

```bash
docker compose up -d --build
```

4. 检查运行状态

```bash
docker compose ps
docker compose logs -f khy-backend
```

5. 健康检查（可选）

```bash
curl http://127.0.0.1:13000/health
```

6. 停止与重启

```bash
docker compose stop
docker compose start
docker compose restart
```

7. 升级流程

- 在导出机器升级并重新导出新版本包
- 在部署机器替换为新包目录后执行：

```bash
docker compose down
docker compose up -d --build
```

数据说明：

- 默认使用 Docker 卷保存数据（例如 `backend_data`）
- `docker compose down` 不会删除卷数据
- 若执行 `docker compose down -v` 会删除卷，请谨慎使用

## 3. 首次启动

第一次执行 `khy` 时会自动完成初始化：

1. 检查并安装 Node.js 依赖
2. 生成或复用 `.env`
3. 初始化数据库与基础数据
4. 注册默认应用

执行命令：

```bash
khy
```

看到 `Setup complete!` 即代表初始化流程完成。

## 4. 常用 CLI 命令

### 4.1 基础检查

```bash
khy --version
khy --help
khy doctor
```

### 4.2 数据库相关

```bash
khy db status
khy db init
khy db seed
```

### 4.3 模型相关

```bash
khy models list
khy models pull qwen2.5:7b
```

### 4.4 进入交互

```bash
khy
```

在交互界面中可以直接输入自然语言问题。

### 4.5 指令文件优先级

如果同一项目里同时存在多种协作指令文件，KHY 的冲突优先级为：

1. `khy.md` / `KHY.md`
2. `CLAUDE.md` / `.claude/CLAUDE.md`
3. `AGENTS.md`

也就是：

1. `khy` 规则最高
2. `claude` 规则次之
3. `agents` 规则最低

## 5. 典型使用流程

### 5.1 新机器上手

1. `python -m pip install -U khy-os`
2. `khy --version`
3. `khy`（完成首次初始化）
4. `khy doctor`
5. `khy db status`

### 5.2 日常使用

1. `khy`
2. 在交互界面提问或执行命令
3. 需要时执行 `khy models list` / `khy db status` 查看状态

## 6. 常见问题

### 6.1 提示 `The system cannot find the path specified.`

通常是某些可选工具未安装或未加入 PATH。

优先检查：

```bash
khy doctor
khy --help
```

如果当前已能正常进入 `khy` 并对话，通常不影响核心使用。

### 6.2 首次启动出现 seed 警告

常见提示：

- `Database seed did not confirm success`
- `Database seed not confirmed; will retry on next startup`

处理方式：

1. 再次运行 `khy` 让系统自动重试
2. 或手动执行：

```bash
khy db seed
khy db status
```

### 6.3 如何确认版本已经升级

```bash
khy --version
python -m pip show khy-os
```

## 7. 关键路径（只读参考）

- 数据目录：`~/.khy/`
- 兼容目录：`~/.khyquant/`
- 运行环境文件：`<backend>/.env`

## 8. Git 发布（公开仓库）

目标：发布“CLI 精简版”文档与可公开代码到公开仓库。

建议分支命名：

- `release/public-vX.Y.Z`

发布步骤：

1. 同步主线并创建公开发布分支

```bash
git fetch --all --prune
git checkout main
git pull
git checkout -b release/public-vX.Y.Z
```

2. 执行基础检查

```bash
khy --version
khy doctor
```

3. 执行公开版合规检查（确认不包含内部/敏感内容）

```bash
rg -n "网络访问限制规避|仅内部|internal only|private only" docs/
```

4. 提交改动

```bash
git add -- .
git commit -m "docs: prepare public release vX.Y.Z"
```

5. 配置公开仓库远程（首次）

```bash
git remote add origin-public git@github.com:Program-master-leader/khy_os.git
```

如果已存在 `origin-public`，改用：

```bash
git remote set-url origin-public git@github.com:Program-master-leader/khy_os.git
```

6. GitHub API（PAT）填写位置（使用 HTTPS 推送时）

如果你不使用 SSH，而是使用 HTTPS 推送，则“GitHub API”指的是 GitHub Personal Access Token（PAT）。

先把远程改为 HTTPS：

```bash
git remote set-url origin-public https://github.com/Program-master-leader/khy_os.git
```

然后执行推送命令时，按提示填写：

- `Username for 'https://github.com'`：你的 GitHub 用户名
- `Password for 'https://<username>@github.com'`：粘贴你的 GitHub PAT

`khy publish git-push` 也是走本地 Git 凭据，不单独在 `khy` 命令参数里填写 PAT。

7. 推送到公开仓库

```bash
git push -u origin-public release/public-vX.Y.Z
```

8. 创建公开版本标签并推送

```bash
git tag -a vX.Y.Z-public -m "public release vX.Y.Z"
git push origin-public vX.Y.Z-public
```

9. 可选：使用内置发布命令（等价能力）

```bash
khy publish git-push --platform github --repo Program-master-leader/khy_os --remote origin-public --set-upstream
```

## 9. 相关文档

- 完整版使用文档：`docs/07_OPS_运维/[OPS-MAN-015] khy-os-用户指南.md`
- Docker 部署与导出指南：`docs/06_DEPLOY_部署/[DEPLOY-MAN-011] pip-docker-打包部署.md`
- 开发文档：`docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md`
- 测试文档：`docs/05_TEST_测试/[TEST-RPT-002] khy-os-测试指南.md`
- 学习文档：`docs/07_OPS_运维/[OPS-MAN-011] khy-os-学习指南.md`
