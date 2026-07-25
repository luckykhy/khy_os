<!-- 文档分类: DEPLOY-MAN-011 | 阶段: 部署 | 原路径: docs/指南/pip-docker-打包部署.md -->
# pip 安装后完整部署与推送指南

适用场景：你已通过 `pip install khy-os`（或 `pip install khy-quant`）安装 KHY，希望：

1. 本机安装后可直接使用  
2. 导出可转发压缩包给别人 Docker 部署  
3. 一键推送到 GitHub / Gitee / GitLab

## 1. pip 安装后直接使用

```bash
khy --version
khy
```

只要本机有 Node.js（>=18），`pip` 安装后即可直接运行，无需先克隆源码仓库。

首次安装后首次启动会自动显示安装位置（Install root / Backend dir）；版本升级后也会再次提示一次，便于定位当前实际运行目录。

## 2. 导出部署包（四种方式）

### 方式 A：标准 Docker 部署包（推荐）

```bash
khy publish docker-bundle
```

可选参数：

```bash
khy publish docker-bundle --out ./dist/docker-bundles
khy publish docker-bundle --name khy-os-docker-share
```

### 方式 B：pip 安装目录 + Docker 部署入口（完整快照）

会打包 `pip` 安装目录里的 `khy_platform`、`khy_os`，并附带 `docker-compose.yml` 可直接部署。

```bash
khy publish pip-dir-bundle
```

可选参数：

```bash
khy publish pip-dir-bundle --out ./dist/docker-bundles
khy publish pip-dir-bundle --name khy-os-pip-share

# 若自动探测不到 site-packages，可手动指定
khy publish pip-dir-bundle --pip-root /path/to/site-packages
```

默认生成目录：

`dist/docker-bundles/`

默认文件名：

- `khy-os-docker-<version>-<timestamp>.tar.gz`（标准 Docker 包）
- `khy-os-pip-install-<version>-<timestamp>.tar.gz`（pip 目录包）

> Windows 下自动生成 `.zip`。

每个导出的压缩包都包含：

- `INSTALL_LAYOUT.md`：可读目录树 + 源码来源映射
- `INSTALL_LAYOUT.json`：机器可读结构映射（便于自动检查）

### 方式 C：还原 origin code 项目结构（用于二次开发/归档）

从 pip 安装目录反向还原接近原仓库的目录结构（`backend/frontend/docs/alpine/scripts/packages/shared/khy_platform`）：

```bash
khy publish origin-code
```

源码完整还原支持密钥门禁：

- 提供正确密钥（`khy2026`）时：导出完整还原包
- 未提供或密钥错误时：自动降级为“扰乱后发布”，核心技术实现会被移除/扰乱，不再是可完整复原源码的包

可选参数：

```bash
khy publish origin-code --out ./dist/origin-code
khy publish origin-code --name khy-os-origin-restore
khy publish origin-code --secret khy2026
khy publish origin-code --pip-root /path/to/site-packages
# npm 安装目录场景可显式指定
khy publish origin-code --install npm --npm-root /path/to/npm-install-root
```

### 方式 D：npm 安装目录 + Docker 部署入口

适用于通过 npm 安装的运行目录（或你指定的 npm backend 目录）：

```bash
khy publish npm-dir-bundle
```

可选参数：

```bash
khy publish npm-dir-bundle --out ./dist/docker-bundles
khy publish npm-dir-bundle --name khy-os-npm-share
khy publish npm-dir-bundle --npm-root /path/to/npm-install-root
```

## 3. 接收方 Docker 部署步骤

```bash
tar -xzf khy-os-*.tar.gz
cd khy-os-*
cp .env.example .env
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f khy-backend
```

默认访问地址：

- API: `http://<host>:13000`
- Health: `http://<host>:13000/health`

## 4. 一键推送到 GitHub/Gitee/GitLab

### 已配置 remote，直接推送

```bash
khy publish git-push
```

源码推送同样受密钥门禁控制：

- 提供正确密钥（`--secret khy2026`）才执行真实推送
- 未提供或密钥错误时，自动切换为扰乱发布模式（仅 dry-run 输出推送计划，不推送真实源码）

### 首次配置并推送（owner/repo 形式）

```bash
# GitHub
khy publish git-push --platform github --repo yourname/khy-os --remote github --set-upstream

# Gitee
khy publish git-push --platform gitee --repo yourname/khy-os --remote gitee --set-upstream

# GitLab
khy publish git-push --platform gitlab --repo yourname/khy-os --remote gitlab --set-upstream
```

### 使用完整仓库 URL（SSH/HTTPS 都支持）

```bash
khy publish git-push git@github.com:yourname/khy-os.git --remote github --set-upstream
```

### 有未提交改动时自动提交再推送

```bash
khy publish git-push --auto-commit --commit-message "chore: sync latest"
```

仅预览命令不执行：

```bash
khy publish git-push --dry-run
```

带密钥执行真实推送：

```bash
khy publish git-push --secret khy2026 --platform github --repo yourname/khy-os
```

## 5. KHY 自修复与自发布

### 5.1 一键自修复（Review -> Fix -> Verify）

```bash
khy publish self-fix --yes
```

可选参数：

```bash
khy publish self-fix --max-rounds 5 --yes
```

### 5.2 一键自发布到 PyPI（先修复再发布）

```bash
khy publish self-pypi --version 0.1.10 --yes
```

发布到 TestPyPI：

```bash
khy publish self-testpypi --version 0.1.10 --yes
```

若只发布不跑修复：

```bash
khy publish self-pypi --skip-fix --yes
```

仅做 self-testpypi 演练（检查 + 构建 + twine 命令预览，不实际上传）：

```bash
khy publish self-testpypi --skip-fix --yes --dry-run
```

## 6. 关键说明

- 默认数据库为 SQLite，数据保存在 Docker 卷 `backend_data`。
- 首次启动会先执行 `node scripts/seed.js` 再启动服务。
- 生产环境务必在 `.env` 中修改 `JWT_SECRET`。
- `git-push` 默认不会自动提交改动；如需自动提交请显式加 `--auto-commit`。
- `self-pypi`/`self-testpypi` 依赖你本机已有 PyPI/TestPyPI 凭据（token 或 `.pypirc`）。
- pip 安装目录与源码映射细节，见：`docs/07_OPS_运维/[OPS-MAN-022] pip-安装布局参考.md`。
- `origin-code` 还原包用于结构回放与二次开发，不包含 `.git/` 和被打包流程裁剪的产物。
- `origin-code` 在未通过密钥校验时会自动导出“扰乱后发布”包：目录骨架保留，但核心技术实现会被移除/改写。
- `pip-dir-bundle`/`origin-code` 默认 `auto` 探测安装布局；可用 `--install pip|npm` 强制指定。
- `auto` 探测在 pip 与 npm 同时存在时会进行冲突仲裁：优先更高版本；版本相同再选最近更新的一侧，避免两套安装互相覆盖冲突。
